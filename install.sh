#!/bin/bash
# install.sh — full setup for pi-recorder on Raspberry Pi OS Bookworm
set -e

REPO_DIR="$( cd "$(dirname "$0")" ; pwd -P )"
RECORD_DIR="/data/record"
USER="$(whoami)"

echo "=== pi-recorder installer ==="
echo "Repo: $REPO_DIR"
echo "User: $USER"
echo ""

# ── System packages ───────────────────────────────────────────────────────────
echo "--- Installing system packages (requires sudo) ---"
sudo apt-get update -qq
sudo apt-get install -y \
    python3-rpi-lgpio \
    alsa-utils \
    avahi-daemon \
    ffmpeg \
    nodejs \
    npm

# Remove the old RPi.GPIO package — it conflicts with rpi-lgpio on Bookworm
if dpkg -l python3-rpi.gpio &>/dev/null 2>&1; then
    echo "--- Removing incompatible python3-rpi.gpio ---"
    sudo apt-get remove -y python3-rpi.gpio
fi

# ── Recording directory ───────────────────────────────────────────────────────
echo "--- Creating recording directory $RECORD_DIR ---"
sudo mkdir -p "$RECORD_DIR"
sudo chown -R "$USER:$USER" "$RECORD_DIR"

# ── HiFiBerry DAC+ ADC overlay ────────────────────────────────────────────────
BOOTCONF="/boot/firmware/config.txt"
if [ ! -f "$BOOTCONF" ]; then
    BOOTCONF="/boot/config.txt"   # older Pi OS path
fi

if ! grep -q "hifiberry-dacplusadc" "$BOOTCONF" 2>/dev/null; then
    echo "--- Adding HiFiBerry DAC+ ADC overlay to $BOOTCONF ---"
    echo "dtoverlay=hifiberry-dacplusadc" | sudo tee -a "$BOOTCONF"
    echo "    (reboot required for overlay to take effect)"
else
    echo "--- HiFiBerry overlay already present in $BOOTCONF ---"
fi

# ── Node.js dependencies ──────────────────────────────────────────────────────
echo "--- Installing Node.js dependencies ---"
cd "$REPO_DIR/webui"
npm install
cd "$REPO_DIR"

# ── Permissions ───────────────────────────────────────────────────────────────
chmod +x "$REPO_DIR/gpio-recorder.py"

# ── Systemd user services ─────────────────────────────────────────────────────
echo "--- Installing systemd user services ---"
SVCDIR="$HOME/.config/systemd/user"
mkdir -p "$SVCDIR"

# Generate service files pointing at actual repo location (not hardcoded ~/pi-recorder)
cat > "$SVCDIR/pirecorder-record.service" <<EOF
[Unit]
Description=pi-recorder: gpio-recorder.py

[Service]
ExecStart=$REPO_DIR/gpio-recorder.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat > "$SVCDIR/pirecorder-webui.service" <<EOF
[Unit]
Description=pi-recorder: webui

[Service]
ExecStart=/usr/bin/node $REPO_DIR/webui/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable pirecorder-record pirecorder-webui

# ── User linger (auto-start at boot without login) ────────────────────────────
echo "--- Enabling user linger for $USER ---"
loginctl enable-linger "$USER"

# ── Start services ────────────────────────────────────────────────────────────
echo "--- Starting services ---"
systemctl --user restart pirecorder-record pirecorder-webui
sleep 2
systemctl --user status pirecorder-record pirecorder-webui --no-pager

# ── Done ──────────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
HOST=$(hostname)
echo ""
echo "=== Installation complete ==="
echo ""
echo "Web UI:  http://$IP:8080"
echo "         http://$HOST.local:8080  (if mDNS works on your network)"
echo ""
echo "If recorder.local does not resolve, add to /etc/hosts on your client:"
echo "  echo \"$IP $HOST.local\" | sudo tee -a /etc/hosts"
echo ""
echo "Optional — enable kyo.sk 'Go Live' integration:"
echo "  echo 'your_kyo_broadcaster_password' > ~/.kyo_pass"
echo "  chmod 600 ~/.kyo_pass"
echo "  systemctl --user restart pirecorder-webui"
echo ""
if grep -q "hifiberry-dacplusadc" "$BOOTCONF" 2>/dev/null; then
    if ! aplay -l 2>/dev/null | grep -q -i "hifiberry\|dacplusadc"; then
        echo "NOTE: HiFiBerry overlay added — reboot to activate audio hardware."
        echo "  sudo reboot"
    fi
fi
