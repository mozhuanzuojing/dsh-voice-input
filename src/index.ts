// dsh-audio-copilot — 语音工作台:给纯文本模型补上"听"和"说"的能力。
//
// 工具:
//   audio_probe       用 ffprobe 读音频元数据(容器/时长/编码/声道)
//   audio_transcribe  音频/录音 → 文字(OpenAI 兼容 /audio/transcriptions 端点,可配智谱/Whisper/SenseVoice)
//   audio_tts         文字 → 语音文件(默认 Windows 本地 SAPI 免 key;可选 Edge TTS 或 OpenAI 兼容端点)
//   audio_ask         带时间锚定的音频问答(转写 + 关键词定位)
//
// 设计原则(对齐 DSH 官方规范):
//   1. 一切可调值都进 Config schema,不硬编码。
//   2. TTS 三引擎可插拔:sapi(本地免费)/ edge(微软在线)/ openai(任意兼容端点)。
//   3. ASR 为 OpenAI 兼容端点,可配,不锁定厂商。
//   4. 失败要大声:缺 key / 缺 ffmpeg / 端点错误都给可操作的错误信息。
//   5. 注册是 effect:ctx.tools.register() 返回 disposer,卸载自动注销。
//   6. 纯 ESM;@deepseek-ai/cordis 仅类型导入(编译期擦除)。
//
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const execFileAsync = promisify(execFile)

// ── 插件身份与依赖 ─────────────────────────────────────────────────────────

export const name = 'audio-copilot'

// 必须等 webServer 就绪才能注册 /audio-copilot/transcribe 路由:
// 之前只 inject 'tools',apply 时 ctx.get('webServer') 返回 undefined,
// 路由注册被静默跳过(浏览器 405/SPA fallback),按钮点击转写必然失败。
export const inject = ['tools', 'webServer']

// ── 配置 schema ─────────────────────────────────────────────────────────────

export interface Config {
  // ASR 引擎:gemini(多模态,直接吃 webm/wav/mp3,免费,默认)/
  //   zhipu(智谱 glm-asr-2512,需余额)/ openai(任意 OpenAI 兼容 /audio/transcriptions)
  asrEngine: 'gemini' | 'zhipu' | 'openai' | 'local'
  // zhipu / openai 引擎共用
  asrBaseUrl: string
  asrModel: string
  asrApiKeyEnv: string
  // gemini 引擎(多模态)
  geminiApiKeyEnv: string
  geminiModel: string
  geminiBaseUrl: string
  geminiProxy: string
  // TTS(文字转语音)——引擎选择
  ttsEngine: 'sapi' | 'edge' | 'openai'
  ttsBaseUrl: string
  ttsModel: string
  ttsApiKeyEnv: string
  ttsVoice: string
  // 行为参数
  maxAudioBytes: number
  transcribeTimeoutMs: number
  ttsTimeoutMs: number
  maxSegments: number
  // 本地 ASR(faster-whisper)
  localAsrRoot: string
  localAsrModel: string
  localAsrThreads: number
  localAsrLanguage: string
  localAsrPrompt: string
}

