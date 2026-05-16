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
  alsaDev: 'hw:1,0'
}

const app = express()
let streamProc = null
let monitorProc = null
let lastStreamError = null

// Browser monitor clients fed from the live stream ffmpeg's stdout.
const monitorClients = new Set()

// Input gain — a software multiplier (ffmpeg `volume` filter). The M-Audio
// Conectiv exposes no ALSA mixer control, so gain is done in ffmpeg.
// Slider 0..100 maps to a multiplier; 50 → 8.0 (the previous fixed default).
let gainValue = 50
try { gainValue = clampGain(parseInt(fs.readFileSync(config.gainFile, 'utf8').trim())) } catch (e) {}

function clampGain (v) { return Math.min(100, Math.max(0, Number.isFinite(v) ? v : 50)) }
function gainMul () { return (gainValue / 50) * 8 }

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

// Monitor — streams the gained ALSA input as MP3 to the browser (for the level
// meter + audible pre-flight check). While streaming, the live ffmpeg already
// holds the device, so we fan its monitor output (stdout) out instead.
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

  // Not live: spawn a dedicated monitor ffmpeg (gain baked in at spawn).
  stopMonitor()
  const args = [
    '-f', 'alsa', '-i', config.alsaDev,
    '-ar', '44100', '-ac', '2',
    '-af', 'volume=' + gainMul(),
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

// Input gain — software multiplier applied by the capture ffmpeg.
app.get('/api/gain', function (req, res) {
  res.json({ gain: gainValue })
})

app.post('/api/gain', function (req, res) {
  const v = clampGain(Math.round(Number(req.body && req.body.value)))
  if (!Number.isFinite(Number(req.body && req.body.value))) {
    return res.status(400).json({ error: 'value must be 0..100' })
  }
  gainValue = v
  try { fs.writeFileSync(config.gainFile, String(v)) } catch (e) {}
  // The value is baked into ffmpeg at spawn: monitor picks it up on the next
  // re-pull; a running live stream keeps its gain until restarted.
  res.json({ gain: v })
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
  const mul = gainMul()
  const args = [
    '-f', 'alsa', '-i', config.alsaDev,
    '-ar', '44100', '-ac', '2',
    // Output 1 — lossless raw archive (pre-gain master)
    '-map', '0:a', '-c:a', 'pcm_s16le', wavPath,
    // Output 2 — the broadcast: input gain + compressor
    '-map', '0:a',
    '-af', 'volume=' + mul + ',acompressor=threshold=0.25:ratio=4:attack=5:release=200:makeup=2.5',
    '-acodec', 'libmp3lame', '-b:a', '128k',
    '-vn', '-f', 'flv', 'rtmp://kyo.sk:45860/live/stream',
    // Output 3 — gained monitor feed to stdout (browser meter + listening)
    '-map', '0:a', '-af', 'volume=' + mul,
    '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1'
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

app.listen(config.port, config.host, () => {
  console.log(`Server listening ${config.host}:${config.port} — gain ${gainValue}`)
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
