# dsh-audio-copilot · 语音工作台

> 给纯文本模型补上"听"和"说"的能力——DeepSeek Harness(DSH)音频插件。
> Audio Copilot: give your text-only agent ears and a voice.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.7-4D6BFE.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/badge/GitHub-ai--yucheng-181717?logo=github)](https://github.com/ai-yucheng/dsh-audio-copilot)
[![npm version](https://img.shields.io/npm/v/dsh-audio-copilot?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-audio-copilot)
[![npm downloads](https://img.shields.io/npm/dm/dsh-audio-copilot?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-audio-copilot)

纯文本模型(如 DeepSeek)无法直接理解音频,也无法朗读。本插件补上这两块,并附赠一个**语音输入按钮**:

| 工具 / 能力 | 做什么 |
|---|---|
| 🎤 **语音输入按钮** | 聊天输入框旁的麦克风按钮:点击录音 → 自动转文字 → 填入输入框,说完即发 |
| `audio_probe` | 用 ffprobe 读音频元数据:容器 / 时长 / 编码 / 采样率 / 声道 |
| `audio_transcribe` | 音频 / 录音 → 文字(OpenAI 兼容 ASR 端点,可接 Whisper / SenseVoice / GLM-ASR) |
| `audio_tts` | 文字 → 语音文件(**默认 Windows 本地 SAPI,免 key 免联网**;可选 Edge 在线 / OpenAI 兼容端点) |
| `audio_ask` | 带时间锚定的音频问答:转写 → 关键词定位 → 返回命中片段与时间戳 |

## ✨ 特性

- 🎤 **语音输入按钮**:浏览器端麦克风录音 → host 转写 → 自动填入输入框(需浏览器麦克风权限 + 已配置 ASR key)
- **开箱即用**:`audio_tts` 默认走 Windows 自带语音(SAPI),零配置零 key,离线可用
- **可插拔**:ASR / TTS 全部 OpenAI 兼容,可配任意端点,不锁定厂商
- **三引擎 TTS**:
  - `sapi`(默认):Windows 本地语音,免费离线,中文"Microsoft Huihui"、英文"Microsoft Zira/David"
  - `edge`:微软在线 TTS,免 key(需网络可达 speech.platform.bing.com)
  - `openai`:任意 OpenAI 兼容 `/audio/speech` 端点
- **失败要大声**:缺 key / 缺 ffmpeg / 端点错误都给可操作的错误信息
- **对齐官方规范**:Config schema 校验、effect 注册、纯 ESM、`inject: ['tools']`、`dsh.client` 浏览器半

## 📦 安装

前置:Node.js ≥ 20、`ffprobe`/`ffmpeg` 在 PATH(Windows 装 ffmpeg 后两者都有)。

```sh
# 方式一:本地源码(开发/迭代)
cd <插件父目录>
dsh plugin --profile web add ./dsh-audio-copilot

# 方式二:npm(发布后)
dsh plugin --profile web add dsh-audio-copilot
```

验证:

```sh
dsh --profile web --dump-config | grep audio-copilot
```

**硬刷新浏览器(Ctrl+Shift+R)** 或重启 DSH 后,四个工具进入 agent 工具列表。

## ⚙️ 配置

在 profile 的 `cordis.patch.yml` 里覆盖(所有键都有默认值,不配也能用 TTS):

```yaml
- id: audio-copilot
  config:
    # ASR 引擎:gemini(海外,多模态,免费档有限流) | zhipu(国内,GLM-ASR-2512 中文+方言+外语) | local(本地 faster-whisper,免费离线) | openai(任意兼容端点)
    asrEngine: zhipu
    asrBaseUrl: https://open.bigmodel.cn/api/paas/v4
    asrModel: glm-asr-2512
    asrApiKeyEnv: ZHIPU_API_KEY
    # 本地引擎(faster-whisper,免费无限用):transcribe.py 位于 localAsrRoot;模型自动下载缓存
    localAsrRoot: C:/Users/<you>/dsh-local-asr
    localAsrModel: medium
    localAsrThreads: 4
    localAsrPrompt: DeepSeek, DSH, 智能体
    # TTS 引擎:sapi | edge | openai
    ttsEngine: sapi
    ttsVoice: Microsoft Huihui Desktop
```

| 键 | 默认 | 说明 |
|---|---|---|
| `asrEngine` | `gemini` | ASR 引擎:`gemini`(多模态,免费档每时段 20 次限流,429 自动重试)/ `zhipu`(GLM-ASR-2512,国内直连,中文+四川/粤/闽/吴方言+数十种外语,限 30s)/ `local`(faster-whisper 本地免费)/ `openai`(任意兼容端点) |
| `asrBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | zhipu/openai 引擎端点根 |
| `asrModel` | `glm-asr-2512` | zhipu/openai 引擎模型名 |
| `asrApiKeyEnv` | `ZHIPU_API_KEY` | 持 key 的环境变量名 |
| `geminiApiKeyEnv` | `GEMINI_API_KEY` | gemini 引擎 key 环境变量 |
| `geminiModel` | `gemini-3.6-flash` | gemini 引擎模型 |
| `geminiProxy` | `http://127.0.0.1:7890` | gemini 引擎代理(海外直连无需配) |
| `localAsrRoot` | *(空)* | 本地引擎目录(含 `transcribe.py`),需自行部署 faster-whisper |
| `localAsrModel` | `medium` | 本地 whisper 模型(tiny/base/small/medium/large-v3) |
| `localAsrPrompt` | *(空)* | 本地引擎专有名词提示(逗号分隔),提升 DeepSeek 等词识别 |
| `ttsEngine` | `sapi` | TTS 引擎:`sapi`(本地)/ `edge`(在线)/ `openai`(兼容端点) |
| `ttsVoice` | `Microsoft Huihui Desktop` | 默认音色 |
| `maxAudioBytes` | `26214400` | 转写文件大小上限 |
| `transcribeTimeoutMs` | `120000` | ASR 超时 |

## 🎯 使用示例

在会话里对模型说:

- 「把这个录音转成文字:`C:\meeting.wav`」
- 「读一下这段总结的语音版」
- 「这个会议录音里,3 分钟的时候说了什么?」
- 「把这段代码用语音念出来」

## 🛠 开发

```sh
pnpm install
pnpm run build      # tsc → dist/index.js(纯 ESM)
pnpm run typecheck  # tsc --noEmit
```

依赖对齐:`@deepseek-ai/dsh-tools` 锁定 `0.1.0-rc.7`(与你 DSH 同版本线,避免装两份模块)。

## 📄 License

MIT
