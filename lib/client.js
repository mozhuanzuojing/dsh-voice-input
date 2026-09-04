"use strict";
(() => {
// dsh-voice-input client half — 在聊天输入框工具栏注入"语音输入"麦克风按钮。
//
// 交互:点击麦克风 → MediaRecorder 录音(红点脉冲 + 计时)→ 停止 →
// POST host /voice-input/transcribe(Gemini 多模态免费转写)→ 文字填入输入框。
// Chrome/Edge 支持 Web Speech API 时优先浏览器原生识别,免 key、实时。
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
const MODULE_ID = 'dsh-voice-input';
const TRANSCRIBE_URL = '/dsh-voice-input/transcribe';
const MAX_RECORD_MS = 28000; // 最长录音 28 秒(智谱 ASR 限 30 秒),自动停止
// 浏览器原生 Web Speech(Chrome/Edge):支持则优先用它做实时语音输入,免 key;
// 不支持时回退到 MediaRecorder → host(服务端 Gemini/智谱/本地 Whisper)。
function supportsWebSpeech() {
    const w = window;
    return typeof w.SpeechRecognition !== 'undefined' || typeof w.webkitSpeechRecognition !== 'undefined';
}
// 引擎选择:Web Speech 走浏览器原生(免 key/实时);其余走服务端 ASR。
const ENGINE_KEY = 'dsh-voice-input.engine';
const ENGINES = [
    { value: 'webspeech', label: 'Web Speech' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'zhipu', label: '智谱' },
    { value: 'local', label: '本地' },
    { value: 'openai', label: 'OpenAI' },
];
function getEngine() {
    const stored = localStorage.getItem(ENGINE_KEY);
    if (stored && ENGINES.some((e) => e.value === stored))
        return stored;
    return supportsWebSpeech() ? 'webspeech' : 'gemini';
}
// ── 一次性注入样式 ─────────────────────────────────────────────────────────
const STYLE_ID = 'dac-styles';
function ensureStyles() {
    if (document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
        '.dac-btn{display:inline-flex;align-items:center;justify-content:center;' +
            'width:28px;height:28px;border-radius:999px;border:none;background:transparent;' +
            'cursor:pointer;color:var(--dsw-alias-label-secondary,#888);flex:none;' +
            'position:relative;z-index:10;padding:0;transition:background-color .12s ease,color .12s ease;}' +
            '.dac-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#333);}' +
            '.dac-btn:active{transform:scale(.94)}' +
            '.dac-btn svg{width:16px;height:16px;display:block}' +
            '.dac-engine{height:26px;max-width:104px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#f5f6f8);color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:11px;line-height:1;padding:0 4px;flex:none;cursor:pointer;}' +
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
            '.dac-pop.dac-err .dac-dot{display:none}';
    document.head.appendChild(style);
}
// ── SVG 图标(自绘,通用图形元素)────────────────────────────────────────────
function iconMic() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="9" y="3" width="6" height="11" rx="3"></rect>' +
        '<path d="M5 11.5a7 7 0 0 0 14 0"></path>' +
        '<path d="M12 18.5v3"></path>' +
        '<path d="M8.5 21.5h7"></path></svg>';
}
function iconStop() {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5"></rect></svg>';
}
function iconSpinner() {
    return '<svg class="dac-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M12 3a9 9 0 1 0 9 9"></path></svg>';
}
function isEditableContent(el) {
    return el instanceof HTMLElement && el.isContentEditable;
}
function findComposer() {
    // DSH 0.1.2:composer 主输入是 contenteditable div(类名含 input,data-composer-card 内)。
    // 优先 composer 卡片内的 contenteditable,再退回 textarea。
    const card = document.querySelector('[data-composer-card]');
    if (card) {
        const editable = Array.from(card.querySelectorAll('[contenteditable="true"], [contenteditable=""]')).find((el) => el.offsetParent !== null);
        if (editable)
            return editable;
        const inCardTextarea = card.querySelector('textarea');
        if (inCardTextarea)
            return inCardTextarea;
    }
    // 全页面兜底:任意可见 contenteditable,再任意 textarea。
    const anyEditable = Array.from(document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')).find((el) => el.offsetParent !== null);
    if (anyEditable)
        return anyEditable;
    const anyTextarea = Array.from(document.querySelectorAll('textarea')).find((t) => t.offsetParent !== null);
    return anyTextarea ?? null;
}
/** 把光标放到输入元素末尾(让注入的文本落到底部)。textarea 用 setSelectionRange,
 * contenteditable 用 Selection+Range。 */
function placeCaretAtEnd(el) {
    el.focus();
    if (el instanceof HTMLTextAreaElement) {
        el.setSelectionRange(el.value.length, el.value.length);
        return;
    }
    try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    }
    catch { /* noop */ }
}
function currentText(el) {
    return el instanceof HTMLTextAreaElement ? el.value : (el.innerText ?? '');
}
function insertTextIntoComposer(composer, text) {
    const cur = currentText(composer);
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    placeCaretAtEnd(composer);
    // 模拟"粘贴"事件:构造 ClipboardEvent + DataTransfer,派发到输入框。
    // DSH 的 onPaste 收到后走它自己的 pasteBegin 路径(等价真实 Ctrl+V),
    // 是官方文本进入草稿的通道 —— 比任何直接改 DOM value 的方式都可靠。
    try {
        const dt = new DataTransfer();
        dt.setData('text/plain', sep + text);
        const evt = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt,
        });
        composer.dispatchEvent(evt);
        return;
    }
    catch {
        // 兜底:直接改文本 + dispatch input。
        const next = cur + sep + text;
        if (composer instanceof HTMLTextAreaElement) {
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), 'value');
            if (desc?.set)
                desc.set.call(composer, next);
            else
                composer.value = next;
            const tracker = composer._valueTracker;
            tracker?.setValue?.(next);
        }
        else {
            composer.innerText = next;
        }
        composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
}
// ── 按钮构建与挂载 ─────────────────────────────────────────────────────────
function makeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dac-btn';
    btn.title = '语音输入(录音转文字)';
    btn.setAttribute('aria-label', '语音输入');
    btn.setAttribute('data-state', 'idle');
    btn.innerHTML = iconMic();
    return btn;
}
// 共享的录音器引用:SPA 重渲染换按钮时,旧的录音要停掉
const shared = {
    recorder: null,
    stream: null,
    timerHandle: null,
    rec: null,
};
function stopRecording() {
    if (shared.rec) {
        try {
            shared.rec.stop();
        }
        catch { /* noop */ }
        return;
    }
    if (shared.recorder && shared.recorder.state !== 'inactive') {
        try {
            shared.recorder.stop();
        }
        catch { /* noop */ }
    }
}
function mountButton() {
    const composer = findComposer();
    if (!composer)
        return;
    const card = composer.closest('[data-composer-card]');
    if (!card)
        return;
    if (card.querySelector('[data-voice-input-mic]'))
        return;
    const btn = makeButton();
    btn.dataset.voiceInputMic = 'true';
    // 目标位置:工具栏行(row)的右侧簇(trailing),与模型选择器/发送按钮同行
    const row = Array.from(card.children).find((el) => el instanceof HTMLElement &&
        /row/.test(el.className) &&
        el.querySelector('button') !== null);
    const trailing = row?.lastElementChild instanceof HTMLElement && /trailing/.test(row.lastElementChild.className)
        ? row.lastElementChild
        : null;
    // 引擎选择下拉(Web Speech / Gemini / 智谱 / 本地 / OpenAI)
    const engineSelect = document.createElement('select');
    engineSelect.className = 'dac-engine';
    engineSelect.title = '语音输入引擎';
    engineSelect.setAttribute('aria-label', '语音输入引擎');
    for (const e of ENGINES) {
        const opt = document.createElement('option');
        opt.value = e.value;
        opt.textContent = e.label;
        engineSelect.appendChild(opt);
    }
    engineSelect.value = getEngine();
    engineSelect.addEventListener('change', () => {
        localStorage.setItem(ENGINE_KEY, engineSelect.value);
    });
    if (trailing) {
        trailing.insertBefore(btn, trailing.firstChild);
        trailing.insertBefore(engineSelect, btn);
    }
    else {
        // 兜底:挂到卡片,绝对定位右下角,永远在输入区上方
        btn.style.position = 'absolute';
        btn.style.right = '12px';
        btn.style.bottom = '48px';
        btn.style.zIndex = '50';
        card.appendChild(btn);
    }
    // 状态气泡(计时/转写/错误)
    const pop = document.createElement('div');
    pop.className = 'dac-pop';
    pop.hidden = true;
    btn.appendChild(pop);
    const popText = document.createElement('span');
    pop.appendChild(popText);
    let recording = false;
    let chunks = [];
    let elapsed = 0;
    let toastHandle = null;
    function setState(state, text) {
        recording = state === 'recording';
        btn.setAttribute('data-state', state);
        btn.innerHTML = state === 'recording' ? iconStop() : state === 'busy' ? iconSpinner() : iconMic();
        // innerHTML 重建会清掉气泡,重新拼回来
        const dot = document.createElement('span');
        dot.className = 'dac-dot';
        pop.innerHTML = '';
        pop.appendChild(dot);
        pop.appendChild(popText);
        popText.textContent = text || '';
        if (state === 'recording' || state === 'busy') {
            pop.classList.remove('dac-err');
            pop.hidden = false;
        }
        else {
            pop.hidden = true;
        }
    }
    function showToast(msg) {
        pop.classList.add('dac-err');
        popText.textContent = msg;
        pop.hidden = false;
        clearTimeout(toastHandle ?? undefined);
        toastHandle = window.setTimeout(() => { pop.hidden = true; }, 5000);
    }
    function fmtTime(s) {
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m + ':' + (r < 10 ? '0' : '') + r;
    }
    function tick() {
        elapsed += 1;
        popText.textContent = fmtTime(elapsed);
        if (elapsed >= Math.floor(MAX_RECORD_MS / 1000)) {
            stopRecording(); // 到时自动停止(onstop 里收尾)
        }
    }
    // 防止 mousedown 默认行为抢走输入框焦点(与 DSH 自带按钮的 keepFocus 一致)
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    // ── 浏览器 Web Speech API 路径(Chrome/Edge 原生,免 key,实时)──
    function startWebSpeech() {
        const w = window;
        const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
        if (!SR) {
            showToast('当前浏览器不支持 Web Speech');
            return;
        }
        if (shared.rec)
            return;
        const rec = new SR();
        shared.rec = rec;
        let finalText = '';
        rec.lang = w.__dshVoiceLang__ || 'zh-CN';
        rec.continuous = true;
        rec.interimResults = true;
        const cleanup = () => {
            if (shared.timerHandle !== null)
                clearInterval(shared.timerHandle);
            shared.rec = null;
        };
        rec.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                if (r.isFinal)
                    finalText += r[0].transcript;
                else
                    interim += r[0].transcript;
            }
            const display = (finalText + interim).trim() || fmtTime(elapsed);
            popText.textContent = display;
        };
        rec.onerror = (e) => {
            cleanup();
            setState('idle');
            showToast('语音识别错误:' + (e?.error || 'unknown'));
        };
        rec.onend = () => {
            cleanup();
            const text = finalText.trim();
            if (text) {
                const fresh = findComposer();
                if (fresh)
                    insertTextIntoComposer(fresh, text);
            }
            setState('idle');
        };
        try {
            rec.start();
            elapsed = 0;
            setState('recording', '0:00');
            if (shared.timerHandle !== null)
                clearInterval(shared.timerHandle);
            shared.timerHandle = window.setInterval(tick, 1000);
        }
        catch (err) {
            cleanup();
            setState('idle');
            showToast('语音识别启动失败:' + (err instanceof Error ? err.message : String(err)));
        }
    }
    btn.addEventListener('click', async () => {
        if (recording) {
            stopRecording();
            return;
        }
        if (shared.rec)
            return;
        // 优先浏览器原生 Web Speech(Chrome/Edge 免 key、实时);不支持时回退 MediaRecorder→host(Gemini 等)
        const engine = getEngine();
        if (engine === 'webspeech' && supportsWebSpeech()) {
            startWebSpeech();
            return;
        }
        // 否则走 MediaRecorder→服务端;engine 为 gemini/zhipu/local/openai 时随请求携带 engine 字段
        if (!navigator.mediaDevices?.getUserMedia) {
            showToast('当前环境不支持麦克风');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            chunks = [];
            shared.stream = stream;
            shared.recorder = new MediaRecorder(stream);
            const mr = shared.recorder;
            mr.ondataavailable = (e) => {
                if (e.data.size > 0)
                    chunks.push(e.data);
            };
            mr.onstop = async () => {
                if (shared.stream) {
                    shared.stream.getTracks().forEach((t) => t.stop());
                    shared.stream = null;
                }
                if (shared.timerHandle !== null)
                    clearInterval(shared.timerHandle);
                setState('busy', '转写中…');
                try {
                    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
                    const form = new FormData();
                    form.append('file', blob, 'voice.webm');
                    const engine = getEngine();
                    if (engine !== 'webspeech')
                        form.append('engine', engine);
                    const res = await fetch(TRANSCRIBE_URL, { method: 'POST', body: form });
                    const body = await res.json().catch(() => ({}));
                    if (!res.ok || typeof body?.text !== 'string') {
                        setState('idle');
                        showToast(body?.error ?? `转写失败(${res.status})`);
                        return;
                    }
                    const fresh = findComposer();
                    if (fresh) {
                        insertTextIntoComposer(fresh, body.text);
                        // 注入后验证:React 重渲染后再确认文字真的进了草稿;
                        // 失败则把转写结果亮出来(toast + 剪贴板),绝不"没动静"
                        setTimeout(() => {
                            if (currentText(fresh).indexOf(body.text) < 0) {
                                showToast(`转写完成:${body.text} (未能自动填入,已复制,可直接 Ctrl+V)`);
                                navigator.clipboard?.writeText?.(body.text).catch(() => { });
                            }
                        }, 500);
                    }
                    setState('idle');
                }
                catch (err) {
                    setState('idle');
                    showToast(err instanceof Error ? err.message : String(err));
                }
            };
            mr.start();
            elapsed = 0;
            setState('recording', '0:00');
            if (shared.timerHandle !== null)
                clearInterval(shared.timerHandle);
            shared.timerHandle = window.setInterval(tick, 1000);
        }
        catch (err) {
            showToast(`无法访问麦克风:${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
// 主入口:等 DOM 就绪后挂按钮;用 MutationObserver 应对 SPA 动态渲染
function boot() {
    ensureStyles();
    mountButton();
    const observer = new MutationObserver(() => mountButton());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('beforeunload', () => stopRecording());
}
// 挂载形态:window.__ModuleLoader__.load({ id, factory })。DSH 的 cordis
// plugin loader 会把 factory 的 return value 传给 @deepseek-ai/cordis
// registry,后者校验"必须为函数 或 含 .apply 方法的对象";否则抛
// "invalid plugin, expect function or object with an apply method, received ..."
;
window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: function (require) {
        const module = { exports: {} };
        module.exports.apply = function (ctx) {
            if (typeof window === 'undefined' || typeof document === 'undefined')
                return;
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', boot);
            }
            else {
                boot();
            }
        };
        return module.exports;
    },
});
// 供 __ModuleLoader__ 使用:无默认导出(DSH 官方规范)。
})();