export const Config: Schema<Config> = Schema.object({
  asrEngine: Schema.union(['gemini', 'zhipu', 'openai', 'local']).default('gemini'),
  asrBaseUrl: Schema.string().default('https://open.bigmodel.cn/api/paas/v4'),
  asrModel: Schema.string().default('glm-asr-2512'),
  asrApiKeyEnv: Schema.string().default('ZHIPU_API_KEY'),
  geminiApiKeyEnv: Schema.string().default('GEMINI_API_KEY'),
  geminiModel: Schema.string().default('gemini-3.6-flash'),
  geminiBaseUrl: Schema.string().default('https://generativelanguage.googleapis.com'),
  geminiProxy: Schema.string().default('http://127.0.0.1:7890'),
  // 本地 ASR(faster-whisper 离线转写,免费无限用,不依赖 API 额度):
  // transcribe.py 位于 localAsrRoot;模型首次使用自动下载(缓存于 ~/.cache/huggingface)
  // localAsrPrompt:专有名词/术语提示(逗号分隔),显著提升 DeepSeek 等词识别率
  localAsrRoot: Schema.string().default('C:/Users/Admin/ss/DSH_UPGRADE/local-asr'),
  localAsrModel: Schema.string().default('medium'),
  localAsrThreads: Schema.number().default(4),
  localAsrLanguage: Schema.string().default(''),
  localAsrPrompt: Schema.string().default('DeepSeek, DSH, 智能体, Flash, V4, 语音, 转写'),
  ttsEngine: Schema.union(['sapi', 'edge', 'openai']).default('sapi'),
  ttsBaseUrl: Schema.string().default('https://open.bigmodel.cn/api/paas/v4'),
  ttsModel: Schema.string().default('glm-tts'),
  ttsApiKeyEnv: Schema.string().default('ZHIPU_API_KEY'),
  ttsVoice: Schema.string().default('Microsoft Huihui Desktop'),
  maxAudioBytes: Schema.number().default(25 * 1024 * 1024),
  transcribeTimeoutMs: Schema.number().default(120_000),
  ttsTimeoutMs: Schema.number().default(90_000),
  maxSegments: Schema.number().default(20),
})

// ── 小工具 ──────────────────────────────────────────────────────────────────

async function assertReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function assertSafePath(path: string) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('path must be a non-empty string')
  if (basename(path).startsWith('-')) throw new Error(`path basename must not start with '-': ${path}`)
}

function toolError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { name?: string }
  if (e?.code === 'ENOENT') {
    return 'ERROR: ffprobe/ffmpeg not found on PATH, or the audio file does not exist.'
  }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `ERROR: operation timed out or was cancelled: ${e.message}`
  }
  return `ERROR: ${e instanceof Error ? e.message : String(err)}`
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

function guessAudioMime(path: string): string {
  const ext = basename(path).split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'm4a': return 'audio/mp4'
    case 'aac': return 'audio/aac'
    case 'ogg': return 'audio/ogg'
    case 'flac': return 'audio/flac'
    case 'webm': return 'audio/webm'
    default: return 'audio/mpeg'
  }
}

// ── ffprobe 元数据 ──────────────────────────────────────────────────────────

async function probeAudio(path: string): Promise<any> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
  ], { maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(stdout)
}

function summarizeProbe(probe: any) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : []
  const audio = streams.filter((s: any) => s.codec_type === 'audio')
  return {
    container: probe?.format?.format_name ?? 'unknown',
    durationSec: probe?.format?.duration != null ? Math.round(Number(probe.format.duration) * 100) / 100 : null,
    sizeBytes: probe?.format?.size != null ? Number(probe.format.size) : null,
    audioStreams: audio.map((s: any) => ({
      codec: s.codec_name,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
      channels: s.channels ?? null,
      bitRate: s.bit_rate ? Number(s.bit_rate) : null,
    })),
  }
}

// ── ASR:三引擎(gemini 多模态默认 / zhipu / openai 兼容)──────────────────

/**
 * gemini 引擎:多模态模型直接吃音频(webm/wav/mp3 皆可),免费额度,走 generateContent。
 *
 * 实现说明:用系统 curl.exe 子进程而非 undici ProxyAgent —— 在 DSH 进程内
 * 动态 import('undici') 的 dispatcher 与运行时 fetch 存在兼容问题(实测
 * "fetch failed");curl 是本机自带、与 TTS 的 powershell 子进程同模式,
 * 且经本机 Clash 代理直连 Gemini 实测 200。
 */
