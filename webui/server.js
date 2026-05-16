const express = require('express')
const bodyParser = require('body-parser')
const fs = require('fs')
const os = require('os')
const p = require('path')
const { execSync, spawn } = require('child_process')

const config = {
  port: 8080,
  host: '0.0.0.0',
  recpath: p.resolve(process.env.RECORD_PATH || '/data/record'),
  statusFile: '/tmp/recorder_status.json',
  pidFile: '/tmp/recorder.pid',
  gainFile: p.join(os.homedir(), '.recorder_gain'),
  alsaCard: '1'
}

const app = express()
let streamProc = null
let monitorProc = null
let lastStreamError = null

// Browser monitor clients fed from the live stream ffmpeg's stdout.
const monitorClients = new Set()

// ALSA capture-gain control — discovered at startup, set via amixer.
let gainControl = null
let gainValue = 50

app.use('/', express.static(p.join(__dirname, 'app')))
app.use('/rec', express.static(config.recpath))
app.use('/api', bodyParser.json())

app.get('/recs.json', function (req, res, next) {
  getRecordings(config.recpath, (err, files) => {
    if (err) return next(err)
    res.json({ files })
  })
})

app.get('/api/status', function (req, res, next) {
  let status = { recording: false, filename: null, started: null }
  try { status = JSON.parse(fs.readFileSync(config.statusFile, 'utf8')) } catch (e) {}

  try {
    const df = execSync(`df -h "${config.recpath}" | tail -1`).toString().trim().split(/\s+/)
    status.diskFree = df[3]
  } catch (e) { status.diskFree = null }

  status.streaming = !!streamProc
  status.monitoring = !!monitorProc || (!!streamProc && monitorClients.size > 0)
  status.lastStreamError = lastStreamError
  status.gain = gainValue
  res.json(status)
})

app.delete('/api/delete/:file', function (req, res, next) {
  const file = req.params.file
  if (/[/\\]/.test(file)) return res.status(403).send('Bad filename')
  const fpath = filePath(file)
  fs.unlink(fpath, err => {
    if (err) return next(err)
    console.log('deleted', file)
    fs.unlink(fpath + '.json', () => res.status(200).send())
  })
})

