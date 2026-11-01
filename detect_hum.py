#!/usr/bin/env python3
"""
detect_hum.py — locate mains-hum (50 Hz) affected regions in a WAV/audio file.

Strategy (ffmpeg only, no numpy/scipy needed):
  The signal is split in two. One branch is band-passed tightly around the
  mains frequency (default 50 Hz) to isolate the hum; the other branch keeps
  the full signal. Both branches are chopped into fixed windows (default 1 s)
  and their per-window RMS level is measured with `astats`. For each window we
  then have:

      hum_db   = RMS level of the 50 Hz band
      full_db  = RMS level of the full signal
      rel_db   = hum_db - full_db   (how much the window is dominated by hum)

  A window is flagged as "hum" when the hum band is both loud enough in
  absolute terms (--hum-floor) and prominent relative to everything else
  (--rel-thresh). Consecutive flagged windows are merged into ranges.

Usage:
  python3 detect_hum.py FILE [--freq 50] [--window 1.0]
                             [--hum-floor -45] [--rel-thresh -12]
                             [--csv out.csv]
"""

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def hms(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f'{h:d}:{m:02d}:{s:06.3f}'


def parse_ametadata(path: Path) -> dict[float, float]:
    """Parse an ffmpeg ametadata dump into {pts_time: rms_level_db}."""
    out: dict[float, float] = {}
    pts = None
    with open(path) as f:
        for line in f:
            line = line.strip()
            m = re.match(r'frame:\d+\s+pts:\d+\s+pts_time:([\d.]+)', line)
            if m:
                pts = float(m.group(1))
                continue
            m = re.match(r'lavfi\.astats\.Overall\.RMS_level=([-\d.inf]+)', line)
            if m and pts is not None:
                val = m.group(1)
                out[pts] = float('-inf') if 'inf' in val else float(val)
    return out


def run_ffmpeg(src: Path, freq: float, window: float,
               hum_txt: Path, full_txt: Path) -> None:
    nsamp = max(1, int(round(window * 44100)))  # window expressed in samples
    # bandwidth ~ a few Hz around the mains line (covers small drift)
    graph = (
        f'asetnsamples=n={nsamp}:p=0,'
        f'asplit=2[a][b];'
        f'[a]bandpass=f={freq}:width_type=h:width=4,'
        f'astats=metadata=1:reset=1,'
        f'ametadata=print:key=lavfi.astats.Overall.RMS_level:file={hum_txt}[a1];'
        f'[b]astats=metadata=1:reset=1,'
        f'ametadata=print:key=lavfi.astats.Overall.RMS_level:file={full_txt}[b1];'
        f'[a1][b1]amix'
    )
    cmd = ['ffmpeg', '-hide_banner', '-nostats', '-i', str(src),
           '-filter_complex', graph, '-f', 'null', '-']
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f'ffmpeg failed:\n{proc.stderr[-800:]}')


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('file')
    p.add_argument('--freq', type=float, default=50.0, help='mains frequency (default 50)')
    p.add_argument('--window', type=float, default=1.0, help='analysis window seconds (default 1.0)')
    p.add_argument('--hum-floor', type=float, default=-45.0,
                   help='min hum-band RMS dB to consider (default -45)')
    p.add_argument('--rel-thresh', type=float, default=-12.0,
                   help='hum_db - full_db must exceed this dB (default -12)')
    p.add_argument('--min-len', type=float, default=1.0,
                   help='ignore flagged ranges shorter than this (s)')
    p.add_argument('--gap', type=float, default=3.0,
                   help='merge flagged ranges separated by gaps <= this (s)')
    p.add_argument('--csv', help='write per-window values to this CSV')
    p.add_argument('--from-csv', help='skip ffmpeg, re-summarize an existing CSV')
    p.add_argument('--stats-only', action='store_true',
                   help='just print level distribution, do not flag ranges')
    args = p.parse_args()

    rows = []
    if args.from_csv:
        with open(args.from_csv) as cf:
            next(cf)  # header
            for line in cf:
                t, h, f, rel, _ = line.strip().split(',')
                h, f, rel = (float(x) if x not in ('-inf', 'inf') else float(x)
                             for x in (h, f, rel))
                flagged = (h >= args.hum_floor) and (rel >= args.rel_thresh)
                rows.append((float(t), h, f, rel, flagged))
        times = [r[0] for r in rows]
    else:
        src = Path(args.file).resolve()
        if not src.exists():
            sys.exit(f'no such file: {src}')
        with tempfile.TemporaryDirectory() as td:
            hum_txt = Path(td) / 'hum.txt'
            full_txt = Path(td) / 'full.txt'
            print(f'Analysing {src.name} (this reads the whole file once)…',
                  file=sys.stderr)
            run_ffmpeg(src, args.freq, args.window, hum_txt, full_txt)
            hum = parse_ametadata(hum_txt)
            full = parse_ametadata(full_txt)
        times = sorted(set(hum) & set(full))
        if not times:
            sys.exit('no analysis windows produced — check the input file')
        for t in times:
            h = hum[t]
            f = full[t]
            rel = (h - f) if (h != float('-inf') and f != float('-inf')) else float('-inf')
            flagged = (h >= args.hum_floor) and (rel >= args.rel_thresh)
            rows.append((t, h, f, rel, flagged))

    if args.csv:
        with open(args.csv, 'w') as cf:
            cf.write('time_s,hum_db,full_db,rel_db,flagged\n')
            for t, h, f, rel, fl in rows:
                cf.write(f'{t:.3f},{h:.2f},{f:.2f},{rel:.2f},{int(fl)}\n')
        print(f'Wrote per-window CSV → {args.csv}', file=sys.stderr)

    # distribution summary
    hvals = sorted(h for _, h, _, _, _ in rows if h != float('-inf'))
    def pct(p):
        if not hvals:
            return float('nan')
        return hvals[min(len(hvals) - 1, int(p / 100 * len(hvals)))]
    print(f'\nHum-band RMS distribution (dB) over {len(rows)} windows:')
    print(f'  min {hvals[0]:.1f}   p25 {pct(25):.1f}   median {pct(50):.1f}'
          f'   p75 {pct(75):.1f}   p95 {pct(95):.1f}   max {hvals[-1]:.1f}')

    if args.stats_only:
        return

    # merge consecutive flagged windows into ranges
    ranges = []
    cur = None
    for t, h, f, rel, fl in rows:
        if fl:
            if cur is None:
                cur = [t, t, h]
            else:
                cur[1] = t
                cur[2] = max(cur[2], h)
        else:
            if cur is not None:
                ranges.append(cur)
                cur = None
    if cur is not None:
        ranges.append(cur)

    win = args.window

    # bridge ranges separated by a short gap (sustained hum that dipped briefly)
    if args.gap > 0 and ranges:
        merged = [ranges[0]]
        for start, last, peak in ranges[1:]:
            pstart, plast, ppeak = merged[-1]
            if start - (plast + win) <= args.gap:
                merged[-1] = [pstart, last, max(ppeak, peak)]
            else:
                merged.append([start, last, peak])
        ranges = merged

    ranges = [r for r in ranges if (r[1] + win - r[0]) >= args.min_len]

    print(f'\nFlagged {len(ranges)} hum region(s) '
          f'(hum-floor {args.hum_floor} dB, rel-thresh {args.rel_thresh} dB):\n')
    total = 0.0
    for start, last, peak in ranges:
        end = last + win
        dur = end - start
        total += dur
        print(f'  {hms(start)} → {hms(end)}   ({dur:6.1f}s)   peak hum {peak:.1f} dB')
    if ranges:
        print(f'\n  total hum-affected: {hms(total)}  '
              f'({100*total/(times[-1]+win):.1f}% of file)')
    else:
        print('  (no regions exceeded the thresholds — try lowering --rel-thresh '
              'or --hum-floor, or run with --stats-only first)')


if __name__ == '__main__':
    main()