async function transcribeGemini(config: Config, path: string, signal?: AbortSignal) {
  const key = process.env[config.geminiApiKeyEnv]
  if (!key) {
    throw new Error(
      `Gemini API key not set. Export ${config.geminiApiKeyEnv} with a key, ` +
      `or set asrEngine to 'zhipu'/'openai' with the matching key env.`,
    )
  }
  const timeoutSignal = AbortSignal.timeout(config.transcribeTimeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const bytes = await readFile(path)
  const mime = guessAudioMime(path)
  const body = JSON.stringify({
    contents: [{
      parts: [
        { inline_data: { mime_type: mime, data: bytes.toString('base64') } },
        { text: '请把这段语音完整转写成文字，只输出转写结果，不要任何解释。' },
      ],
    }],
  })
  const tmpJson = join(tmpdir(), `dsh-gemini-${Date.now()}.json`)
  await writeFile(tmpJson, body, 'utf8')
  try {
    const url = `${joinUrl(config.geminiBaseUrl, '')}/v1beta/models/${config.geminiModel}:generateContent?key=${encodeURIComponent(key)}`
    const proxy = config.geminiProxy || process.env.HTTPS_PROXY || process.env.http_proxy || ''
    const mkArgs = () => {
      const args = [
        '-sS', '-w', '\n%{http_code}', '-X', 'POST', url,
        '-H', 'content-type: application/json',
        '--data', `@${tmpJson}`,
        '--max-time', String(Math.max(30, Math.floor(config.transcribeTimeoutMs / 1000))),
      ]
      if (proxy) args.push('--proxy', proxy)
      return args
    }
    // Gemini 免费额度会 429 限流(提示 "Please retry in Ns"):等待后重试一次
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const { stdout } = await execFileAsync('curl.exe', mkArgs(), { signal: signalAll, maxBuffer: 8 * 1024 * 1024 })
      const lines = stdout.trimEnd().split('\n')
      const status = Number(lines.pop())
      const out = lines.join('\n')
      if (status === 200) {
        const data: any = JSON.parse(out)
        const text = Array.isArray(data?.candidates?.[0]?.content?.parts)
          ? data.candidates[0].content.parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
          : ''
        if (!text) throw new Error(`Gemini ASR returned no text: ${JSON.stringify(data).slice(0, 500)}`)
        return { text, language: null }
      }
      if (status === 429 && attempt === 0) {
        const m = /retry in ([\d.]+)s/i.exec(out)
        const waitMs = m ? Math.min(Math.ceil(Number(m[1]) * 1000) + 800, 20000) : 6000
        lastError = new Error(`Gemini 免费额度繁忙(429),等待 ${Math.round(waitMs / 1000)}s 后重试`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      throw new Error(`Gemini ASR HTTP ${status}: ${out.slice(0, 500)}`)
    }
    throw lastError ?? new Error('Gemini ASR failed')
  } finally {
    await rm(tmpJson).catch(() => {})
  }
}

/**
 * 本地 ASR:faster-whisper 离线转写(免费无限用,不依赖 API 额度/网络)。
 * 调用 localAsrRoot/transcribe.py(faster-whisper, CPU int8),模型自动下载缓存;
 * 支持任意 ffmpeg 可解音频(webm/mp3/wav...),自动多语言识别,可指定语言。
 */
async function transcribeLocal(config: Config, path: string, signal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(config.transcribeTimeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const script = join(config.localAsrRoot, 'transcribe.py')
  if (!(await assertReadable(script))) {
    throw new Error(
      `本地 ASR 未部署:找不到 ${script}。请先安装 faster-whisper 并放置 transcribe.py` +
      `(见 DSH_UPGRADE/local-asr 部署说明),或把 asrEngine 切回 'gemini'/'zhipu'。`,
    )
  }
  const args = [
    script,
    path,
    config.localAsrModel,
    String(Math.max(1, Math.min(16, config.localAsrThreads))),
  ]
  if (config.localAsrLanguage) args.push(config.localAsrLanguage)
  if (config.localAsrPrompt) args.push(config.localAsrPrompt)
  try {
    const { stdout } = await execFileAsync('python', args, {
      signal: signalAll,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    })
    const text = stdout.trim().split('\n').pop()?.trim() ?? ''
    if (!text || /^ERROR:/.test(text)) {
      throw new Error(`本地 ASR 失败:${text || '无输出'}`)
    }
    return { text, language: null }
  } catch (err: any) {
    const stderr = err?.stderr ? String(err.stderr).trim() : ''
    if (stderr) throw new Error(`本地 ASR 失败:${stderr.slice(0, 400)}`)
    throw err
  }
}

async function transcribeAudio(config: Config, path: string, signal?: AbortSignal) {
  if (config.asrEngine === 'local') return transcribeLocal(config, path, signal)
  if (config.asrEngine === 'gemini') return transcribeGemini(config, path, signal)
  // zhipu / openai:OpenAI 兼容 /audio/transcriptions
  const key = process.env[config.asrApiKeyEnv]
  if (!key) {
    throw new Error(
      `ASR API key not set. Export ${config.asrApiKeyEnv} with a key for ${config.asrBaseUrl} ` +
      `(model: ${config.asrModel}), or point asrBaseUrl/asrModel at any OpenAI-compatible ` +
      `/audio/transcriptions endpoint (e.g. Whisper, SenseVoice).`,
    )
  }
  const timeoutSignal = AbortSignal.timeout(config.transcribeTimeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  // zhipu 引擎:智谱拒绝 webm(实测错误 1214),需先转 16kHz wav 再上传
  let uploadPath = path
  let tmpWav = ''
  if (config.asrEngine === 'zhipu' && !/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(path)) {
    tmpWav = join(tmpdir(), `dsh-zhipu-${Date.now()}.wav`)
    await execFileAsync('ffmpeg', ['-y', '-i', path, '-ar', '16000', '-ac', '1', tmpWav], {
      signal: signalAll,
      maxBuffer: 8 * 1024 * 1024,
    })
    uploadPath = tmpWav
  }
  const bytes = await readFile(uploadPath)
  const mime = tmpWav ? 'audio/wav' : guessAudioMime(path)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), tmpWav ? 'voice.wav' : basename(path))
  form.append('model', config.asrModel)
  form.append('response_format', 'json')

  try {
    const res = await fetch(joinUrl(config.asrBaseUrl, '/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: signalAll,
    })
    if (!res.ok) throw new Error(`ASR HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const body: any = await res.json()
    const text = typeof body?.text === 'string' ? body.text : ''
    if (!text) throw new Error(`ASR returned no text: ${JSON.stringify(body).slice(0, 500)}`)
    return { text, language: body.language }
  } finally {
    if (tmpWav) await rm(tmpWav).catch(() => {})
  }
}

// ── TTS 三引擎 ──────────────────────────────────────────────────────────────

// 引擎 1:sapi —— Windows 本地语音,零依赖免 key(默认)
async function ttsSapi(text: string, outFile: string, voice: string, timeoutMs: number): Promise<void> {
  const psScript =
    `Add-Type -AssemblyName System.Speech; ` +
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `try { $s.SelectVoice('${voice.replace(/'/g, "''")}') } catch {} ` +
    `$s.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}'); ` +
    `$s.Speak(${JSON.stringify(text)}); ` +
    `$s.Dispose()`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number }
    if (e?.status === 1) {
      throw new Error('Windows SAPI TTS failed. Try a different ttsVoice (see "Microsoft Huihui Desktop" / "Microsoft Zira Desktop"), or switch ttsEngine to edge/openai.')
    }
    throw err
  }
}

// 引擎 2:edge —— 微软在线 TTS(免 key,依赖网络可达 speech.platform.bing.com)
async function ttsEdge(config: Config, text: string, outFile: string, signal?: AbortSignal): Promise<void> {
  const { default: WebSocket } = await import('ws')
  const token = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${token}&ConnectionId=${crypto.randomUUID().replaceAll('-', '')}`
  const audioChunks: Buffer[] = []

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, {
      host: 'speech.platform.bing.com',
      origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.66 Safari/537.36 Edg/103.0.1264.44' },
    })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`edge-tts timed out after ${config.ttsTimeoutMs}ms`))
    }, config.ttsTimeoutMs)
    const done = (err?: Error) => {
      clearTimeout(timer)
      if (err) { ws.terminate(); reject(err) }
      else { ws.close(); resolve() }
    }
    ws.on('message', (raw: Buffer | string, isBinary: boolean) => {
      if (!isBinary) {
        const data = raw.toString('utf8')
        if (data.includes('turn.end')) done()
        return
      }
      const separator = 'Path:audio\r\n'
      const idx = (raw as Buffer).indexOf(separator)
      if (idx >= 0) audioChunks.push((raw as Buffer).subarray(idx + separator.length))
    })
    ws.on('error', (e: Error) => done(e))
    ws.on('open', () => {
      const speechConfig = JSON.stringify({ context: { synthesis: { audio: {
        metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      } } } })
      ws.send(`X-Timestamp:${new Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`, { compress: true })
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${config.ttsVoice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
      ws.send(`X-RequestId:${crypto.randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${ssml}`, { compress: true })
    })
    if (signal) {
      signal.addEventListener('abort', () => done(new Error('cancelled')), { once: true })
    }
  })

  await writeFile(outFile, Buffer.concat(audioChunks))
}

// 引擎 3:openai —— 任意 OpenAI 兼容 /audio/speech 端点
async function ttsOpenAI(config: Config, text: string, outFile: string, signal?: AbortSignal): Promise<void> {
  const key = process.env[config.ttsApiKeyEnv]
  if (!key) {
    throw new Error(
      `TTS API key not set. Export ${config.ttsApiKeyEnv} with a key for ${config.ttsBaseUrl} ` +
      `(model: ${config.ttsModel}), or switch ttsEngine to 'sapi' (local, free, no key).`,
    )
  }
  const timeoutSignal = AbortSignal.timeout(config.ttsTimeoutMs)
  const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const res = await fetch(joinUrl(config.ttsBaseUrl, '/audio/speech'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: config.ttsModel, input: text, voice: config.ttsVoice }),
    signal: signalAll,
  })
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  await writeFile(outFile, Buffer.from(await res.arrayBuffer()))
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ── 时间锚定问答:转写 + 关键词定位 ─────────────────────────────────────────

function splitSegments(text: string, maxLen = 120): { start: number; text: string }[] {
  const sentences = text
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const segments: { start: number; text: string }[] = []
  let cursor = 0
  for (const sentence of sentences) {
    segments.push({ start: cursor, text: sentence.slice(0, maxLen) })
    cursor += Math.max(1, sentence.length) * 0.35
  }
  return segments
}

function matchSegments(
  segments: { start: number; text: string }[],
  terms: string[],
  limit: number,
): { start: number; text: string; score: number }[] {
  return segments
    .map((seg) => {
      const lower = seg.text.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (lower.includes(term.toLowerCase())) score += term.length
      }
      return { ...seg, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// ── 工具注册 ────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config) {
  // 1) audio_probe —— 元数据
  ctx.tools.register(defineTool({
    name: 'audio_probe',
    description:
      'Inspect a local audio file and return its metadata as JSON: container, duration, ' +
      'codec, sample rate, channels. Use this first when asked anything about an audio file.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the audio file (mp3, wav, m4a, aac, ogg, flac, ...)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        assertSafePath(args.path)
      } catch (err) {
        return toolError(err)
      }
      if (!(await assertReadable(args.path))) return `ERROR: file not found or not readable: ${args.path}`
      try {
        return JSON.stringify(summarizeProbe(await probeAudio(args.path)), null, 2)
      } catch (err) {
        return toolError(err)
      }
    },
  }))

  // 2) audio_transcribe —— 语音转文字
  ctx.tools.register(defineTool({
    name: 'audio_transcribe',
    description:
      'Transcribe speech from a local audio file into text via an OpenAI-compatible ASR endpoint ' +
      '(e.g. Whisper, SenseVoice, GLM-ASR). Returns the transcript text and detected language. ' +
      'Use when the user provides a recording, voice memo, or audio file and wants its content as text.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the audio file',
      },
      language: {
        type: 'string',
        description: 'Optional language hint (e.g. "zh", "en"). Leave unset for auto-detect.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        assertSafePath(args.path)
      } catch (err) {
        return toolError(err)
      }
      if (!(await assertReadable(args.path))) return `ERROR: file not found or not readable: ${args.path}`
      const size = await stat(args.path).then((s) => s.size).catch(() => 0)
      if (size > config.maxAudioBytes) {
        return `ERROR: audio file is ${size} bytes, exceeding maxAudioBytes=${config.maxAudioBytes}.`
      }
      try {
        return JSON.stringify(await transcribeAudio(config, args.path, exec?.signal), null, 2)
      } catch (err) {
        return toolError(err)
      }
    },
  }))

  // 3) audio_tts —— 文字转语音(默认 Windows 本地 SAPI,免 key)
  ctx.tools.register(defineTool({
    name: 'audio_tts',
    description:
      'Synthesize speech from text into an audio file. Default engine is Windows local SAPI ' +
      '(free, offline, no API key); can switch to edge (Microsoft online) or any OpenAI-compatible ' +
      '/audio/speech endpoint via config. Returns the output file path.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'Text to synthesize into speech',
      },
      outputPath: {
        type: 'string',
        description: 'Absolute output path for the audio file (default: a temp file)',
      },
      voice: {
        type: 'string',
        description: 'Override voice (sapi: e.g. "Microsoft Huihui Desktop" zh-CN, "Microsoft Zira Desktop" en-US; edge/openai: endpoint-specific)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const voice = args.voice ?? config.ttsVoice
      const ext = config.ttsEngine === 'sapi' ? '.wav' : '.mp3'
      const outFile = args.outputPath ?? join(tmpdir(), `dsh-tts-${Date.now()}${ext}`)
      const effective = { ...config, ttsVoice: voice }
      try {
        if (config.ttsEngine === 'sapi') await ttsSapi(args.text, outFile, voice, config.ttsTimeoutMs)
        else if (config.ttsEngine === 'edge') await ttsEdge(effective, args.text, outFile, exec?.signal)
        else await ttsOpenAI(effective, args.text, outFile, exec?.signal)
        const size = await stat(outFile).then((s) => s.size)
        return JSON.stringify({ outputPath: outFile, bytes: size, engine: config.ttsEngine, voice }, null, 2)
      } catch (err) {
        return toolError(err)
      }
    },
  }))

  // 4) audio_ask —— 带时间锚定的音频问答
  ctx.tools.register(defineTool({
    name: 'audio_ask',
    description:
      'Answer a question about a local audio file with time-anchored evidence. Transcribes the audio, ' +
      'locates transcript segments matching the question, and returns matched segments with estimated ' +
      'timestamps plus the full transcript. Use for "what was said about X" or "when did they mention Y" questions.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the audio file',
      },
      question: {
        type: 'string',
        required: true,
        description: 'The question to answer from the audio content',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        assertSafePath(args.path)
      } catch (err) {
        return toolError(err)
      }
      if (!(await assertReadable(args.path))) return `ERROR: file not found or not readable: ${args.path}`
      try {
        const { text } = await transcribeAudio(config, args.path, exec?.signal)
        const segments = splitSegments(text)
        const terms = args.question.split(/\s+/).filter((t) => t.length >= 2).slice(0, 8)
        const matched = matchSegments(segments, terms, config.maxSegments)
        return JSON.stringify({
          transcript: text,
          matchedSegments: matched,
          note: 'Timestamps are estimates derived from character counts (~0.35s per char); use audio_probe for precise duration.',
        }, null, 2)
      } catch (err) {
        return toolError(err)
      }
    },
  }))

  // ── host 半:语音输入按钮的转写路由 ────────────────────────────────────
  // POST /audio-copilot/transcribe —— 接收浏览器麦克风录制的音频 blob,
  // 存临时文件 → 调 ASR → 返回 { text }。客户端(浏览器)由此拿到文字并填入输入框。
  const webserver = ctx.get('webServer') as { register: (route: { kind: string; path: string; handler: (req: any, res: any) => void | Promise<void> }) => (() => void) } | undefined
  if (webserver) {
    const disposer = webserver.register({
      kind: 'exact',
      path: '/audio-copilot/transcribe',
      handler: async (req: any, res: any) => {
        try {
          // 读请求体为 Buffer(浏览器 FormData 的 file 字段)
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          const body = Buffer.concat(chunks)

          // 解析 multipart:取 file 字段
          const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers?.['content-type'] ?? '')?.[1] ?? (req.headers?.['content-type'] ?? '').split('boundary=')[1]?.trim()
          if (!boundary) return send(res, 400, { error: 'missing multipart boundary' })
          const parts = parseMultipart(body, boundary)

          // 优先取 file 字段;否则整体当裸音频
          const fileField = parts.find((p) => p.name === 'file')
          const audioBytes = fileField ? fileField.data : body

          // 引擎密钥检查(按引擎区分,给可操作报错)
          const key = config.asrEngine === 'gemini'
            ? process.env[config.geminiApiKeyEnv]
            : process.env[config.asrApiKeyEnv]
          if (!key) {
            const envName = config.asrEngine === 'gemini' ? config.geminiApiKeyEnv : config.asrApiKeyEnv
            return send(res, 400, { error: `ASR key ${envName} not set` })
          }
          if (audioBytes.length > config.maxAudioBytes) return send(res, 413, { error: 'audio too large' })

          // 写临时文件转写:保留上传文件的扩展名(浏览器录音是 .webm,智谱只收 .wav/.mp3,
          // Gemini 多模态都收;扩展名错误会让部分端点直接拒格式)
          const fname = fileField?.filename ?? ''
          const ext = fname.includes('.') ? `.${fname.split('.').pop()}` : '.webm'
          const tmp = join(tmpdir(), `dsh-voice-${Date.now()}${ext}`)
          await writeFile(tmp, audioBytes)
          try {
            const result = await transcribeAudio(config, tmp)
            send(res, 200, { text: result.text, language: result.language ?? null })
          } finally {
            await rm(tmp).catch(() => {})
          }
        } catch (err) {
          send(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      },
    })
    ctx.effect(() => disposer)
  }

  console.log(
    `[audio-copilot] registered audio_probe / audio_transcribe / audio_tts / audio_ask ` +
    `(ASR=${config.asrEngine}${config.asrEngine === 'gemini' ? `:${config.geminiModel}` : `:${config.asrModel}@${config.asrBaseUrl}`}, TTS=${config.ttsEngine})`,
  )
}

// ── multipart 解析 + HTTP 响应辅助 ─────────────────────────────────────────

interface MultipartPart {
  name: string
  filename?: string
  data: Buffer
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: MultipartPart[] = []
  let pos = 0
  while (true) {
    const start = body.indexOf(delimiter, pos)
    if (start < 0) break
    const lineEnd = body.indexOf(Buffer.from('\r\n'), start)
    if (lineEnd < 0) break
    let cursor = lineEnd + 2
    // headers
    let name = ''
    let filename: string | undefined
    while (true) {
      const headerEnd = body.indexOf(Buffer.from('\r\n'), cursor)
      if (headerEnd < 0 || headerEnd === cursor) break
      const headerLine = body.subarray(cursor, headerEnd).toString('utf8')
      const nameMatch = /name="([^"]*)"/.exec(headerLine)
      if (nameMatch) name = nameMatch[1]
      const fileMatch = /filename="([^"]*)"/.exec(headerLine)
      if (fileMatch) filename = fileMatch[1]
      cursor = headerEnd + 2
    }
    cursor += 2 // blank line
    const nextDelim = body.indexOf(delimiter, cursor)
    if (nextDelim < 0) break
    const data = body.subarray(cursor, nextDelim - 2) // strip trailing \r\n
    if (name) parts.push({ name, filename, data })
    pos = nextDelim
  }
  return parts
}

function send(res: any, status: number, payload: unknown) {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}
