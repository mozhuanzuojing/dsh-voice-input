# dsh-audio-copilot · 语音工作台

> 给纯文本模型补上"听"和"说"的能力——DeepSeek Harness(DSH)音频插件。
> Audio Copilot: give your text-only agent ears and a voice.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.7-4D6BFE.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/badge/GitHub-ai--yucheng-181717?logo=github)](https://github.com/ai-yucheng/dsh-audio-copilot)
[![npm](https://img.shields.io/badge/npm-dsh--audio--copilot-cb3837?logo=npm)](https://www.npmjs.com/package/dsh-audio-copilot)

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
    # ASR:OpenAI 兼容 /audio/transcriptions 端点
    asrBaseUrl: https://open.bigmodel.cn/api/paas/v4
    asrModel: glm-4v-asr
    asrApiKeyEnv: ZHIPU_API_KEY
    # TTS 引擎:sapi | edge | openai
    ttsEngine: sapi
    ttsBaseUrl: https://open.bigmodel.cn/api/paas/v4
    ttsModel: glm-tts
    ttsApiKeyEnv: ZHIPU_API_KEY
    ttsVoice: Microsoft Huihui Desktop
```

| 键 | 默认 | 说明 |
|---|---|---|
| `asrBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | ASR 端点根(OpenAI 兼容) |
| `asrModel` | `glm-4v-asr` | ASR 模型名 |
| `asrApiKeyEnv` | `ZHIPU_API_KEY` | 持 key 的环境变量名 |
| `ttsEngine` | `sapi` | TTS 引擎:`sapi`(本地)/ `edge`(在线)/ `openai`(兼容端点) |
| `ttsBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | openai 引擎端点 |
| `ttsModel` | `glm-tts` | openai 引擎模型 |
| `ttsApiKeyEnv` | `ZHIPU_API_KEY` | openai 引擎 key 环境变量 |
| `ttsVoice` | `Microsoft Huihui Desktop` | 默认音色 |
| `maxAudioBytes` | `26214400` | 转写文件大小上限 |
| `transcribeTimeoutMs` | `120000` | ASR 超时 |
| `ttsTimeoutMs` | `90000` | TTS 超时 |
| `maxSegments` | `20` | audio_ask 返回的命中片段上限 |

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
