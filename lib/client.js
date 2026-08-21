// dsh-audio-copilot client half — 语音输入按钮(浏览器端,纯 JS,零依赖)。
//
// 交互:点击麦克风 → MediaRecorder 录音(红点脉冲 + 计时)→ 停止 →
// 上传 host /audio-copilot/transcribe(Gemini 多模态免费转写)→ 文字填入输入框。
//
// UI 自研(仿 ChatGPT/豆包交互形态,未复制任何现成插件代码):
//   - 内联 SVG 麦克风图标(非 emoji),hover 高亮,28px 圆钮与 DSH 工具栏一致
//   - 录音中:红色脉冲光晕 + 秒表气泡(0:07)+ 停止方块图标
//   - 转写中:旋转 spinner
//   - 错误:按钮旁 toast 气泡,自动消失(不用 alert)
//
// 历史修复记录:
//   1) 旧版按钮 append 进输入框容器,被绝对定位透明 textarea 盖住 → 点不着;
//      改为挂到工具栏行(row)的右侧簇(trailing),并 position:relative+z-index 兜底。
//   2) mousedown preventDefault 保持输入框焦点;按 isConnected 重新挂载应对 SPA 重渲染。
window.__ModuleLoader__.load({
  id: 'dsh-audio-copilot',
  factory: function (require) {
    var module = { exports: {} }

    module.exports.apply = function (ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return

      var TRANSCRIBE_URL = '/audio-copilot/transcribe'
      var MAX_RECORD_MS = 60000 // 最长录音 60 秒,自动停止

      // ── 一次性注入样式 ────────────────────────────────────────────────
      var STYLE_ID = 'dac-styles'
      if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent =
          '.dac-btn{display:inline-flex;align-items:center;justify-content:center;' +
          'width:28px;height:28px;border-radius:999px;border:none;background:transparent;' +
          'cursor:pointer;color:var(--dsw-alias-label-secondary,#888);flex:none;' +
          'position:relative;z-index:10;padding:0;transition:background-color .12s ease,color .12s ease;}' +
          '.dac-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#333);}' +
          '.dac-btn:active{transform:scale(.94)}' +
          '.dac-btn svg{width:16px;height:16px;display:block}' +
          '.dac-btn[data-state="recording"]{color:#e5484d}' +
          '.dac-btn[data-state="recording"]:after{content:"";position:absolute;inset:-3px;border-radius:999px;' +
          'border:2px solid rgba(229,72,77,.55);animation:dac-pulse 1.2s ease-out infinite}' +
          '.dac-btn[data-state="busy"]{color:var(--dsw-alias-label-tertiary,#999);cursor:default}' +
          '.dac-btn[data-state="busy"] .dac-spin{animation:dac-spin 1s linear infinite}' +
          '@keyframes dac-pulse{0%{transform:scale(.85);opacity:1}70%{transform:scale(1.35);opacity:0}100%{opacity:0}}' +
          '@keyframes dac-spin{to{transform:rotate(360deg)}}' +
          '.dac-pop{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);' +
          'white-space:nowrap;background:var(--dsw-specific-menu,#222);color:var(--dsw-alias-label-primary,#eee);' +
          'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;' +
          'padding:4px 10px;font-size:12px;line-height:18px;box-shadow:0 4px 14px rgba(0,0,0,.25);' +
          'z-index:60;display:flex;align-items:center;gap:6px;pointer-events:none}' +
          '.dac-pop[hidden]{display:none}' +
          '.dac-pop .dac-dot{width:7px;height:7px;border-radius:50%;background:#e5484d;flex:none;' +
          'animation:dac-blink 1s steps(2,start) infinite}' +
          '@keyframes dac-blink{50%{opacity:.3}}' +
          '.dac-pop.dac-err{border-color:rgba(229,72,77,.6);color:#ff8a8d}' +
          '.dac-pop.dac-err .dac-dot{display:none}'
        document.head.appendChild(style)
      }

      // ── SVG 图标(自绘,通用图形元素)──────────────────────────────────
      function iconMic() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="9" y="3" width="6" height="11" rx="3"></rect>' +
          '<path d="M5 11.5a7 7 0 0 0 14 0"></path>' +
          '<path d="M12 18.5v3"></path>' +
          '<path d="M8.5 21.5h7"></path></svg>'
      }
      function iconStop() {
        return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5"></rect></svg>'
      }
      function iconSpinner() {
        return '<svg class="dac-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
          '<path d="M12 3a9 9 0 1 0 9 9"></path></svg>'
      }

      // ── 输入框定位与文本写入 ──────────────────────────────────────────
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
        var next = composer.value + sep + text
        // React 受控组件标准注入(社区验证方案):
        // 1) 用原型链原生 value setter 赋值,绕过实例上被 React tracker 包裹的 setter
        // 2) 手动同步 React 的 _valueTracker,否则 restoreControlledState 会把
        //    这个"非 React 写入"的值强制重置回旧状态(实测 execCommand 和裸赋值都栽在这)
        // 3) 派发 input 事件 → React onChange → setDraft → 草稿更新 → 可见层重渲染
        var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), 'value')
        if (desc && desc.set) desc.set.call(composer, next)
        else composer.value = next
        var tracker = composer._valueTracker
        if (tracker && typeof tracker.setValue === 'function') tracker.setValue(next)
        composer.dispatchEvent(new Event('input', { bubbles: true }))
        composer.focus()
        try { composer.setSelectionRange(next.length, next.length) } catch (e) {}
      }

      // ── 按钮构建与挂载 ────────────────────────────────────────────────
      function makeButton() {
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'dac-btn'
        btn.title = '语音输入(录音转文字)'
        btn.setAttribute('aria-label', '语音输入')
        btn.setAttribute('data-state', 'idle')
        btn.innerHTML = iconMic()
        return btn
      }

      // 共享的录音器引用:SPA 重渲染换按钮时,旧的录音要停掉
      var shared = { recorder: null, stream: null, timerHandle: null }

      function stopRecording() {
        if (shared.recorder && shared.recorder.state !== 'inactive') {
          try { shared.recorder.stop() } catch (e) { /* noop */ }
        }
      }

      function mountButton() {
        var composer = findComposer()
        if (!composer) return
        var card = composer.closest('[data-composer-card]')
        if (!card) return
        if (card.querySelector('[data-audio-copilot-mic]')) return

        var btn = makeButton()
        btn.setAttribute('data-audio-copilot-mic', 'true')

        // 目标位置:工具栏行(row)的右侧簇(trailing),与模型选择器/发送按钮同行
        var row = null
        for (var i = 0; i < card.children.length; i++) {
          var el = card.children[i]
          if (el.tagName === 'DIV' && /row/.test(el.className) && el.querySelector('button') !== null) {
            row = el
            break
          }
        }
        var trailing = row && row.lastElementChild && /trailing/.test(row.lastElementChild.className)
          ? row.lastElementChild
          : null
        if (trailing) {
          trailing.insertBefore(btn, trailing.firstChild)
        } else {
          // 兜底:挂到卡片,绝对定位右下角,永远在输入区上方
          btn.style.position = 'absolute'
          btn.style.right = '12px'
          btn.style.bottom = '48px'
          btn.style.zIndex = '50'
          card.appendChild(btn)
        }

        // 状态气泡(计时/转写/错误)
        var pop = document.createElement('div')
        pop.className = 'dac-pop'
        pop.hidden = true
        btn.appendChild(pop)
        var popDot = document.createElement('span')
        popDot.className = 'dac-dot'
        var popText = document.createElement('span')
        pop.appendChild(popDot)
        pop.appendChild(popText)

        var recording = false
        var chunks = []
        var elapsed = 0
        var toastHandle = null

        function setState(state, text) {
          recording = state === 'recording'
          btn.setAttribute('data-state', state)
          btn.innerHTML = state === 'recording' ? iconStop() : state === 'busy' ? iconSpinner() : iconMic()
          // innerHTML 重建会清掉气泡,重新拼回来
          var dot = document.createElement('span')
          dot.className = 'dac-dot'
          pop.innerHTML = ''
          pop.appendChild(dot)
          pop.appendChild(popText)
          popText.textContent = text || ''
          if (state === 'recording' || state === 'busy') {
            pop.classList.remove('dac-err')
            pop.hidden = false
          } else {
            pop.hidden = true
          }
        }

        function showToast(msg) {
          pop.classList.add('dac-err')
          popText.textContent = msg
          pop.hidden = false
          clearTimeout(toastHandle)
          toastHandle = setTimeout(function () { pop.hidden = true }, 5000)
        }

        function fmtTime(s) {
          var m = Math.floor(s / 60)
          var r = s % 60
          return m + ':' + (r < 10 ? '0' : '') + r
        }

        function tick() {
          elapsed += 1
          popText.textContent = fmtTime(elapsed)
          if (elapsed >= Math.floor(MAX_RECORD_MS / 1000)) {
            stopRecording() // 到时自动停止(onstop 里收尾)
          }
        }

        // 防止 mousedown 默认行为抢走输入框焦点(与 DSH 自带按钮的 keepFocus 一致)
        btn.addEventListener('mousedown', function (e) { e.preventDefault() })

        btn.addEventListener('click', function () {
          if (recording) {
            stopRecording()
            return
          }
          if (shared.recorder && shared.recorder.state === 'recording') return
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast('当前环境不支持麦克风')
            return
          }
          navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then(function (stream) {
              chunks = []
              shared.stream = stream
              shared.recorder = new MediaRecorder(stream)
              var mr = shared.recorder
              mr.ondataavailable = function (e) {
                if (e.data.size > 0) chunks.push(e.data)
              }
              mr.onstop = function () {
                if (shared.stream) { shared.stream.getTracks().forEach(function (t) { t.stop() }); shared.stream = null }
                clearInterval(shared.timerHandle)
                setState('busy', '转写中…')
                var blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
                var form = new FormData()
                form.append('file', blob, 'voice.webm')
                fetch(TRANSCRIBE_URL, { method: 'POST', body: form })
                  .then(function (res) {
                    return res.json().catch(function () { return {} }).then(function (body) {
                      if (!res.ok || typeof body.text !== 'string') {
                        setState('idle')
                        showToast(body.error || ('转写失败(' + res.status + ')'))
                        return
                      }
                      var fresh = findComposer()
                      if (fresh) insertText(fresh, body.text)
                      setState('idle')
                    })
                  })
                  .catch(function (err) {
                    setState('idle')
                    showToast(err && err.message ? err.message : String(err))
                  })
              }
              mr.start()
              elapsed = 0
              setState('recording', '0:00')
              clearInterval(shared.timerHandle)
              shared.timerHandle = setInterval(tick, 1000)
            })
            .catch(function (err) {
              showToast('无法访问麦克风:' + (err && err.message ? err.message : String(err)))
            })
        })
      }

      function boot() {
        mountButton()
        // SPA 重渲染换掉输入区后,旧按钮随旧 DOM 消失;观察器会重新挂载。
        var observer = new MutationObserver(function () { mountButton() })
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('beforeunload', function () { stopRecording() })
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
