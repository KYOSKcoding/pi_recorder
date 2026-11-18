# pi-recorder

A field recorder running on a Raspberry Pi with a HiFiBerry DAC+ ADC. One button starts/stops recording; a local web UI lets you record, listen back, stream live to kyo.sk, and control whether kyo.sk web listeners hear the live stream.

## Hardware

- Raspberry Pi 3 (or later)
- HiFiBerry DAC+ ADC (audio in/out via ALSA device `hw:1,0`)
- Momentary button on BOARD pin 23
- LED on BOARD pin 11
- External storage or SD card mounted at `/data/record`

## Quick install

```bash
git clone <your-fork-url> $HOME/pi-recorder
cd $HOME/pi-recorder
bash install.sh
```

The installer handles everything: system packages, recording directory, HiFiBerry overlay, Node dependencies, systemd services, and user linger for boot autostart.

After install, open **`http://<pi-ip>:8080`** in a browser on your local network.

> **recorder.local** may not resolve through home routers (mDNS multicast is often blocked). Reliable fix on the client machine:
> ```
> echo "192.168.x.x recorder.local" | sudo tee -a /etc/hosts
> ```

## Features

| Feature | How |
|---|---|
| **Record** | Push physical button, or click **⬤ START REC** in the web UI |
| **Listen back** | Click any recording in the list — waveform player with prev/next, volume |
| **Go live on kyo.sk** | Click **● GO LIVE** — streams to kyo.sk over RTMPS with the stream key; kyo.sk switches its listeners at kyo.sk/radio to live by itself (and back when you stop) |
| **Delete recordings** | DEL button next to each file |
| **Download** | ↓ button next to each file |

## kyo.sk

**● GO LIVE** streams to `rtmps://kyo.sk:45860/live/<stream key>`. kyo.sk only accepts streams with
the secret stream key. As soon as the stream arrives, it switches the listeners at kyo.sk/radio to
live, and back when you stop. The key lives only on the Pi, never in git. Whoever runs the kyo.sk
server has it (`STREAM_KEY` in `~/.config/kyo-radio/secrets.env` there). Set it up once on the Pi:

```bash
read -rsp 'Stream key: ' k && printf '%s\n' "$k" > ~/.kyo_stream_key && chmod 600 ~/.kyo_stream_key; unset k
```

No restart is needed: the key is read each time you press GO LIVE. Without a key file the UI shows
"No stream key …" instead of streaming. ffmpeg checks kyo.sk's TLS certificate against
`/etc/ssl/certs/ca-certificates.crt`, so nobody on the venue network can catch the key. If the key
is ever changed on the server, write the new one into `~/.kyo_stream_key`.

## Configuration

| Setting | Default | How to change |
|---|---|---|
| Recording path | `/data/record` | `RECORD_PATH=/your/path node webui/server.js` |
| Web UI port | `8080` | edit `config.port` in `webui/server.js` |
| ALSA device | `hw:1,0` | edit `gpio-recorder.py` and `webui/server.js` |
| kyo.sk stream key | — | `~/.kyo_stream_key` (see above) |

## How it works

Two systemd user services run continuously:

**`gpio-recorder.py`** — Python asyncio loop that:
- Watches the button (BOARD pin 23) via `python3-rpi-lgpio`
- Spawns `arecord` to capture from `hw:1,0` into timestamped WAV files
- Blinks the LED (pin 11) while recording
- Writes recording state to `/tmp/recorder_status.json`
- Writes its PID to `/tmp/recorder.pid` so the web server can send `SIGUSR1` to toggle recording

**`webui/server.js`** — Express server on port 8080 that:
- Serves the frontend (pure vanilla JS, no build step)
- Polls `/tmp/recorder_status.json` for the status bar
- Sends `SIGUSR1` to the recorder process for web-triggered record toggle
- Spawns `ffmpeg` for the RTMPS live stream to kyo.sk (with audio compression), plus a lossless WAV copy

The frontend uses [WaveSurfer.js](https://wavesurfer.xyz/) (loaded from CDN) for waveform playback.

## Manage services

```bash
# Status
systemctl --user status pirecorder-record pirecorder-webui

# Restart after updating files
systemctl --user restart pirecorder-record pirecorder-webui

# Logs
journalctl --user -f -u pirecorder-record
journalctl --user -f -u pirecorder-webui
```

## Important: GPIO library on Bookworm

The original `RPi.GPIO` package is broken on Raspberry Pi OS Bookworm (kernel 6.6+). The installer removes it and installs `python3-rpi-lgpio` instead, which is a drop-in replacement requiring no code changes.

```bash
sudo apt remove python3-rpi.gpio
sudo apt install python3-rpi-lgpio
```

## Original project

Forked from [interym/pi-recorder](https://github.com/interym/pi-recorder). The original used a Choo/Browserify frontend (`webui/app/src/`) — that source is preserved in the repo but the UI has been replaced with a vanilla JS/CSS implementation that requires no build step.
