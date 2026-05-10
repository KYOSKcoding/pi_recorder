const express = require('express')
const bodyParser = require('body-parser')
const fs = require('fs')
const p = require('path')
const os = require('os')
const { execSync, spawn } = require('child_process')
const https = require('https')

const config = {
  port: 8080,
  host: '0.0.0.0',
  recpath: p.resolve(process.env.RECORD_PATH || '/data/record'),
  statusFile: '/tmp/recorder_status.json',
  pidFile: '/tmp/recorder.pid',
  kyoHost: 'kyo.sk',
  kyoPassFile: p.join(os.homedir(), '.kyo_pass')
}

const app = express()
let streamProc = null
let kyoToken = null

// Auto-authenticate with kyo.sk using ~/.kyo_pass on startup
;(function initKyo () {
  try {
    const pass = fs.readFileSync(config.kyoPassFile, 'utf8').trim()
    if (!pass) return
    kyoAuthRequest(pass).then(token => {
      if (token) { kyoToken = token; console.log('kyo.sk: authenticated') }
      else console.log('kyo.sk: auth failed — check ~/.kyo_pass')
    }).catch(e => console.log('kyo.sk: auth error —', e.message))
  } catch (e) {
    console.log('kyo.sk: no ~/.kyo_pass — Go Live disabled')
  }
})()

function kyoAuthRequest (password) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ password })
    const opts = {
      hostname: config.kyoHost, port: 443,
      path: '/kyosky/api/radio/auth', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }
    const req = https.request(opts, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve(j.authenticated ? j.token : null) }
        catch (e) { resolve(null) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

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
  res.json(status)
})

app.delete('/api/delete/:file', function (req, res, next) {
  const file = req.params.file
  if (/[/\\]/.test(file)) return res.status(403).send('Bad filename')
  const fpath = filePath(file)
  fs.unlink(fpath, err => {
    if (err) return next(err)
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

app.post('/api/stream/start', function (req, res, next) {
  if (streamProc) return res.json({ streaming: true })
  const args = [
    '-f', 'alsa', '-i', 'hw:1,0',
    '-af', 'volume=8,acompressor=threshold=0.25:ratio=4:attack=5:release=200:makeup=2.5',
    '-acodec', 'libmp3lame', '-b:a', '128k',
    '-vn', '-f', 'flv', 'rtmp://kyo.sk:45860/live/stream'
  ]
  streamProc = spawn('ffmpeg', args, { stdio: 'ignore' })
  streamProc.on('exit', () => { streamProc = null })
  res.json({ streaming: true })
})

app.post('/api/stream/stop', function (req, res, next) {
  if (streamProc) { streamProc.kill(); streamProc = null }
  res.json({ streaming: false })
})

// kyo.sk proxy — token managed server-side, no browser login needed
app.get('/api/kyo/configured', function (req, res) {
  res.json({ configured: !!kyoToken })
})

app.get('/api/kyo/state', function (req, res, next) {
  if (!kyoToken) return res.json({ live_mode: false, configured: false })
  kyoProxy('GET', '/api/radio/state', null, kyoToken, res, next)
})

app.post('/api/kyo/live/start', function (req, res, next) {
  if (!kyoToken) return res.status(503).json({ error: 'kyo.sk not configured (create ~/.kyo_pass)' })
  kyoProxyWithRetry('POST', '/api/radio/live/start', null, res, next)
})

app.post('/api/kyo/live/stop', function (req, res, next) {
  if (!kyoToken) return res.status(503).json({ error: 'kyo.sk not configured (create ~/.kyo_pass)' })
  kyoProxyWithRetry('POST', '/api/radio/live/stop', null, res, next)
})

app.use(function (err, req, res, next) {
  console.error('Error', req.path, err.message)
  res.status(500).send(err.message)
})

app.listen(config.port, config.host, () => {
  console.log(`Server listening ${config.host}:${config.port}`)
})

// kyo proxy with one automatic re-auth on 401
function kyoProxyWithRetry (method, path, body, res, next) {
  kyoProxy(method, path, body, kyoToken, res, next, true)
}

function kyoProxy (method, path, body, token, res, next, retry) {
  const bodyStr = body ? JSON.stringify(body) : null
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Broadcaster-Token'] = token
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr)

  const opts = {
    hostname: config.kyoHost, port: 443,
    path: '/kyosky' + path, method, headers
  }

  const proxyReq = https.request(opts, proxyRes => {
    let data = ''
    proxyRes.on('data', c => { data += c })
    proxyRes.on('end', () => {
      if (proxyRes.statusCode === 401 && retry) {
        // Token expired — re-auth and retry once
        try {
          const pass = fs.readFileSync(config.kyoPassFile, 'utf8').trim()
          kyoAuthRequest(pass).then(newToken => {
            if (newToken) {
              kyoToken = newToken
              kyoProxy(method, path, body, kyoToken, res, next, false)
            } else {
              res.status(401).json({ error: 'kyo.sk re-auth failed' })
            }
          }).catch(next)
        } catch (e) {
          res.status(401).json({ error: 'kyo.sk re-auth failed: no .kyo_pass' })
        }
        return
      }
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data)
    })
  })
  proxyReq.on('error', next)
  if (bodyStr) proxyReq.write(bodyStr)
  proxyReq.end()
}

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
