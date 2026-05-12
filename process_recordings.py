#!/usr/bin/env python3
"""
process_recordings.py — convert Pi WAV recordings to web-ready MP3s.

Pipeline per file:
  silenceremove (strip leading silence + gaps >5s)
  → acompressor
  → loudnorm (EBU R128, -16 LUFS)
  → libmp3lame VBR ~190 kbps

Usage:
  python3 process_recordings.py [OPTIONS] OUTPUT_DIR

  --src-pi          rsync from kypy3@192.168.178.58:/data/record/ first
  --src-dir DIR     read WAVs from DIR (default: OUTPUT_DIR)
  --jobs N          parallel workers (default: 4)
  --dry-run         show what would run, don't execute
  --list-empty      only detect silent/empty files, write silent_files.txt, exit
"""

import argparse
import concurrent.futures
import os
import re
import subprocess
import sys
from pathlib import Path

PI_HOST  = 'kypy3@192.168.178.58'
PI_SRC   = '/data/record/'
SILENCE_THRESHOLD_DB = -30.0

SILENCE_PREFIX = (
    'silenceremove='
    'start_periods=1:start_duration=0.5:start_threshold=-50dB'
    ':stop_periods=-1:stop_duration=2:stop_threshold=-50dB,'
)

# Per-genre EQ + compression chains (appended after silence removal, before loudnorm)
GENRE_CHAINS = {
    'electronic': (
        'highpass=f=30,'
        'equalizer=f=80:width_type=o:width=2:g=2,'       # kick/bass punch
        'equalizer=f=10000:width_type=o:width=2:g=2,'    # air / shimmer
        'acompressor=threshold=0.089:ratio=4:attack=2:release=150:makeup=2.5,'
    ),
    'acoustic': (
        'highpass=f=80,'
        'equalizer=f=3000:width_type=o:width=2:g=1.5,'   # vocal presence
        'equalizer=f=10000:width_type=o:width=2:g=2,'    # air
        'acompressor=threshold=0.089:ratio=4:attack=5:release=200:makeup=2.5,'
    ),
    'podcast': (
        'highpass=f=100,'
        'equalizer=f=250:width_type=o:width=2:g=-2,'     # reduce muddiness
        'equalizer=f=3000:width_type=o:width=2:g=2,'     # voice clarity
        'acompressor=threshold=0.05:ratio=6:attack=3:release=100:makeup=3,'
    ),
}
LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'

DEFAULT_GENRE = 'electronic'


