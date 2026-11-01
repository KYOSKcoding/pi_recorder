#!/usr/bin/python3

import RPi.GPIO as GPIO
import subprocess
import json
import signal
import os
import time
from datetime import datetime
from os import path
import asyncio

record_path = "/data/record"
status_file = "/tmp/recorder_status.json"
pid_file    = "/tmp/recorder.pid"

STATE_STANDBY = 'standby'
STATE_RECORD  = 'record'
# Capture died on its own (USB dropout etc.) and we are trying to get it back.
STATE_ERROR   = 'error'

# Watchdog: arecord can die mid-session if the USB codec falls off the bus
# ("read error: No such device"). Without this the LED keeps blinking and the
# status file keeps claiming `recording: true` while nothing is written.
RETRY_DELAY   = 2.0   # seconds to wait before re-spawning arecord
MAX_RETRIES   = 30    # ~1 min of trying before giving up
SETTLE_SECS   = 5.0   # arecord must survive this long to count as recovered

state    = None
p        = None
retries  = 0
retry_at = 0.0
spawn_at = 0.0
cur_file = None
cur_time = None
# Faults survive a successful retry, so a dropout that recovered is still
# visible afterwards — otherwise the recovery overwrites its own evidence.
faults     = 0
last_fault = None

def write_status(recording, filename=None, started=None, error=None):
    try:
        with open(status_file, 'w') as f:
            json.dump({'recording': recording, 'filename': filename,
                       'started': started, 'error': error,
                       'faults': faults, 'lastFault': last_fault}, f)
    except Exception as e:
        print("Status write failed: " + str(e))

def state_toggle():
    global state, faults, last_fault
    print("state toggle (was " + str(state) + ")")
    if state == STATE_STANDBY:
        state = STATE_RECORD
        faults, last_fault = 0, None   # fresh session, fresh fault history
        record_start()
    else:
        # From RECORD or ERROR: stop, and abandon any pending retry.
        state = STATE_STANDBY
        record_stop()
    print("state toggle (now " + str(state) + ")")

def button_callback(channel):
    print("button pressed")
    state_toggle()

def record_start():
    global p, cur_file, cur_time, spawn_at
    now = datetime.now()
    filename = now.strftime("%Y-%m-%d_%H-%M-%S") + ".wav"
    filepath = path.join(record_path, filename)
    # "kyocap" = shared dsnoop device (see ~/.asoundrc) so the web monitor /
    # level meter can run alongside a local recording.
    command  = ["arecord", "-D", "kyocap", "-f", "S16_LE", "-c", "2", "-r", "44100", filepath]
    print("start record: " + filepath)
    try:
        p = subprocess.Popen(command)
    except Exception as e:
        p = None
        print("arecord spawn failed: " + str(e))
        return False
    spawn_at = time.monotonic()
    cur_file = filename
    cur_time = now.isoformat()
    write_status(True, filename, cur_time)
    return True

def record_stop():
    global p, retries, cur_file, cur_time
    print("stop record")
    if p:
        p.kill()
        try:
            p.wait(timeout=2)   # reap, don't leave a zombie
        except Exception:
            pass
    p = None
    retries  = 0
    cur_file = None
    cur_time = None
    write_status(False)

def record_died(code):
    """arecord exited on its own — treat as a fault and schedule a retry."""
    global p, state, retries, retry_at, faults, last_fault
    p = None
    msg = "capture died (arecord exit " + str(code) + ")"
    print("WATCHDOG: " + msg + " on " + str(cur_file))
    faults    += 1
    last_fault = datetime.now().isoformat() + " " + msg + " on " + str(cur_file)
    state      = STATE_ERROR
    retry_at   = time.monotonic() + RETRY_DELAY
    write_status(False, cur_file, cur_time, msg)

def record_retry():
    """Try to re-spawn arecord into a fresh file after a capture fault."""
    global state, retries, retry_at
    retries += 1
    if retries > MAX_RETRIES:
        print("WATCHDOG: giving up after " + str(MAX_RETRIES) + " retries")
        state = STATE_STANDBY
        write_status(False, cur_file, cur_time,
                     "capture lost — gave up after " + str(MAX_RETRIES) + " retries")
        return
    print("WATCHDOG: retry " + str(retries) + "/" + str(MAX_RETRIES))
    if record_start():
        # Back to RECORD, but `retries` stays until arecord survives
        # SETTLE_SECS — otherwise a spawn-and-die loop would reset it forever.
        state = STATE_RECORD
    else:
        retry_at = time.monotonic() + RETRY_DELAY

def cleanup_pid():
    try:
        os.remove(pid_file)
    except Exception:
        pass

def setup():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    GPIO.cleanup()
    GPIO.setmode(GPIO.BOARD)
    GPIO.setup(23, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)
    GPIO.setup(11, GPIO.OUT)
    GPIO.add_event_detect(23, GPIO.RISING, callback=button_callback, bouncetime=500)

    # Write PID so server.js can send SIGUSR1 for web-triggered toggles
    with open(pid_file, 'w') as f:
        f.write(str(os.getpid()))

    # SIGUSR1 → web-triggered record toggle (runs safely inside event loop)
    loop.add_signal_handler(signal.SIGUSR1, state_toggle)

    state_toggle()  # enter STANDBY
    try:
        loop.run_until_complete(async_runner())
    finally:
        cleanup_pid()

async def async_runner():
    # 0.1 s tick so the error pattern can blink faster than the record pattern.
    global retries
    tick = 0
    while True:
        # --- watchdog ---------------------------------------------------
        if state == STATE_RECORD and p is not None:
            code = p.poll()
            if code is not None:
                record_died(code)
            elif retries and time.monotonic() - spawn_at > SETTLE_SECS:
                print("WATCHDOG: capture recovered")
                retries = 0
        elif state == STATE_ERROR and time.monotonic() >= retry_at:
            record_retry()

        # --- LED --------------------------------------------------------
        if state == STATE_RECORD:
            GPIO.output(11, GPIO.HIGH if (tick // 5) % 2 else GPIO.LOW)   # 0.5 s blink
        elif state == STATE_ERROR:
            GPIO.output(11, GPIO.HIGH if tick % 2 else GPIO.LOW)          # 0.1 s panic blink
        else:
            GPIO.output(11, GPIO.HIGH)

        tick += 1
        await asyncio.sleep(0.1)

setup()
