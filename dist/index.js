import Schema from '@deepseek-ai/schemastery';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
const execFileAsync = promisify(execFile);
// ── 插件身份与依赖 ─────────────────────────────────────────────────────────
export const name = 'dsh-voice-input';
// 必须等 webServer 就绪才能注册 /dsh-voice-input/transcribe 路由:
// 之前只 inject 'tools',apply 时 ctx.get('webServer') 返回 undefined,
// 路由注册被静默跳过(浏览器 405/SPA fallback),按钮点击转写必然失败。
export const inject = ['tools', 'webServer'];
export const Config = Schema.object({
    asrEngine: Schema.union(['gemini', 'zhipu', 'openai', 'local']).default('gemini'),
    asrBaseUrl: Schema.string().default('https://open.bigmodel.cn/api/paas/v4'),
    asrModel: Schema.string().default('glm-asr-2512'),
    asrApiKeyEnv: Schema.string().default('ZHIPU_API_KEY'),
    geminiApiKeyEnv: Schema.string().default('GEMINI_API_KEY'),
    geminiModel: Schema.string().default('gemini-2.5-flash'),
    geminiBaseUrl: Schema.string().default('https://generativelanguage.googleapis.com'),
    // 留空时自动回退到 process.env.HTTPS_PROXY / http_proxy；本机走 9910 美国节点。
    geminiProxy: Schema.string().default(''),
    // 本地 ASR(faster-whisper 离线转写,免费无限用,不依赖 API 额度):
    // transcribe.py 位于 localAsrRoot;模型首次使用自动下载(缓存于 ~/.cache/huggingface)
    // localAsrPrompt:专有名词/术语提示(逗号分隔),显著提升 DeepSeek 等词识别率
    localAsrRoot: Schema.string().default('C:/Users/Admin/ss/DSH_UPGRADE/local-asr'),
    localAsrModel: Schema.string().default('medium'),
    localAsrThreads: Schema.number().default(4),
    localAsrLanguage: Schema.string().default(''),
    localAsrPrompt: Schema.string().default('DeepSeek, DSH, 智能体, Flash, V4, 语音, 转写'),
    maxAudioBytes: Schema.number().default(25 * 1024 * 1024),
    transcribeTimeoutMs: Schema.number().default(120_000),
});
// ── 小工具 ──────────────────────────────────────────────────────────────────
async function assertReadable(path) {
    try {
        await access(path, constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
function joinUrl(base, path) {
    const b = base.replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${b}${p}`;
}
function guessAudioMime(path) {
    const ext = basename(path).split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'mp3': return 'audio/mpeg';
        case 'wav': return 'audio/wav';
        case 'm4a': return 'audio/mp4';
        case 'aac': return 'audio/aac';
        case 'ogg': return 'audio/ogg';
        case 'flac': return 'audio/flac';
        case 'webm': return 'audio/webm';
        default: return 'audio/mpeg';
    }
}
// ── ASR:三引擎(gemini 多模态默认 / zhipu / openai 兼容)──────────────────
/**
 * gemini 引擎:多模态模型直接吃音频(webm/wav/mp3 皆可),免费额度,走 generateContent。
 *
 * 实现说明:用系统 curl.exe 子进程而非 undici ProxyAgent —— 在 DSH 进程内
 * 动态 import('undici') 的 dispatcher 与运行时 fetch 存在兼容问题(实测
 * "fetch failed");curl 是本机自带、与 powershell 子进程同模式, * 且经本机 Clash 代理直连 Gemini 实测 200。
 */
async function transcribeGemini(config, path, signal) {
    const key = process.env[config.geminiApiKeyEnv];
    if (!key) {
        throw new Error(`Gemini API key not set. Export ${config.geminiApiKeyEnv} with a key, ` +
            `or set asrEngine to 'zhipu'/'openai' with the matching key env.`);
    }
    const timeoutSignal = AbortSignal.timeout(config.transcribeTimeoutMs);
    const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const bytes = await readFile(path);
    const mime = guessAudioMime(path);
    const body = JSON.stringify({
        contents: [{
                parts: [
                    { inline_data: { mime_type: mime, data: bytes.toString('base64') } },
                    { text: '请把这段语音完整转写成文字，只输出转写结果，不要任何解释。' },
                ],
            }],
    });
    const tmpJson = join(tmpdir(), `dsh-gemini-${Date.now()}.json`);
    await writeFile(tmpJson, body, 'utf8');
    try {
        const url = `${joinUrl(config.geminiBaseUrl, '')}/v1beta/models/${config.geminiModel}:generateContent?key=${encodeURIComponent(key)}`;
        const proxy = config.geminiProxy || process.env.HTTPS_PROXY || process.env.http_proxy || '';
        const mkArgs = () => {
            const args = [
                '-sS', '-w', '\n%{http_code}', '-X', 'POST', url,
                '-H', 'content-type: application/json',
                '--data', `@${tmpJson}`,
                '--max-time', String(Math.max(30, Math.floor(config.transcribeTimeoutMs / 1000))),
            ];
            if (proxy)
                args.push('--proxy', proxy);
            return args;
        };
        // Gemini 免费额度会 429 限流(提示 "Please retry in Ns"):等待后重试一次
        let lastError = null;
        // Windows 用原生 curl.exe；Linux/macOS 用系统 curl（本机 WSL 无 curl.exe）。
        const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
        for (let attempt = 0; attempt < 2; attempt++) {
            const { stdout } = await execFileAsync(curlBin, mkArgs(), { signal: signalAll, maxBuffer: 8 * 1024 * 1024 });
            const lines = stdout.trimEnd().split('\n');
            const status = Number(lines.pop());
            const out = lines.join('\n');
            if (status === 200) {
                const data = JSON.parse(out);
                const text = Array.isArray(data?.candidates?.[0]?.content?.parts)
                    ? data.candidates[0].content.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
                    : '';
                if (!text)
                    throw new Error(`Gemini ASR returned no text: ${JSON.stringify(data).slice(0, 500)}`);
                return { text, language: null };
            }
            if (status === 429 && attempt === 0) {
                const m = /retry in ([\d.]+)s/i.exec(out);
                const waitMs = m ? Math.min(Math.ceil(Number(m[1]) * 1000) + 800, 20000) : 6000;
                lastError = new Error(`Gemini 免费额度繁忙(429),等待 ${Math.round(waitMs / 1000)}s 后重试`);
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
            }
            throw new Error(`Gemini ASR HTTP ${status}: ${out.slice(0, 500)}`);
        }
        throw lastError ?? new Error('Gemini ASR failed');
    }
    finally {
        await rm(tmpJson).catch(() => { });
    }
}
/**
 * 本地 ASR:faster-whisper 离线转写(免费无限用,不依赖 API 额度/网络)。
 * 调用 localAsrRoot/transcribe.py(faster-whisper, CPU int8),模型自动下载缓存;
 * 支持任意 ffmpeg 可解音频(webm/mp3/wav...),自动多语言识别,可指定语言。
 */
async function transcribeLocal(config, path, signal) {
    const timeoutSignal = AbortSignal.timeout(config.transcribeTimeoutMs);
    const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const script = join(config.localAsrRoot, 'transcribe.py');
    if (!(await assertReadable(script))) {
        throw new Error(`本地 ASR 未部署:找不到 ${script}。请先安装 faster-whisper 并放置 transcribe.py` +
            `(见 DSH_UPGRADE/local-asr 部署说明),或把 asrEngine 切回 'gemini'/'zhipu'。`);
    }
    const args = [
        script,
        path,
        config.localAsrModel,
        String(Math.max(1, Math.min(16, config.localAsrThreads))),
    ];
    if (config.localAsrLanguage)
        args.push(config.localAsrLanguage);
    if (config.localAsrPrompt)
        args.push(config.localAsrPrompt);
    try {
        const { stdout } = await execFileAsync('python', args, {
            signal: signalAll,
            maxBuffer: 16 * 1024 * 1024,
            encoding: 'utf8',
        });
        const text = stdout.trim().split('\n').pop()?.trim() ?? '';
        if (!text || /^ERROR:/.test(text)) {
            throw new Error(`本地 ASR 失败:${text || '无输出'}`);
        }
        return { text, language: null };
    }
    catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim() : '';
        if (stderr)
            throw new Error(`本地 ASR 失败:${stderr.slice(0, 400)}`);
        throw err;
    }
}
async function transcribeAudio(config, path, signal) {
    if (config.asrEngine === 'local')
        return transcribeLocal(config, path, signal);
    if (config.asrEngine === 'gemini')
        return transcribeGemini(config, path, signal);
    // zhipu / openai:OpenAI 兼容 /audio/transcriptions
    const key = process.env[config.asrApiKeyEnv];
    if (!key) {
        throw new Error(`ASR API key not set. Export ${config.asrApiKeyEnv} with a key for ${config.asrBaseUrl} ` +
            `(model: ${config.asrModel}), or point asrBaseUrl/asrModel at any OpenAI-compatible ` +
            `/audio/transcriptions endpoint (e.g. Whisper, SenseVoice).`);
    }
    const timeoutSignal = AbortSignal.timeout(config.transcribeTimeoutMs);
    const signalAll = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    // zhipu 引擎:智谱拒绝 webm(实测错误 1214),需先转 16kHz wav 再上传
    let uploadPath = path;
    let tmpWav = '';
    if (config.asrEngine === 'zhipu' && !/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(path)) {
        tmpWav = join(tmpdir(), `dsh-zhipu-${Date.now()}.wav`);
        await execFileAsync('ffmpeg', ['-y', '-i', path, '-ar', '16000', '-ac', '1', tmpWav], {
            signal: signalAll,
            maxBuffer: 8 * 1024 * 1024,
        });
        uploadPath = tmpWav;
    }
    const bytes = await readFile(uploadPath);
    const mime = tmpWav ? 'audio/wav' : guessAudioMime(path);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), tmpWav ? 'voice.wav' : basename(path));
    form.append('model', config.asrModel);
    form.append('response_format', 'json');
    try {
        const res = await fetch(joinUrl(config.asrBaseUrl, '/audio/transcriptions'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: signalAll,
        });
        if (!res.ok)
            throw new Error(`ASR HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        const body = await res.json();
        const text = typeof body?.text === 'string' ? body.text : '';
        if (!text)
            throw new Error(`ASR returned no text: ${JSON.stringify(body).slice(0, 500)}`);
        return { text, language: body.language };
    }
    finally {
        if (tmpWav)
            await rm(tmpWav).catch(() => { });
    }
}
// ── host 半:语音输入按钮的转写路由 ─ ────────────────────────────────────────────────────────────────
export function apply(ctx, config) {
    // ── host 半:语音输入按钮的转写路由 ────────────────────────────────────
    // POST /dsh-voice-input/transcribe —— 接收浏览器麦克风录制的音频 blob,
    // 存临时文件 → 调 ASR → 返回 { text }。客户端(浏览器)由此拿到文字并填入输入框。
    const webserver = ctx.get('webServer');
    if (webserver) {
        const disposer = webserver.register({
            kind: 'exact',
            path: '/dsh-voice-input/transcribe',
            handler: async (req, res) => {
                try {
                    // 读请求体为 Buffer(浏览器 FormData 的 file 字段)
                    const chunks = [];
                    for await (const chunk of req)
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    const body = Buffer.concat(chunks);
                    // 解析 multipart:取 file 字段
                    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers?.['content-type'] ?? '')?.[1] ?? (req.headers?.['content-type'] ?? '').split('boundary=')[1]?.trim();
                    if (!boundary)
                        return send(res, 400, { error: 'missing multipart boundary' });
                    const parts = parseMultipart(body, boundary);
                    // 优先取 file 字段;否则整体当裸音频
                    const fileField = parts.find((p) => p.name === 'file');
                    const audioBytes = fileField ? fileField.data : body;
                    // 客户端可选引擎:POST 里带 engine 字段则优先,否则用配置默认
                    const engineField = parts.find((p) => p.name === 'engine');
                    const requested = engineField ? engineField.data.toString('utf8').trim() : '';
                    const engines = ['gemini', 'zhipu', 'openai', 'local'];
                    const effectiveEngine = engines.includes(requested) ? requested : config.asrEngine;
                    // 引擎密钥检查(按引擎区分,给可操作报错)
                    const key = effectiveEngine === 'gemini'
                        ? process.env[config.geminiApiKeyEnv]
                        : process.env[config.asrApiKeyEnv];
                    if (!key) {
                        const envName = effectiveEngine === 'gemini' ? config.geminiApiKeyEnv : config.asrApiKeyEnv;
                        return send(res, 400, { error: `ASR key ${envName} not set` });
                    }
                    if (audioBytes.length > config.maxAudioBytes)
                        return send(res, 413, { error: 'audio too large' });
                    // 写临时文件转写:保留上传文件的扩展名(浏览器录音是 .webm,智谱只收 .wav/.mp3,
                    // Gemini 多模态都收;扩展名错误会让部分端点直接拒格式)
                    const fname = fileField?.filename ?? '';
                    const ext = fname.includes('.') ? `.${fname.split('.').pop()}` : '.webm';
                    const tmp = join(tmpdir(), `dsh-voice-${Date.now()}${ext}`);
                    await writeFile(tmp, audioBytes);
                    try {
                        const result = await transcribeAudio({ ...config, asrEngine: effectiveEngine }, tmp);
                        send(res, 200, { text: result.text, language: result.language ?? null });
                    }
                    finally {
                        await rm(tmp).catch(() => { });
                    }
                }
                catch (err) {
                    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
                }
            },
        });
        ctx.effect(() => disposer);
    }
    console.log(`[dsh-voice-input] voice-input button registered ` +
        `(ASR=${config.asrEngine}${config.asrEngine === 'gemini' ? `:${config.geminiModel}` : `:${config.asrModel}@${config.asrBaseUrl}`})`);
}
function parseMultipart(body, boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    const parts = [];
    let pos = 0;
    while (true) {
        const start = body.indexOf(delimiter, pos);
        if (start < 0)
            break;
        const lineEnd = body.indexOf(Buffer.from('\r\n'), start);
        if (lineEnd < 0)
            break;
        let cursor = lineEnd + 2;
        // headers
        let name = '';
        let filename;
        while (true) {
            const headerEnd = body.indexOf(Buffer.from('\r\n'), cursor);
            if (headerEnd < 0 || headerEnd === cursor)
                break;
            const headerLine = body.subarray(cursor, headerEnd).toString('utf8');
            const nameMatch = /name="([^"]*)"/.exec(headerLine);
            if (nameMatch)
                name = nameMatch[1];
            const fileMatch = /filename="([^"]*)"/.exec(headerLine);
            if (fileMatch)
                filename = fileMatch[1];
            cursor = headerEnd + 2;
        }
        cursor += 2; // blank line
        const nextDelim = body.indexOf(delimiter, cursor);
        if (nextDelim < 0)
            break;
        const data = body.subarray(cursor, nextDelim - 2); // strip trailing \r\n
        if (name)
            parts.push({ name, filename, data });
        pos = nextDelim;
    }
    return parts;
}
function send(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
}