def rsync_from_pi(dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    cmd = ['rsync', '-av', '--ignore-existing',
           f'{PI_HOST}:{PI_SRC}', str(dest) + '/']
    print(f'[rsync] {PI_HOST}:{PI_SRC} → {dest}/')
    subprocess.run(cmd, check=True)


def max_volume_db(wav: Path) -> float:
    """Return the max_volume value from ffmpeg volumedetect (negative dB)."""
    result = subprocess.run(
        ['ffmpeg', '-i', str(wav), '-af', 'volumedetect',
         '-f', 'null', '-'],
        capture_output=True, text=True
    )
    output = result.stderr
    m = re.search(r'max_volume:\s*([-\d.]+)\s*dB', output)
    if not m:
        return -999.0
    return float(m.group(1))


def detect_silent(wav: Path) -> tuple[Path, float]:
    db = max_volume_db(wav)
    return wav, db


def format_size(b: int) -> str:
    if b >= 1_073_741_824:
        return f'{b / 1_073_741_824:.1f} GB'
    if b >= 1_048_576:
        return f'{b / 1_048_576:.1f} MB'
    if b >= 1024:
        return f'{b / 1024:.1f} KB'
    return f'{b} B'


def build_filtergraph(genre: str) -> str:
    chain = GENRE_CHAINS.get(genre, GENRE_CHAINS[DEFAULT_GENRE])
    return SILENCE_PREFIX + chain + LOUDNORM


def process_file(wav: Path, out_dir: Path, dry_run: bool, genre: str) -> str:
    out_path = out_dir / (wav.stem + '.mp3')
    in_size  = wav.stat().st_size

    if out_path.exists():
        return f'[skip]  {wav.name} (already processed)'

    cmd = [
        'ffmpeg', '-y', '-i', str(wav),
        '-af', build_filtergraph(genre),
        '-codec:a', 'libmp3lame', '-q:a', '2',
        str(out_path)
    ]

    if dry_run:
        return f'[dry]   {wav.name} → {out_path.name}'

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return f'[ERROR] {wav.name}\n{result.stderr[-400:]}'

    out_size = out_path.stat().st_size
    ratio    = in_size / out_size if out_size else 0
    return (f'[done]  {wav.name} → {out_path.name}  '
            f'{format_size(in_size)} → {format_size(out_size)}  '
            f'({ratio:.1f}x smaller)')


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('output_dir', metavar='OUTPUT_DIR')
    p.add_argument('--src-pi',  action='store_true',
                   help='rsync from Pi before processing')
    p.add_argument('--src-dir', metavar='DIR',
                   help='read WAVs from this local directory')
    p.add_argument('--jobs',    type=int, default=4, metavar='N',
                   help='parallel ffmpeg workers (default: 4)')
    p.add_argument('--move-silent', metavar='DIR',
                   help='move silent WAV files to this directory instead of listing them')
    p.add_argument('--genre', choices=list(GENRE_CHAINS), default=DEFAULT_GENRE,
                   help=f'mastering preset (default: {DEFAULT_GENRE})')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--list-empty', action='store_true',
                   help='detect silent files only, write silent_files.txt, exit')
    args = p.parse_args()

    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.src_pi:
        rsync_from_pi(out_dir)

    src_dir = Path(args.src_dir).resolve() if args.src_dir else out_dir
    wavs    = sorted(src_dir.glob('*.wav')) + sorted(src_dir.glob('*.WAV'))

    if not wavs:
        print(f'No WAV files found in {src_dir}')
        sys.exit(0)

    print(f'Found {len(wavs)} WAV file(s) in {src_dir}')

    # Silent file detection
    silent_txt = out_dir / 'silent_files.txt'
    silent_wavs: list[Path] = []
    active_wavs: list[Path] = []

    print('Checking volume levels…')
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futures = {ex.submit(detect_silent, w): w for w in wavs}
        for fut in concurrent.futures.as_completed(futures):
            wav, db = fut.result()
            if db < SILENCE_THRESHOLD_DB:
                silent_wavs.append(wav)
                print(f'  [silent] {wav.name}  max_volume={db:.1f} dB')
            else:
                active_wavs.append(wav)
                print(f'  [audio]  {wav.name}  max_volume={db:.1f} dB')

    if silent_wavs:
        if args.move_silent:
            move_dir = Path(args.move_silent).resolve()
            move_dir.mkdir(parents=True, exist_ok=True)
            for wav in sorted(silent_wavs):
                dest = move_dir / wav.name
                wav.rename(dest)
                print(f'  [moved]  {wav.name} → {move_dir}/')
            print(f'\n{len(silent_wavs)} silent file(s) moved to {move_dir}/')
        else:
            with open(silent_txt, 'w') as f:
                f.write('\n'.join(str(w) for w in sorted(silent_wavs)) + '\n')
            print(f'\n{len(silent_wavs)} silent file(s) listed in {silent_txt}')

    if args.list_empty:
        print(f'{len(active_wavs)} file(s) have audio content.')
        sys.exit(0)

    if not active_wavs:
        print('No files with audio content to process.')
        sys.exit(0)

    print(f'\nProcessing {len(active_wavs)} file(s) with {args.jobs} worker(s) [{args.genre} preset]…\n')
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futures = {ex.submit(process_file, w, out_dir, args.dry_run, args.genre): w
                   for w in active_wavs}
        for fut in concurrent.futures.as_completed(futures):
            print(fut.result())

    print('\nDone.')


if __name__ == '__main__':
    main()
