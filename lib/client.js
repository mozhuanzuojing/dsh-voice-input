// dsh-audio-copilot client half — 语音输入按钮(浏览器端,纯 JS,零依赖)。
//
// 交互:点击麦克风 → MediaRecorder 录音 → 上传 host /audio-copilot/transcribe →
// 拿回文字 → 追加到输入框。
//
// ⚠️ 2026-08-21 修复"看得见点不着":DSH 输入框 textarea 是 position:absolute;
// inset:0 的透明层(color:#0000,文字由 backdrop 层绘制),绝对定位元素绘制在普通
// 流元素之上。旧代码把按钮 append 进输入框容器 div.grow → 被透明 textarea 盖住
// → 点击全部落在 textarea 上。修复:按钮挂到工具栏行(row)的右侧簇(trailing,
// 与模型选择器/发送按钮同行),并设 position:relative + z-index 兜底。
//
// 挂载形态:window.__ModuleLoader__.load({ id, factory })。factory 的返回值会被
// cordis registry 校验"必须为函数 或 含 .apply 方法的对象",因此 factory 返回
// 带 apply 方法的对象(等同 Koa plugin);apply 同步执行挂载,ctx 不需要。
window.__ModuleLoader__.load({
  id: 'dsh-audio-copilot',
  factory: function (require) {
    var module = { exports: {} }

    module.exports.apply = function (ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return

      var TRANSCRIBE_URL = '/audio-copilot/transcribe'

      function findComposer() {
        var area = document.querySelector('textarea[data-composer-card], textarea[placeholder]')
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
          'width:28px;height:28px;border-radius:999px;border:none;' +
          'background:transparent;cursor:pointer;color:inherit;font-size:14px;line-height:1;' +
          'flex:none;position:relative;z-index:10;padding:0;'
        btn.innerHTML = '🎤'
        return btn
      }

      function mountButton() {
        var composer = findComposer()
        if (!composer) return
        var card = composer.closest('[data-composer-card]')
        if (!card) return
        if (card.querySelector('[data-audio-copilot-mic]')) return

        var btn = makeButton()
        btn.setAttribute('data-audio-copilot-mic', 'true')

        // 目标位置:工具栏行(row,含 + 按钮与发送按钮)的右侧簇(trailing)。
        var row = null
        for (var i = 0; i < card.children.length; i++) {
          var el = card.children[i]
          if (
            el.tagName === 'DIV' &&
            /row/.test(el.className) &&
            el.querySelector('button') !== null
          ) {
            row = el
            break
          }
        }
        var trailing =
          row && row.lastElementChild && /trailing/.test(row.lastElementChild.className)
            ? row.lastElementChild
            : null
        if (trailing) {
          // 插到右侧簇最左(模型选择器之前),与发送按钮同一行
          trailing.insertBefore(btn, trailing.firstChild)
        } else {
          // 兜底:挂到卡片,绝对定位右下角,永远在输入区上方
          btn.style.position = 'absolute'
          btn.style.right = '12px'
          btn.style.bottom = '48px'
          btn.style.zIndex = '50'
          card.appendChild(btn)
        }

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

        // 防止 mousedown 默认行为抢走输入框焦点(与 DSH 自带按钮的 keepFocus 一致)
        btn.addEventListener('mousedown', function (e) { e.preventDefault() })

        btn.addEventListener('click', function () {
          if (recording) {
            if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop()
            return
          }
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('当前环境不支持麦克风(无 navigator.mediaDevices)')
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
      }

      function boot() {
        mountButton()
        // SPA 重渲染换掉输入区后,旧按钮随旧 DOM 消失;观察器会重新挂载
        var observer = new MutationObserver(function () { mountButton() })
        observer.observe(document.body, { childList: true, subtree: true })
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot)
      } else {
        boot()
      }
    }

    return module.exports
  }
})
