#!/usr/bin/python3
"""meter.py — live input level meter for physical debugging.

Reads the shared "kyocap" dsnoop device, so it runs safely alongside a local
recording or a live stream. Prints peak dBFS per channel plus a bar, updating
in place. Ctrl-C to quit.

  ./meter.py            # 44.1 kHz stereo off kyocap
  ./meter.py hw:1,0     # bypass dsnoop, straight off the card

Reference points: silence/no-signal sits near -78 dBFS (the PCM2902's own noise
floor). Anything above about -60 means real signal is arriving.
"""

import subprocess
import struct
import sys
import math

DEV   = sys.argv[1] if len(sys.argv) > 1 else 'kyocap'
RATE  = 44100
CHUNK = int(RATE * 0.15)          # ~150 ms refresh
WIDTH = 44                        # bar width in chars
FLOOR = -90.0                     # bottom of the scale

cmd = ['arecord', '-D', DEV, '-f', 'S16_LE', '-c', '2', '-r', str(RATE),
       '-t', 'raw', '--quiet']
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)

def db(peak):
    return FLOOR if peak <= 0 else max(FLOOR, 20 * math.log10(peak / 32768.0))

def bar(d):
    filled = int(WIDTH * (d - FLOOR) / (0.0 - FLOOR))
    filled = max(0, min(WIDTH, filled))
    return '#' * filled + '-' * (WIDTH - filled)

print(f'meter on {DEV} — Ctrl-C to quit')
print(f'(no signal sits near -78 dBFS; above -60 means real audio)\n')

peak_hold = FLOOR
try:
    while True:
        raw = proc.stdout.read(CHUNK * 4)          # 2 ch * 2 bytes
        if not raw or len(raw) < 4:
            break
        s = struct.unpack('<%dh' % (len(raw) // 2), raw)
        pl = max(abs(v) for v in s[0::2])
        pr = max(abs(v) for v in s[1::2])
        dl, dr = db(pl), db(pr)
        peak_hold = max(peak_hold, dl, dr)
        sys.stdout.write(
            f'\rL {dl:6.1f}  R {dr:6.1f} dBFS  |{bar(max(dl, dr))}|  peak {peak_hold:6.1f}  ')
        sys.stdout.flush()
except KeyboardInterrupt:
    print('\n')
finally:
    proc.kill()
