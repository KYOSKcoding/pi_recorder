const express = require('express')
const bodyParser = require('body-parser')
const fs = require('fs')
const p = require('path')
const { execSync, spawn } = require('child_process')

const config = {
  port: 8080,
  host: '0.0.0.0',
  recpath: p.resolve(process.env.RECORD_PATH || '/data/record'),
  statusFile: '/tmp/recorder_status.json',
  pidFile: '/tmp/recorder.pid'
}

const app = express()
let streamProc = null
let monitorProc = null
let lastStreamError = null

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
  status.monitoring = !!monitorProc
  status.lastStreamError = lastStreamError
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

// Monitor — streams ALSA input as MP3 to browser for pre-flight check
app.get('/api/monitor', function (req, res) {
  if (streamProc) return res.status(409).send('Cannot monitor while live')
  stopMonitor()
  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const args = [
    '-f', 'alsa', '-i', 'hw:1,0',
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

app.use(function (err, req, res, next) {
  console.error('Error', req.path, err.message)
  res.status(500).send(err.message)
})

function startStream () {
  if (streamProc) return
  lastStreamError = null
  const args = [
    '-f', 'alsa', '-i', 'hw:1,0',
    '-ar', '44100', '-ac', '2',
    '-af', 'volume=8,acompressor=threshold=0.25:ratio=4:attack=5:release=200:makeup=2.5',
    '-acodec', 'libmp3lame', '-b:a', '128k',
    '-vn', '-f', 'flv', 'rtmp://kyo.sk:45860/live/stream'
  ]
  streamProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  streamProc.stderr.on('data', d => process.stderr.write('[ffmpeg] ' + d))
  streamProc.on('exit', (code) => {
    lastStreamError = code !== 0 ? `ffmpeg exited (code ${code})` : null
    streamProc = null
  })
}

function stopStream () {
  if (streamProc) { streamProc.kill(); streamProc = null }
}

function stopMonitor () {
  if (monitorProc) { monitorProc.kill(); monitorProc = null }
}

app.listen(config.port, config.host, () => {
  console.log(`Server listening ${config.host}:${config.port}`)
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
