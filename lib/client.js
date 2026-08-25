"use strict";
(() => {
  // src/client.ts
  var MODULE_ID = "dsh-voice-input";
  var TRANSCRIBE_URL = "/dsh-voice-input/transcribe";
  var MAX_RECORD_MS = 28e3;
  function supportsWebSpeech() {
    const w = window;
    return typeof w.SpeechRecognition !== "undefined" || typeof w.webkitSpeechRecognition !== "undefined";
  }
  var ENGINE_KEY = "dsh-voice-input.engine";
  var ENGINES = [
    { value: "webspeech", label: "Web Speech" },
    { value: "gemini", label: "Gemini" },
    { value: "zhipu", label: "\u667A\u8C31" },
    { value: "local", label: "\u672C\u5730" },
    { value: "openai", label: "OpenAI" }
  ];
  function getEngine() {
    const stored = localStorage.getItem(ENGINE_KEY);
    if (stored && ENGINES.some((e) => e.value === stored)) return stored;
    return supportsWebSpeech() ? "webspeech" : "gemini";
  }
  var STYLE_ID = "dac-styles";
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = '.dac-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#888);flex:none;position:relative;z-index:10;padding:0;transition:background-color .12s ease,color .12s ease;}.dac-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#333);}.dac-btn:active{transform:scale(.94)}.dac-btn svg{width:16px;height:16px;display:block}.dac-engine{height:26px;max-width:104px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#f5f6f8);color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:11px;line-height:1;padding:0 4px;flex:none;cursor:pointer;}.dac-btn[data-state="recording"]{color:#e5484d}.dac-btn[data-state="recording"]:after{content:"";position:absolute;inset:-3px;border-radius:999px;border:2px solid rgba(229,72,77,.55);animation:dac-pulse 1.2s ease-out infinite}.dac-btn[data-state="busy"]{color:var(--dsw-alias-label-tertiary,#999);cursor:default}.dac-btn[data-state="busy"] .dac-spin{animation:dac-spin 1s linear infinite}@keyframes dac-pulse{0%{transform:scale(.85);opacity:1}70%{transform:scale(1.35);opacity:0}100%{opacity:0}}@keyframes dac-spin{to{transform:rotate(360deg)}}.dac-pop{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);white-space:nowrap;background:var(--dsw-specific-menu,#222);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;padding:4px 10px;font-size:12px;line-height:18px;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:60;display:flex;align-items:center;gap:6px;pointer-events:none}.dac-pop[hidden]{display:none}.dac-pop .dac-dot{width:7px;height:7px;border-radius:50%;background:#e5484d;flex:none;animation:dac-blink 1s steps(2,start) infinite}@keyframes dac-blink{50%{opacity:.3}}.dac-pop.dac-err{border-color:rgba(229,72,77,.6);color:#ff8a8d}.dac-pop.dac-err .dac-dot{display:none}';
    document.head.appendChild(style);
  }
  function iconMic() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11.5a7 7 0 0 0 14 0"></path><path d="M12 18.5v3"></path><path d="M8.5 21.5h7"></path></svg>';
  }
  function iconStop() {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.5"></rect></svg>';
  }
  function iconSpinner() {
    return '<svg class="dac-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"></path></svg>';
  }
  function findComposer() {
    const textarea = document.querySelector(
      "textarea[data-composer-card], textarea[placeholder]"
    );
    if (textarea) return textarea;
    const anyArea = Array.from(document.querySelectorAll("textarea")).find(
      (t) => t.offsetParent !== null
    );
    return anyArea ?? null;
  }
  function insertTextIntoComposer(composer, text) {
    const sep = composer.value && !composer.value.endsWith("\n") ? "\n" : "";
    composer.focus();
    try {
      composer.setSelectionRange(composer.value.length, composer.value.length);
      const dt = new DataTransfer();
      dt.setData("text/plain", sep + text);
      const evt = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      composer.dispatchEvent(evt);
      return;
    } catch {
      const next = composer.value + sep + text;
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value");
      if (desc?.set) desc.set.call(composer, next);
      else composer.value = next;
      const tracker = composer._valueTracker;
      tracker?.setValue?.(next);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  function makeButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dac-btn";
    btn.title = "\u8BED\u97F3\u8F93\u5165(\u5F55\u97F3\u8F6C\u6587\u5B57)";
    btn.setAttribute("aria-label", "\u8BED\u97F3\u8F93\u5165");
    btn.setAttribute("data-state", "idle");
    btn.innerHTML = iconMic();
    return btn;
  }
  var shared = {
    recorder: null,
    stream: null,
    timerHandle: null,
    rec: null
  };
  function stopRecording() {
    if (shared.rec) {
      try {
        shared.rec.stop();
      } catch {
      }
      return;
    }
    if (shared.recorder && shared.recorder.state !== "inactive") {
      try {
        shared.recorder.stop();
      } catch {
      }
    }
  }
  function mountButton() {
    const composer = findComposer();
    if (!composer) return;
    const card = composer.closest("[data-composer-card]");
    if (!card) return;
    if (card.querySelector("[data-voice-input-mic]")) return;
    const btn = makeButton();
    btn.dataset.voiceInputMic = "true";
    const row = Array.from(card.children).find(
      (el) => el instanceof HTMLElement && /row/.test(el.className) && el.querySelector("button") !== null
    );
    const trailing = row?.lastElementChild instanceof HTMLElement && /trailing/.test(row.lastElementChild.className) ? row.lastElementChild : null;
    const engineSelect = document.createElement("select");
    engineSelect.className = "dac-engine";
    engineSelect.title = "\u8BED\u97F3\u8F93\u5165\u5F15\u64CE";
    engineSelect.setAttribute("aria-label", "\u8BED\u97F3\u8F93\u5165\u5F15\u64CE");
    for (const e of ENGINES) {
      const opt = document.createElement("option");
      opt.value = e.value;
      opt.textContent = e.label;
      engineSelect.appendChild(opt);
    }
    engineSelect.value = getEngine();
    engineSelect.addEventListener("change", () => {
      localStorage.setItem(ENGINE_KEY, engineSelect.value);
    });
    if (trailing) {
      trailing.insertBefore(btn, trailing.firstChild);
      trailing.insertBefore(engineSelect, btn);
    } else {
      btn.style.position = "absolute";
      btn.style.right = "12px";
      btn.style.bottom = "48px";
      btn.style.zIndex = "50";
      card.appendChild(btn);
    }
    const pop = document.createElement("div");
    pop.className = "dac-pop";
    pop.hidden = true;
    btn.appendChild(pop);
    const popText = document.createElement("span");
    pop.appendChild(popText);
    let recording = false;
    let chunks = [];
    let elapsed = 0;
    let toastHandle = null;
    function setState(state, text) {
      recording = state === "recording";
      btn.setAttribute("data-state", state);
      btn.innerHTML = state === "recording" ? iconStop() : state === "busy" ? iconSpinner() : iconMic();
      const dot = document.createElement("span");
      dot.className = "dac-dot";
      pop.innerHTML = "";
      pop.appendChild(dot);
      pop.appendChild(popText);
      popText.textContent = text || "";
      if (state === "recording" || state === "busy") {
        pop.classList.remove("dac-err");
        pop.hidden = false;
      } else {
        pop.hidden = true;
      }
    }
    function showToast(msg) {
      pop.classList.add("dac-err");
      popText.textContent = msg;
      pop.hidden = false;
      clearTimeout(toastHandle ?? void 0);
      toastHandle = window.setTimeout(() => {
        pop.hidden = true;
      }, 5e3);
    }
    function fmtTime(s) {
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m + ":" + (r < 10 ? "0" : "") + r;
    }
    function tick() {
      elapsed += 1;
      popText.textContent = fmtTime(elapsed);
      if (elapsed >= Math.floor(MAX_RECORD_MS / 1e3)) {
        stopRecording();
      }
    }
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    function startWebSpeech() {
      const w = window;
      const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
      if (!SR) {
        showToast("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301 Web Speech");
        return;
      }
      if (shared.rec) return;
      const rec = new SR();
      shared.rec = rec;
      let finalText = "";
      rec.lang = w.__dshVoiceLang__ || "zh-CN";
      rec.continuous = true;
      rec.interimResults = true;
      const cleanup = () => {
        if (shared.timerHandle !== null) clearInterval(shared.timerHandle);
        shared.rec = null;
      };
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        const display = (finalText + interim).trim() || fmtTime(elapsed);
        popText.textContent = display;
      };
      rec.onerror = (e) => {
        cleanup();
        setState("idle");
        showToast("\u8BED\u97F3\u8BC6\u522B\u9519\u8BEF:" + (e?.error || "unknown"));
      };
      rec.onend = () => {
        cleanup();
        const text = finalText.trim();
        if (text) {
          const fresh = findComposer();
          if (fresh) insertTextIntoComposer(fresh, text);
        }
        setState("idle");
      };
      try {
        rec.start();
        elapsed = 0;
        setState("recording", "0:00");
        if (shared.timerHandle !== null) clearInterval(shared.timerHandle);
        shared.timerHandle = window.setInterval(tick, 1e3);
      } catch (err) {
        cleanup();
        setState("idle");
        showToast("\u8BED\u97F3\u8BC6\u522B\u542F\u52A8\u5931\u8D25:" + (err instanceof Error ? err.message : String(err)));
      }
    }
    btn.addEventListener("click", async () => {
      if (recording) {
        stopRecording();
        return;
      }
      if (shared.rec) return;
      const engine = getEngine();
      if (engine === "webspeech" && supportsWebSpeech()) {
        startWebSpeech();
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        showToast("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u9EA6\u514B\u98CE");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        shared.stream = stream;
        shared.recorder = new MediaRecorder(stream);
        const mr = shared.recorder;
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        mr.onstop = async () => {
          if (shared.stream) {
            shared.stream.getTracks().forEach((t) => t.stop());
            shared.stream = null;
          }
          if (shared.timerHandle !== null) clearInterval(shared.timerHandle);
          setState("busy", "\u8F6C\u5199\u4E2D\u2026");
          try {
            const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
            const form = new FormData();
            form.append("file", blob, "voice.webm");
            const engine2 = getEngine();
            if (engine2 !== "webspeech") form.append("engine", engine2);
            const res = await fetch(TRANSCRIBE_URL, { method: "POST", body: form });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || typeof body?.text !== "string") {
              setState("idle");
              showToast(body?.error ?? `\u8F6C\u5199\u5931\u8D25(${res.status})`);
              return;
            }
            const fresh = findComposer();
            if (fresh) {
              insertTextIntoComposer(fresh, body.text);
              setTimeout(() => {
                if (fresh.value.indexOf(body.text) < 0) {
                  showToast(`\u8F6C\u5199\u5B8C\u6210:${body.text} (\u672A\u80FD\u81EA\u52A8\u586B\u5165,\u5DF2\u590D\u5236,\u53EF\u76F4\u63A5 Ctrl+V)`);
                  navigator.clipboard?.writeText?.(body.text).catch(() => {
                  });
                }
              }, 500);
            }
            setState("idle");
          } catch (err) {
            setState("idle");
            showToast(err instanceof Error ? err.message : String(err));
          }
        };
        mr.start();
        elapsed = 0;
        setState("recording", "0:00");
        if (shared.timerHandle !== null) clearInterval(shared.timerHandle);
        shared.timerHandle = window.setInterval(tick, 1e3);
      } catch (err) {
        showToast(`\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE:${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
  function boot() {
    ensureStyles();
    mountButton();
    const observer = new MutationObserver(() => mountButton());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("beforeunload", () => stopRecording());
  }
  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: function(require2) {
      const module = { exports: {} };
      module.exports.apply = function(ctx) {
        if (typeof window === "undefined" || typeof document === "undefined") return;
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", boot);
        } else {
          boot();
        }
      };
      return module.exports;
    }
  });
})();
