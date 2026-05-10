# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Target hardware

Raspberry Pi 3 running Raspberry Pi OS Bookworm (arm64), HiFiBerry DAC+ ADC (`/etc/modules-load.d`: `dtoverlay=hifiberry-dacplusadc`). ALSA device is always `hw:1,0`.

## Key architecture

Two processes run as `systemctl --user` services, communicating via files in `/tmp/`:

```
gpio-recorder.py  ←─ SIGUSR1 ─── server.js
       │                               │
       └─ writes ──► /tmp/recorder_status.json ◄─ reads ─┘
       └─ writes ──► /tmp/recorder.pid
```

- **`gpio-recorder.py`** — Python asyncio loop. Watches BOARD pin 23 (button) via `python3-rpi-lgpio`, blinks pin 11 (LED), spawns `arecord` for recording. Writes PID to `/tmp/recorder.pid` so `server.js` can send `SIGUSR1` to toggle recording from the web UI. Writes recording state to `/tmp/recorder_status.json`.
- **`webui/server.js`** — Express server on port 8080. Reads status file and PID file. Spawns `ffmpeg` for RTMP streaming to `rtmp://kyo.sk:45860/live/stream`. Proxies `kyo.sk` API calls over HTTPS for the "Go Live" feature.
- **`webui/app/`** — Pure vanilla JS/CSS frontend. No build step. WaveSurfer.js v6 loaded from CDN. `recorder.js` + `recorder.css` are the live files; the `src/` subdirectory contains the old Choo/Browserify source (obsolete, not used by the current UI).

## Manage on the Pi

```bash
# Deploy (from dev machine)
rsync -av gpio-recorder.py webui/server.js kypy3@192.168.178.58:~/pi-recorder/
rsync -av webui/app/index.html webui/app/recorder.css webui/app/recorder.js kypy3@192.168.178.58:~/pi-recorder/webui/app/
ssh kypy3@192.168.178.58 "chmod +x ~/pi-recorder/gpio-recorder.py && systemctl --user restart pirecorder-record pirecorder-webui"

# On the Pi — restart / status / logs
systemctl --user restart pirecorder-record pirecorder-webui
systemctl --user status pirecorder-record pirecorder-webui
journalctl --user -f -u pirecorder-record
journalctl --user -f -u pirecorder-webui

# Test web-triggered record toggle
kill -USR1 $(cat /tmp/recorder.pid)
cat /tmp/recorder_status.json
```

## Critical package note

**Do not use `RPi.GPIO`** — it is broken on Bookworm kernel 6.6+. The replacement is `python3-rpi-lgpio` (apt package, drop-in compatible, no code changes needed). Remove `python3-rpi.gpio` if present:

```bash
sudo apt remove python3-rpi.gpio
sudo apt install python3-rpi-lgpio
```

## kyo.sk integration

The "Go Live on kyo.sk" button works without any browser login. The server reads `~/.kyo_pass` on startup, authenticates with `kyo.sk/kyosky/api/radio/auth`, and keeps the token in memory. To enable:

```bash
echo "broadcaster_password" > ~/.kyo_pass && chmod 600 ~/.kyo_pass
systemctl --user restart pirecorder-webui
```

Token automatically refreshes on 401. If no `~/.kyo_pass` exists, the button is hidden.

## RTMP stream DSP chain

The ffmpeg stream uses the same audio processing as the Android app:

```
volume=8, acompressor=threshold=0.25:ratio=4:attack=5:release=200:makeup=2.5
```

Output: 128k MP3 → `rtmp://kyo.sk:45860/live/stream`.

## recorder.local hostname

mDNS via `avahi-daemon` may not traverse home routers. Reliable fix on the client:

```
echo "192.168.178.xx recorder.local" | sudo tee -a /etc/hosts
```
