// dsh-audio-copilot client half — 语音输入按钮(浏览器端,纯 JS,零依赖)。
//
// 交互:点击麦克风 → MediaRecorder 录音 → 上传 host /audio-copilot/transcribe →
// 拿回文字 → 追加到输入框。
//
// 格式:window.__ModuleLoader__.load({ id, factory }) —— DSH 浏览器插件的标准挂载
// 形态(与 describe-image 的 client 半一致)。factory 收到 require;我们只用 DOM,
// 因此 factory 直接返回空导出即可,副作用在 load 时立即执行。
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return

  var TRANSCRIBE_URL = '/audio-copilot/transcribe'

  function findComposer() {
    var area = document.querySelector('textarea[data-composer], textarea[data-draft], textarea[placeholder]')
    if (area) return area
    var anyArea = Array.prototype.slice.call(document.querySelectorAll('textarea')).find(function (t) {
      return t.offsetParent !== null
    })
    return anyArea || null
  }

  function insertText(composer, text) {
    var sep = composer.value && !composer.value.endsWith('\n') ? '\n' : ''
    composer.value = composer.value + sep + text
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    composer.focus()
  }

  function makeButton() {
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.title = '语音输入(录音转文字)'
    btn.setAttribute('aria-label', '语音输入')
    btn.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:32px;height:32px;border-radius:8px;border:1px solid rgba(127,127,127,.35);' +
      'background:transparent;cursor:pointer;color:inherit;font-size:15px;line-height:1;flex:none;'
    btn.innerHTML = '🎤'
    return btn
  }

  var mounted = false

  function mount() {
    if (mounted) return
    var composer = findComposer()
    if (!composer) return
    var container = composer.closest('div')
    if (!container) return
    mounted = true

    var btn = makeButton()
    var mediaRecorder = null
    var chunks = []
    var recording = false

    function setState(state) {
      recording = state === 'recording'
      btn.innerHTML = state === 'recording' ? '⏹️' : state === 'busy' ? '⏳' : '🎤'
      btn.title =
        state === 'recording'
          ? '录音中…点击停止'
          : state === 'busy'
            ? '转写中…'
            : '语音输入(录音转文字)'
    }

    btn.addEventListener('click', function () {
      if (recording) {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop()
        return
      }
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          chunks = []
          mediaRecorder = new MediaRecorder(stream)
          mediaRecorder.ondataavailable = function (e) {
            if (e.data.size > 0) chunks.push(e.data)
          }
          mediaRecorder.onstop = function () {
            stream.getTracks().forEach(function (t) { t.stop() })
            setState('busy')
            var blob = new Blob(chunks, { type: mediaRecorder ? mediaRecorder.mimeType : 'audio/webm' })
            var form = new FormData()
            form.append('file', blob, 'voice.webm')
            fetch(TRANSCRIBE_URL, { method: 'POST', body: form })
              .then(function (res) {
                return res.json().catch(function () { return {} }).then(function (body) {
                  if (!res.ok || typeof body.text !== 'string') {
                    setState('idle')
                    alert('语音转写失败:' + (body.error || res.status))
                    return
                  }
                  var fresh = findComposer()
                  if (fresh) insertText(fresh, body.text)
                  setState('idle')
                })
              })
              .catch(function (err) {
                setState('idle')
                alert('语音转写请求失败:' + (err && err.message ? err.message : String(err)))
              })
          }
          mediaRecorder.start()
          setState('recording')
        })
        .catch(function (err) {
          alert('无法访问麦克风:' + (err && err.message ? err.message : String(err)))
        })
    })

    container.appendChild(btn)
  }

  function boot() {
    mount()
    var observer = new MutationObserver(function () { mount() })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
