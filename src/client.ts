// dsh-audio-copilot client half — 在聊天输入框工具栏注入"语音输入"麦克风按钮。
//
// 交互:点击麦克风 → MediaRecorder 录音(红点脉冲 + 计时)→ 停止 →
// POST host /audio-copilot/transcribe(Gemini 多模态免费转写)→ 文字填入输入框。
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
//
// 挂载方式:window.__ModuleLoader__.load({ id, factory }) —— factory 返回带
// apply 方法的对象(cordis Koa/Egg 风格 plugin),apply 里执行 DOM 挂载。

const MODULE_ID = 'dsh-audio-copilot'
const TRANSCRIBE_URL = '/audio-copilot/transcribe'
const MAX_RECORD_MS = 60000 // 最长录音 60 秒,自动停止

// ── 一次性注入样式 ─────────────────────────────────────────────────────────

const STYLE_ID = 'dac-styles'

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
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

// ── SVG 图标(自绘,通用图形元素)────────────────────────────────────────────

function iconMic(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="3" width="6" height="11" rx="3"></rect>' +
    '<path d="M5 11.5a7 7 0 0 0 14 0"></path>' +
    '<path d="M12 18.5v3"></path>' +
    '<path d="M8.5 21.5h7"></path></svg>'
}
function iconStop(): string {
  return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5"></rect></svg>'
}
function iconSpinner(): string {
  return '<svg class="dac-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M12 3a9 9 0 1 0 9 9"></path></svg>'
}

// ── 输入框定位与文本写入 ───────────────────────────────────────────────────

function findComposer(): HTMLTextAreaElement | null {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[data-composer-card], textarea[placeholder]',
  )
  if (textarea) return textarea
  const anyArea = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).find(
    (t) => t.offsetParent !== null,
  )
  return anyArea ?? null
}

function insertTextIntoComposer(composer: HTMLTextAreaElement, text: string) {
  const sep = composer.value && !composer.value.endsWith('\n') ? '\n' : ''
  // 最接近真实用户输入的注入方式:execCommand('insertText') 走浏览器原生
  // 编辑命令链,React 受控组件完整兼容(直接赋 .value / 原型 setter 都会被
  // React value tracker + restoreControlledState 重置或吞掉,实测过两种都坏)。
  composer.focus()
  const fallback = () => {
    composer.value = composer.value + sep + text
    composer.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    )
  }
  try {
    composer.setSelectionRange(composer.value.length, composer.value.length)
    const ok = document.execCommand('insertText', false, sep + text)
    if (!ok) fallback()
  } catch {
    fallback()
  }
}

// ── 按钮构建与挂载 ─────────────────────────────────────────────────────────

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dac-btn'
  btn.title = '语音输入(录音转文字)'
  btn.setAttribute('aria-label', '语音输入')
  btn.setAttribute('data-state', 'idle')
  btn.innerHTML = iconMic()
  return btn
}

// 共享的录音器引用:SPA 重渲染换按钮时,旧的录音要停掉
const shared: { recorder: MediaRecorder | null; stream: MediaStream | null; timerHandle: number | null } = {
  recorder: null,
  stream: null,
  timerHandle: null,
}

function stopRecording() {
  if (shared.recorder && shared.recorder.state !== 'inactive') {
    try { shared.recorder.stop() } catch { /* noop */ }
  }
}

function mountButton() {
  const composer = findComposer()
  if (!composer) return
  const card = composer.closest<HTMLElement>('[data-composer-card]')
  if (!card) return
  if (card.querySelector('[data-audio-copilot-mic]')) return

  const btn = makeButton()
  btn.dataset.audioCopilotMic = 'true'

  // 目标位置:工具栏行(row)的右侧簇(trailing),与模型选择器/发送按钮同行
  const row = Array.from(card.children).find(
    (el) =>
      el instanceof HTMLElement &&
      /row/.test(el.className) &&
      el.querySelector('button') !== null,
  )
  const trailing =
    row?.lastElementChild instanceof HTMLElement && /trailing/.test(row.lastElementChild.className)
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
  const pop = document.createElement('div')
  pop.className = 'dac-pop'
  pop.hidden = true
  btn.appendChild(pop)
  const popText = document.createElement('span')
  pop.appendChild(popText)

  let recording = false
  let chunks: Blob[] = []
  let elapsed = 0
  let toastHandle: number | null = null

  function setState(state: 'idle' | 'recording' | 'busy', text?: string) {
    recording = state === 'recording'
    btn.setAttribute('data-state', state)
    btn.innerHTML = state === 'recording' ? iconStop() : state === 'busy' ? iconSpinner() : iconMic()
    // innerHTML 重建会清掉气泡,重新拼回来
    const dot = document.createElement('span')
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

  function showToast(msg: string) {
    pop.classList.add('dac-err')
    popText.textContent = msg
    pop.hidden = false
    clearTimeout(toastHandle ?? undefined)
    toastHandle = window.setTimeout(() => { pop.hidden = true }, 5000)
  }

  function fmtTime(s: number) {
    const m = Math.floor(s / 60)
    const r = s % 60
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
  btn.addEventListener('mousedown', (e) => e.preventDefault())

  btn.addEventListener('click', async () => {
    if (recording) {
      stopRecording()
      return
    }
    if (shared.recorder?.state === 'recording') return
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('当前环境不支持麦克风')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks = []
      shared.stream = stream
      shared.recorder = new MediaRecorder(stream)
      const mr = shared.recorder
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      mr.onstop = async () => {
        if (shared.stream) { shared.stream.getTracks().forEach((t) => t.stop()); shared.stream = null }
        if (shared.timerHandle !== null) clearInterval(shared.timerHandle)
        setState('busy', '转写中…')
        try {
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
          const form = new FormData()
          form.append('file', blob, 'voice.webm')
          const res = await fetch(TRANSCRIBE_URL, { method: 'POST', body: form })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || typeof body?.text !== 'string') {
            setState('idle')
            showToast(body?.error ?? `转写失败(${res.status})`)
            return
          }
          const fresh = findComposer()
          if (fresh) insertTextIntoComposer(fresh, body.text)
          setState('idle')
        } catch (err) {
          setState('idle')
          showToast(err instanceof Error ? err.message : String(err))
        }
      }
      mr.start()
      elapsed = 0
      setState('recording', '0:00')
      if (shared.timerHandle !== null) clearInterval(shared.timerHandle)
      shared.timerHandle = window.setInterval(tick, 1000)
    } catch (err) {
      showToast(`无法访问麦克风:${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

// 主入口:等 DOM 就绪后挂按钮;用 MutationObserver 应对 SPA 动态渲染
function boot() {
  ensureStyles()
  mountButton()
  const observer = new MutationObserver(() => mountButton())
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('beforeunload', () => stopRecording())
}

// 挂载形态:window.__ModuleLoader__.load({ id, factory })。DSH 的 cordis
// plugin loader 会把 factory 的 return value 传给 @deepseek-ai/cordis
// registry,后者校验"必须为函数 或 含 .apply 方法的对象";否则抛
// "invalid plugin, expect function or object with an apply method, received ..."
;(window as any).__ModuleLoader__.load({
  id: MODULE_ID,
  factory: function (require: any) {
    const module = { exports: {} as any }
    module.exports.apply = function (ctx: unknown) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot)
      } else {
        boot()
      }
    }
    return module.exports
  },
})

// 供 __ModuleLoader__ 使用:无默认导出(DSH 官方规范)。
