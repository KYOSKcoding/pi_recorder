(function () {
  'use strict'

  var WAVESURFER_CDN = 'https://unpkg.com/wavesurfer.js@6.6.4/dist/wavesurfer.min.js'

  class RecorderApp {
    constructor () {
      // State
      this.recording  = false
      this.streaming  = false
      this.monitoring = false
      this.durationStart = null
      this.durationTimer = null

      // Player state
      this.wavesurfer = null
      this.wsReady    = false
      this.files      = []  // sorted file list
      this.trackIdx   = -1  // current track index in this.files

      // DOM
      this.recIndicator  = document.getElementById('recIndicator')
      this.recInner      = document.getElementById('recInner')
      this.statusLine    = document.getElementById('statusLine')
      this.recStatus     = document.getElementById('recStatus')
      this.recDuration   = document.getElementById('recDuration')
      this.diskFreeEl    = document.getElementById('diskFree')
      this.recBtn        = document.getElementById('recBtn')
      this.monitorBtn    = document.getElementById('monitorBtn')
      this.monitorAudio  = document.getElementById('monitorAudio')
      this.streamErrorEl = document.getElementById('streamError')
      this.liveBtn       = document.getElementById('liveBtn')
      this.fileList      = document.getElementById('fileList')
      this.refreshBtn    = document.getElementById('refreshBtn')

      // Player DOM
      this.playerSection  = document.getElementById('playerSection')
      this.nowPlayingName = document.getElementById('nowPlayingName')
      this.playPauseBtn   = document.getElementById('playPauseBtn')
      this.prevBtn        = document.getElementById('prevBtn')
      this.nextBtn        = document.getElementById('nextBtn')
      this.volumeSlider   = document.getElementById('volumeSlider')
      this.currentTimeEl  = document.getElementById('currentTime')
      this.trackDurationEl = document.getElementById('trackDuration')

      this.init()
    }

    init () {
      this.recBtn.addEventListener('click', () => this.handleRecToggle())
      this.monitorBtn.addEventListener('click', () => this.handleMonitorToggle())
      this.liveBtn.addEventListener('click', () => this.handleLiveToggle())
      this.refreshBtn.addEventListener('click', () => this.loadFiles())

      this.playPauseBtn.addEventListener('click', () => this.handlePlayPause())
      this.prevBtn.addEventListener('click', () => this.loadTrack(this.trackIdx - 1))
      this.nextBtn.addEventListener('click', () => this.loadTrack(this.trackIdx + 1))
      this.volumeSlider.addEventListener('input', e => {
        var vol = e.target.value / 100
        if (this.wavesurfer) this.wavesurfer.setVolume(vol)
        localStorage.setItem('rec_volume', e.target.value)
      })

      // Restore volume preference
      var savedVol = localStorage.getItem('rec_volume')
      if (savedVol) this.volumeSlider.value = savedVol

      // Load WaveSurfer from CDN, then init
      this.loadWaveSurfer()

      // Start polling
      this.pollStatus()
      setInterval(() => this.pollStatus(), 2000)
      this.loadFiles()
    }

    // ── WaveSurfer ────────────────────────────────────────────

    loadWaveSurfer () {
      var s = document.createElement('script')
      s.src = WAVESURFER_CDN
      s.onload = () => this.initWaveSurfer()
      s.onerror = () => console.warn('WaveSurfer CDN failed to load')
      document.head.appendChild(s)
    }

    initWaveSurfer () {
      this.wavesurfer = WaveSurfer.create({
        container: document.getElementById('waveform'),
        waveColor: '#004d00',
        progressColor: '#00ff00',
        cursorColor: '#00ff00',
        cursorWidth: 2,
        height: 40,
        normalize: true,
        responsive: true,
        backend: 'MediaElement',
      })

      var savedVol = parseInt(localStorage.getItem('rec_volume') || '80')
      this.wavesurfer.setVolume(savedVol / 100)

      this.wavesurfer.on('ready', () => {
        this.wsReady = true
        this.playPauseBtn.disabled = false
        this.playPauseBtn.textContent = '▶'
        this.trackDurationEl.textContent = this.formatTime(this.wavesurfer.getDuration())
        this.wavesurfer.play()
        this.playPauseBtn.textContent = '⏸'
      })

      this.wavesurfer.on('audioprocess', time => {
        this.currentTimeEl.textContent = this.formatTime(time)
      })

      this.wavesurfer.on('seek', progress => {
        if (this.wavesurfer.getDuration()) {
          this.currentTimeEl.textContent = this.formatTime(progress * this.wavesurfer.getDuration())
        }
      })

      this.wavesurfer.on('finish', () => {
        this.playPauseBtn.textContent = '▶'
        // Auto-advance to next track
        if (this.trackIdx < this.files.length - 1) {
          this.loadTrack(this.trackIdx + 1)
        }
      })

      this.wavesurfer.on('error', e => {
        console.warn('WaveSurfer error:', e)
        this.playPauseBtn.disabled = false
        this.playPauseBtn.textContent = '▶'
      })

      // If a track was queued before WaveSurfer was ready, load it now
      if (this._pendingTrack !== undefined) {
        this.loadTrack(this._pendingTrack)
        this._pendingTrack = undefined
      }
    }

    loadTrack (idx) {
      if (idx < 0 || idx >= this.files.length) return

      if (!this.wavesurfer) {
        this._pendingTrack = idx
        return
      }

      this.trackIdx = idx
      var file = this.files[idx]

      // Highlight active file in list
      var items = this.fileList.querySelectorAll('.file-item')
      items.forEach((li, i) => li.classList.toggle('active', i === idx))

      // Show player
      this.playerSection.style.display = 'block'
      this.nowPlayingName.textContent = (file.meta && file.meta.label) || file.name
      this.currentTimeEl.textContent = '0:00'
      this.trackDurationEl.textContent = '0:00'
      this.playPauseBtn.disabled = true
      this.playPauseBtn.textContent = '↻'
      this.wsReady = false

      this.wavesurfer.load('/rec/' + encodeURIComponent(file.name))

      // Update prev/next button states
      this.prevBtn.disabled = idx === 0
      this.nextBtn.disabled = idx === this.files.length - 1
    }

    handlePlayPause () {
      if (!this.wavesurfer || !this.wsReady) return
      if (this.wavesurfer.isPlaying()) {
        this.wavesurfer.pause()
        this.playPauseBtn.textContent = '▶'
      } else {
        this.wavesurfer.play()
        this.playPauseBtn.textContent = '⏸'
      }
    }

    formatTime (secs) {
      var s = Math.max(0, secs || 0)
      var m = Math.floor(s / 60)
      var ss = String(Math.floor(s % 60)).padStart(2, '0')
      return m + ':' + ss
    }

    // ── Recording / Streaming ─────────────────────────────────

    async pollStatus () {
      try {
        var r = await fetch('/api/status')
        var data = await r.json()
        this.updateStatus(data)
      } catch (e) {
        this.recStatus.textContent = '? offline'
        this.recStatus.className = 'status-text'
        this.statusLine.textContent = 'offline'
      }
    }

    updateStatus (data) {
      var wasRecording = this.recording
      this.recording = data.recording
      this.streaming = data.streaming || false
      this.monitoring = data.monitoring || false

      if (data.recording) {
        this.recIndicator.className = 'toggle-switch on'
        this.recStatus.textContent = '● REC'
        this.recStatus.className = 'status-text online'
        this.recBtn.textContent = '■ STOP REC'
        this.recBtn.classList.add('active')
        this.statusLine.textContent = data.filename || '● REC'
        if (!wasRecording) this.startDurationTimer(data.started)
      } else {
        this.recIndicator.className = 'toggle-switch off'
        this.recStatus.textContent = '○ STANDBY'
        this.recStatus.className = 'status-text'
        this.recBtn.textContent = '⬤ START REC'
        this.recBtn.classList.remove('active')
        this.statusLine.textContent = '○ STANDBY'
        if (wasRecording) {
          this.stopDurationTimer()
          this.loadFiles()
        }
      }

      this.monitorBtn.textContent = this.monitoring ? '■ STOP MONITOR' : '🔊 MONITOR'
      this.monitorBtn.classList.toggle('active', this.monitoring)
      this.monitorBtn.disabled = this.streaming

      this.liveBtn.textContent = this.streaming ? '■ STOP LIVE' : '● GO LIVE'
      this.liveBtn.classList.toggle('active', this.streaming)
      this.liveBtn.disabled = this.monitoring

      if (data.lastStreamError && !this.streaming) {
        this.streamErrorEl.textContent = data.lastStreamError
        this.streamErrorEl.style.display = ''
      } else {
        this.streamErrorEl.style.display = 'none'
      }

      this.diskFreeEl.textContent = data.diskFree ? data.diskFree + ' free' : ''
    }

    startDurationTimer (isoStart) {
      this.stopDurationTimer()
      this.durationStart = isoStart ? new Date(isoStart).getTime() : Date.now()
      this.recDuration.style.display = ''
      this.durationTimer = setInterval(() => {
        var secs = Math.floor((Date.now() - this.durationStart) / 1000)
        var m = String(Math.floor(secs / 60)).padStart(2, '0')
        var s = String(secs % 60).padStart(2, '0')
        this.recDuration.textContent = m + ':' + s
      }, 1000)
    }

    stopDurationTimer () {
      clearInterval(this.durationTimer)
      this.durationTimer = null
      this.recDuration.textContent = ''
      this.recDuration.style.display = 'none'
    }

    async handleRecToggle () {
      this.recBtn.disabled = true
      try {
        var r = await fetch('/api/record/toggle', { method: 'POST' })
        if (!r.ok) {
          var body = await r.json()
          alert('Record toggle failed: ' + (body.error || r.status))
        }
      } catch (e) {
        alert('Record toggle failed: ' + e.message)
      } finally {
        this.recBtn.disabled = false
      }
    }

    handleMonitorToggle () {
      if (this.monitoring) {
        this.monitorAudio.pause()
        this.monitorAudio.removeAttribute('src')
        this.monitorAudio.load()
        this.monitoring = false
        this.monitorBtn.textContent = '🔊 MONITOR'
        this.monitorBtn.classList.remove('active')
      } else {
        this.monitorAudio.src = '/api/monitor'
        this.monitorAudio.play().catch(e => {
          console.warn('monitor play failed:', e)
          this.monitorAudio.removeAttribute('src')
          this.monitoring = false
          this.monitorBtn.textContent = '🔊 MONITOR'
          this.monitorBtn.classList.remove('active')
        })
        this.monitoring = true
        this.monitorBtn.textContent = '■ STOP MONITOR'
        this.monitorBtn.classList.add('active')
      }
    }

    // ── Live streaming ────────────────────────────────────────

    async handleLiveToggle () {
      this.liveBtn.disabled = true
      try {
        var url = this.streaming ? '/api/live/stop' : '/api/live/start'
        var r = await fetch(url, { method: 'POST' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
      } catch (e) {
        alert('Go Live failed: ' + e.message)
      } finally {
        this.liveBtn.disabled = false
      }
    }

    // ── File list ─────────────────────────────────────────────

    async loadFiles () {
      try {
        var r = await fetch('/recs.json')
        var data = await r.json()
        this.renderFiles(data.files || [])
      } catch (e) {
        this.fileList.innerHTML = '<li class="files-empty">Error loading files.</li>'
      }
    }

    renderFiles (files) {
      if (files.length === 0) {
        this.fileList.innerHTML = '<li class="files-empty">No recordings yet.</li>'
        this.files = []
        return
      }

      files.sort((a, b) => new Date(b.ctime) - new Date(a.ctime))
      this.files = files
      this.fileList.innerHTML = ''

      files.forEach((file, idx) => {
        var li = document.createElement('li')
        li.className = 'file-item' + (idx === this.trackIdx ? ' active' : '')

        var label = document.createElement('span')
        label.className = 'file-label'
        label.textContent = (file.meta && file.meta.label) || file.name
        label.title = file.name

        var size = document.createElement('span')
        size.className = 'file-size'
        size.textContent = this.formatSize(file.size)

        var dl = document.createElement('button')
        dl.className = 'file-dl-btn'
        dl.textContent = '↓'
        dl.title = 'Download / Convert'
        dl.addEventListener('click', e => { e.stopPropagation(); this.showDownloadPopup(file, dl) })

        var del = document.createElement('button')
        del.className = 'rec-del'
        del.textContent = 'DEL'
        del.addEventListener('click', async e => {
          e.stopPropagation()
          if (!confirm('Delete ' + file.name + '?')) return
          try {
            var r = await fetch('/api/delete/' + encodeURIComponent(file.name), { method: 'DELETE' })
            if (r.ok) {
              li.remove()
              this.files.splice(idx, 1)
              if (idx === this.trackIdx) {
                this.trackIdx = -1
                this.playerSection.style.display = 'none'
                if (this.wavesurfer) this.wavesurfer.empty()
              } else if (idx < this.trackIdx) {
                this.trackIdx--
              }
              this.loadFiles()
            } else {
              alert('Delete failed')
            }
          } catch (ex) {
            alert('Delete error: ' + ex.message)
          }
        })

        // Click row to load into player
        li.addEventListener('click', () => this.loadTrack(idx))

        li.append(label, size, dl, del)
        this.fileList.appendChild(li)
      })
    }

    formatSize (bytes) {
      if (bytes > 1048576) return Math.round(bytes / 1048576) + ' MB'
      if (bytes > 1024) return Math.round(bytes / 1024) + ' KB'
      return bytes + ' B'
    }

    // ── Download modal ────────────────────────────────────────

    showDownloadPopup (file) {
      this.showDownloadModal(file)
    }

    triggerDownload (url, filename) {
      var a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
    }

    fallbackCopy (text) {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(ta)
      ta.focus(); ta.select()
      try { document.execCommand('copy') } catch (e) {}
      ta.remove()
    }

    showDownloadModal (file) {
      var dlFolder = localStorage.getItem('dl_folder') || '~/Downloads'
      var genre    = localStorage.getItem('dl_genre')  || 'electronic'
      var script   = '~/Nextcloud/KYOSKcoding/pi_recorder/process_recordings.py'

      var modal = document.createElement('div')
      modal.className = 'convert-modal'
      var inner = document.createElement('div')
      inner.className = 'convert-modal-inner'

      var title = document.createElement('div')
      title.className = 'convert-title'
      title.textContent = 'DOWNLOAD'

      // Row 1: download .wav
      var row1 = document.createElement('div')
      row1.className = 'convert-row'
      var r1label = document.createElement('span')
      r1label.className = 'convert-row-label'
      r1label.textContent = 'download .wav'
      var dlBtn = document.createElement('button')
      dlBtn.className = 'nav-btn'
      dlBtn.textContent = '⬇ download'
      dlBtn.addEventListener('click', () => {
        this.triggerDownload('/rec/' + encodeURIComponent(file.name), file.name)
        dlBtn.textContent = '✓ downloading…'
        setTimeout(() => { dlBtn.textContent = '⬇ download' }, 2000)
      })
      row1.append(r1label, dlBtn)

      // Row 2: genre
      var row2 = document.createElement('div')
      row2.className = 'convert-row'
      var r2label = document.createElement('label')
      r2label.className = 'convert-row-label'
      r2label.textContent = 'genre'
      var genreSelect = document.createElement('select')
      genreSelect.className = 'convert-select'
      ;['electronic', 'acoustic', 'podcast'].forEach(g => {
        var opt = document.createElement('option')
        opt.value = g; opt.textContent = g
        if (g === genre) opt.selected = true
        genreSelect.appendChild(opt)
      })
      row2.append(r2label, genreSelect)

      // Folder + command display
      var folderRow = document.createElement('div')
      folderRow.className = 'convert-row'
      var flabel = document.createElement('label')
      flabel.className = 'convert-row-label'
      flabel.textContent = 'folder'
      var folderInput = document.createElement('input')
      folderInput.className = 'convert-input'
      folderInput.value = dlFolder
      folderInput.spellcheck = false
      folderRow.append(flabel, folderInput)

      var codeEl = document.createElement('code')
      codeEl.className = 'convert-cmd'

      var updateCmd = () => {
        var dir = folderInput.value.trim() || '~/Downloads'
        var g   = genreSelect.value
        localStorage.setItem('dl_folder', dir)
        localStorage.setItem('dl_genre', g)
        codeEl.textContent = `python3 ${script} \\\n  --src-dir ${dir} --genre ${g} ${dir}`
      }
      folderInput.addEventListener('input', updateCmd)
      genreSelect.addEventListener('change', updateCmd)
      updateCmd()

      // Row 3: copy command + close
      var actions = document.createElement('div')
      actions.className = 'convert-actions'
      var copyBtn = document.createElement('button')
      copyBtn.className = 'nav-btn'
      copyBtn.textContent = 'copy command'
      copyBtn.addEventListener('click', () => {
        var text = codeEl.textContent
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).catch(() => this.fallbackCopy(text))
        } else {
          this.fallbackCopy(text)
        }
        copyBtn.textContent = '✓ copied!'
        setTimeout(() => { copyBtn.textContent = 'copy command' }, 1500)
      })
      var closeBtn = document.createElement('button')
      closeBtn.className = 'nav-btn'
      closeBtn.textContent = 'close'
      closeBtn.addEventListener('click', () => modal.remove())
      actions.append(copyBtn, closeBtn)

      modal.addEventListener('click', e => { if (e.target === modal) modal.remove() })
      inner.append(title, row1, row2, folderRow, codeEl, actions)
      modal.appendChild(inner)
      document.body.appendChild(modal)
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    window.app = new RecorderApp()
  })
})()
