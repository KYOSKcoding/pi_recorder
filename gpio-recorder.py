#!/usr/bin/python3

import RPi.GPIO as GPIO
import subprocess
import json
import signal
import os
from datetime import datetime
from os import path
import asyncio

record_path = "/data/record"
status_file = "/tmp/recorder_status.json"
pid_file    = "/tmp/recorder.pid"

STATE_STANDBY = 'standby'
STATE_RECORD  = 'record'

state = None
p     = None

def write_status(recording, filename=None, started=None):
    try:
        with open(status_file, 'w') as f:
            json.dump({'recording': recording, 'filename': filename, 'started': started}, f)
    except Exception as e:
        print("Status write failed: " + str(e))

def state_toggle():
    global state
    print("state toggle (was " + str(state) + ")")
    if state == STATE_STANDBY:
        state = STATE_RECORD
        record_start()
    else:
        state = STATE_STANDBY
        record_stop()
    print("state toggle (now " + str(state) + ")")

def button_callback(channel):
    print("button pressed")
    state_toggle()

def record_start():
    global p
    now = datetime.now()
    filename = now.strftime("%Y-%m-%d_%H-%M-%S") + ".wav"
    filepath = path.join(record_path, filename)
    # "kyocap" = shared dsnoop device (see ~/.asoundrc) so the web monitor /
    # level meter can run alongside a local recording.
    command  = ["arecord", "-D", "kyocap", "-f", "S16_LE", "-c", "2", "-r", "44100", filepath]
    print("start record: " + filepath)
    p = subprocess.Popen(command)
    write_status(True, filename, now.isoformat())

def record_stop():
    global p
    print("stop record")
    if p:
        p.kill()
    p = None
    write_status(False)

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
    on = False
    while True:
        if state == STATE_RECORD:
            GPIO.output(11, GPIO.HIGH if on else GPIO.LOW)
            on = not on
        else:
            GPIO.output(11, GPIO.HIGH)
        await asyncio.sleep(0.5)

setup()
