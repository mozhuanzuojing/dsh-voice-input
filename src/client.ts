// dsh-audio-copilot client half — 在聊天输入框工具栏注入"语音输入"麦克风按钮。
//
// 交互:点击麦克风 → 浏览器 MediaRecorder 录音 → 结束后把音频 blob POST 到
// host 的 /audio-copilot/transcribe → 拿回文字 → 追加到输入框 draft。
//
// 挂载方式:window.__ModuleLoader__.load({ id, factory }) —— factory 返回带
// apply 方法的对象(cordis Koa/Egg 风格 plugin),apply 里执行 DOM 挂载。
//
// ⚠️ 为什么旧版按钮"看得见点不着"(2026-08-21 修复):
//   DSH 输入框 textarea 是 position:absolute; inset:0 的透明层(color:#0000,
//   文字由 backdrop 层绘制,镜像层定高),绝对定位元素绘制在普通流元素之上。
//   旧代码把按钮 append 进输入框容器 div.grow(按钮是普通流元素)→ 被透明
//   textarea 盖住 → 视觉可见但点击全部落在 textarea 上。
//   修复:按钮挂到工具栏行(row)的右侧簇(trailing,和模型选择器/发送按钮同行),
//   并设 position:relative + z-index 兜底,保证永远在可点击层级。

const MODULE_ID = 'dsh-audio-copilot'
const TRANSCRIBE_URL = '/audio-copilot/transcribe'

function findComposer(): HTMLTextAreaElement | null {
  // DSH 输入框:带 placeholder 的 textarea(composer card 内唯一的 textarea)
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[data-composer-card], textarea[placeholder]',
  )
  if (textarea) return textarea
  // 兜底:任何可见 textarea
  const anyArea = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).find(
    (t) => t.offsetParent !== null,
  )
  return anyArea ?? null
}

function insertTextIntoComposer(composer: HTMLTextAreaElement, text: string) {
  const sep = composer.value && !composer.value.endsWith('\n') ? '\n' : ''
  const next = composer.value + sep + text
  composer.value = next
  composer.dispatchEvent(new Event('input', { bubbles: true }))
  composer.focus()
}

function createButton(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.title = '语音输入(录音转文字)'
  btn.setAttribute('aria-label', '语音输入')
  btn.style.cssText = [
    'display:inline-flex;align-items:center;justify-content:center;',
    'width:28px;height:28px;border-radius:999px;border:none;',
    'background:transparent;cursor:pointer;color:inherit;font-size:14px;line-height:1;',
    'flex:none;position:relative;z-index:10;padding:0;',
  ].join('')
  btn.innerHTML = '🎤'
  return btn
}

function mountButton() {
  const composer = findComposer()
  if (!composer) return
  const card = composer.closest<HTMLElement>('[data-composer-card]')
  if (!card) return
  // 已挂载(或 React 重渲染后残留)→ 跳过,避免重复
  if (card.querySelector('[data-audio-copilot-mic]')) return

  const btn = createButton()
  btn.dataset.audioCopilotMic = 'true'

  // 目标位置:工具栏行(row:含 + 按钮与发送按钮)的右侧簇(trailing)。
  // 结构:card 的子元素含 [overlay?][accessory?][attachments?] scroll row。
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

  let mediaRecorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let recording = false

  const setState = (state: 'idle' | 'recording' | 'busy') => {
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
  btn.addEventListener('mousedown', (e) => e.preventDefault())

  btn.addEventListener('click', async () => {
    if (recording) {
      mediaRecorder?.stop()
      return
    }
    if (mediaRecorder?.state === 'recording') return
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('当前环境不支持麦克风(无 navigator.mediaDevices)')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks = []
      mediaRecorder = new MediaRecorder(stream)
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setState('busy')
        try {
          const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
          const form = new FormData()
          form.append('file', blob, 'voice.webm')
          const res = await fetch(TRANSCRIBE_URL, { method: 'POST', body: form })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || typeof body?.text !== 'string') {
            setState('idle')
            alert(`语音转写失败:${body?.error ?? res.status}`)
            return
          }
          const fresh = findComposer()
          if (fresh) insertTextIntoComposer(fresh, body.text)
          setState('idle')
        } catch (err) {
          setState('idle')
          alert(`语音转写请求失败:${err instanceof Error ? err.message : String(err)}`)
        }
      }
      mediaRecorder.start()
      setState('recording')
    } catch (err) {
      alert(`无法访问麦克风:${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

// 主入口:等 DOM 就绪后挂按钮;用 MutationObserver 应对 SPA 动态渲染
// (React 重渲染换掉输入区后,旧按钮随旧 DOM 消失,观察器会重新挂载)。
function boot() {
  const tryMount = () => {
    if (findComposer()) mountButton()
  }
  tryMount()
  const observer = new MutationObserver(() => tryMount())
  observer.observe(document.body, { childList: true, subtree: true })
}

// 挂载形态:window.__ModuleLoader__.load({ id, factory })。DSH 的 cordis
// plugin loader 会把 factory 的 return value 传给 @deepseek-ai/cordis
// registry,后者校验"必须为函数 或 含 .apply 方法的对象";否则抛
// "invalid plugin, expect function or object with an apply method, received ..."
//
// 因此 factory 必须 return `{ apply }` 形态(等同 Koa plugin)。apply 同步执行
// 挂载即可,ctx 不需要(DOM 副作用,不依赖任何 cordis service)。
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