app.post('/api/rename', function (req, res, next) {
  if (!req.body || !req.body.file) return res.status(400).send('Invalid request')
  const { file, label } = req.body
  if (file.match(/\//)) return res.status(403).send('Bad filename')
  const metaPath = filePath(file + '.json')
  fs.readFile(metaPath, (err, buf) => {
    const json = err ? {} : (() => { try { return JSON.parse(buf.toString()) } catch (e) { return {} } })()
    fs.writeFile(metaPath, JSON.stringify({ ...json, label }), err => {
      if (err) return next(err)
      res.status(200).send()
    })
  })
})

app.post('/api/record/toggle', function (req, res, next) {
  try {
    const pid = parseInt(fs.readFileSync(config.pidFile, 'utf8').trim())
    process.kill(pid, 'SIGUSR1')
    res.json({ ok: true })
  } catch (e) {
    res.status(503).json({ error: 'Recorder not running: ' + e.message })
  }
})

// Monitor — streams the raw ALSA input as MP3 to the browser (for the level
// meter + audible pre-flight check). While streaming, the live ffmpeg already
// captures the device, so we fan its monitor output (stdout) out instead.
app.get('/api/monitor', function (req, res) {
  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  if (streamProc) {
    // Live: attach to the running stream ffmpeg's monitor feed.
    monitorClients.add(res)
    const drop = () => { monitorClients.delete(res); if (!res.writableEnded) res.end() }
    req.on('close', drop)
    return
  }

  // Not live: spawn a dedicated monitor ffmpeg.
  stopMonitor()
  const args = [
    '-f', 'alsa', '-i', 'hw:' + config.alsaCard + ',0',
    '-ar', '44100', '-ac', '2',
    '-acodec', 'libmp3lame', '-b:a', '128k',
    '-f', 'mp3', 'pipe:1'
  ]
  monitorProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  monitorProc.stdout.pipe(res)
  monitorProc.stderr.on('data', d => process.stderr.write('[monitor] ' + d))
  req.on('close', stopMonitor)
  monitorProc.on('exit', () => { monitorProc = null; if (!res.writableEnded) res.end() })
})

// Live stream — kyo.sk server auto-detects connection and switches to live mode
app.post('/api/live/start', function (req, res) {
  stopMonitor()
  startStream()
  res.json({ streaming: true })
})

app.post('/api/live/stop', function (req, res) {
  stopStream()
  res.json({ streaming: false })
})

// Input gain — sets the HiFiBerry ADC hardware capture gain via amixer.
app.get('/api/gain', function (req, res) {
  res.json({ gain: gainValue, control: gainControl })
})

app.post('/api/gain', function (req, res) {
  const v = Math.round(Number(req.body && req.body.value))
  if (!Number.isFinite(v) || v < 0 || v > 100) {
    return res.status(400).json({ error: 'value must be 0..100' })
  }
  gainValue = v
  try { fs.writeFileSync(config.gainFile, String(v)) } catch (e) {}
  if (!applyGain(v)) {
    return res.status(503).json({ error: 'No ALSA capture control found', gain: v })
  }
  res.json({ gain: v, control: gainControl })
})

app.use(function (err, req, res, next) {
  console.error('Error', req.path, err.message)
  res.status(500).send(err.message)
})

function startStream () {
  if (streamProc) return
  lastStreamError = null
  const ts = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '')
  const wavPath = filePath('LIVE_' + ts + '.wav')
  const args = [
    '-f', 'alsa', '-i', 'hw:' + config.alsaCard + ',0',
    '-ar', '44100', '-ac', '2',
    // Output 1 — lossless raw archive
    '-map', '0:a', '-c:a', 'pcm_s16le', wavPath,
    // Output 2 — the broadcast (DSP chain unchanged)
    '-map', '0:a',
    '-af', 'volume=8,acompressor=threshold=0.25:ratio=4:attack=5:release=200:makeup=2.5',
    '-acodec', 'libmp3lame', '-b:a', '128k',
    '-vn', '-f', 'flv', 'rtmp://kyo.sk:45860/live/stream',
    // Output 3 — raw monitor feed to stdout (browser meter + listening)
    '-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1'
  ]
  streamProc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  // Always drain stdout so ffmpeg never blocks; fan out to monitor clients.
  streamProc.stdout.on('data', chunk => {
    for (const r of monitorClients) { try { r.write(chunk) } catch (e) {} }
  })
  streamProc.stderr.on('data', d => process.stderr.write('[ffmpeg] ' + d))
  streamProc.on('exit', (code) => {
    lastStreamError = code !== 0 && code !== 255 ? `ffmpeg exited (code ${code})` : null
    streamProc = null
    for (const r of monitorClients) { if (!r.writableEnded) r.end() }
    monitorClients.clear()
  })
}

function stopStream () {
  if (streamProc) {
    // SIGINT — ffmpeg finalises all outputs (the WAV header) cleanly.
    streamProc.kill('SIGINT')
    streamProc = null
  }
  for (const r of monitorClients) { if (!r.writableEnded) r.end() }
  monitorClients.clear()
}

function stopMonitor () {
  if (monitorProc) { monitorProc.kill(); monitorProc = null }
}

// ── ALSA capture gain ───────────────────────────────────────────────────────

/** Find a capture-capable ALSA simple control on the recording card. */
function discoverGainControl () {
  try {
    const out = execSync(`amixer -c ${config.alsaCard} scontrols`).toString()
    const names = []
    out.split('\n').forEach(line => {
      const m = line.match(/Simple mixer control '(.+)',\d+/)
      if (m) names.push(m[1])
    })
    // Prefer obvious capture/ADC controls, else the first that has a capture volume.
    const preferred = names.find(n => /adc|pga|capture|mic|line/i.test(n))
    const candidates = preferred ? [preferred, ...names] : names
    for (const name of candidates) {
      try {
        const info = execSync(`amixer -c ${config.alsaCard} sget "${name}"`).toString()
        if (/Capture channels|Capture\b.*\[\d+%\]/i.test(info)) return name
      } catch (e) {}
    }
  } catch (e) {
    console.warn('amixer not available:', e.message)
  }
  return null
}

/** Apply gain (0..100) to the discovered capture control. Returns success. */
function applyGain (v) {
  if (!gainControl) return false
  try {
    execSync(`amixer -c ${config.alsaCard} sset "${gainControl}" ${v}% cap`)
    return true
  } catch (e) {
    console.warn('amixer sset failed:', e.message)
    return false
  }
}

function initGain () {
  gainControl = discoverGainControl()
  try { gainValue = Math.min(100, Math.max(0, parseInt(fs.readFileSync(config.gainFile, 'utf8').trim()))) } catch (e) {}
  if (gainControl) {
    console.log(`Gain control: "${gainControl}" — applying ${gainValue}%`)
    applyGain(gainValue)
  } else {
    console.warn('No ALSA capture control found — gain slider will be inert')
  }
}

app.listen(config.port, config.host, () => {
  console.log(`Server listening ${config.host}:${config.port}`)
  initGain()
})

function filePath (filename) {
  return p.join(config.recpath, filename)
}

function getRecordings (basepath, cb) {
  fs.readdir(basepath, (err, files) => {
    if (err) return cb(err)
    files = files.filter(f => /\.(mp3|wav)$/.test(f))
    if (files.length === 0) return cb(null, [])
    const list = []
    let pending = files.length
    files.forEach(filename => {
      const fullpath = p.join(basepath, filename)
      fs.stat(fullpath, (err, stat) => {
        if (err) return cb(err)
        const row = { name: filename, size: stat.size, ctime: stat.ctime }
        fs.readFile(fullpath + '.json', (err, buf) => {
          if (!err) { try { row.meta = JSON.parse(buf.toString()) } catch (e) {} }
          list.push(row)
          if (--pending === 0) cb(null, list)
        })
      })
    })
  })
}
