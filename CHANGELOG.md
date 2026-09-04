# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.0] - 2026-09-03

### 🐛 适配 DSH 0.1.2-rc.1：composer 改为 contenteditable

DSH 0.1.2-rc.1 把聊天输入框从 `textarea` 改成 `DIV[contenteditable=true]`，导致麦克风按钮挂不到输入框（`findComposer` 只认 textarea）。

- **客户端修复**：`src/client.ts` 的 `findComposer` 扩展为同时匹配 `[contenteditable=true]` 与 `textarea`（contenteditable 优先）；`insertTextIntoComposer` 对 contenteditable 用 `Selection+Range` 定位光标再派发 paste 事件，注入文本落到底部。
- **依赖清理**：`package.json` 移除 `dsh.client.inject` 里陈旧的 `@deepseek-ai/dsh-client-runtime`（该包在 DSH 0.1.2-rc.1 已删除）；cordis peer/dev 升到 `^4.0.2`。
- 已实测：按钮在 0.1.2-rc.1 的 contenteditable composer 上正常挂载。

## [0.5.0] - 2026-08-25

### 🚀 本地改造版：改名 dsh-voice-input + Web Speech 支持

- **改名**：`dsh-audio-copilot` → `dsh-voice-input`（package name / cordis id / 路由 `/dsh-voice-input/transcribe`），发布为新仓库 [mozhuanzuojing/dsh-voice-input](https://github.com/mozhuanzuojing/dsh-voice-input)
- **新增浏览器原生 Web Speech API**：Chrome/Edge 支持时优先用浏览器识别（免 key、实时、不耗 API 额度），按钮下拉可选 `webspeech`
- **移除 `@deepseek-ai/dsh-tools` 依赖**
- **跟随最新 DSH**：升级到 `0.1.1-rc.2` 线，按官方 bundle 规范接入并持续兼容
- README / CHANGELOG / package.json 同步改为 dsh-voice-input 并指向新仓库

## [0.4.0] - 2026-08-22

### 🗑️ 精简（用户反馈：只保留有界面入口的功能）

- **移除 Agent 音频工具**：`audio_transcribe` / `audio_ask` / `audio_probe`（均为无界面入口的 Agent 工具，用户无法感知使用位置，与宣传不符）
- **插件现在只保留一个功能：🎤 语音输入按钮**（录音 → 多引擎转写 → 文字填入输入框）——所见即所得，无任何隐藏能力
- README / CHANGELOG / package.json 同步更新

## [0.3.0] - 2026-08-22

### 🗑️ 移除

- **移除 TTS（文字转语音）功能**：删除 `audio_tts` 工具、三引擎实现（sapi/edge/openai）、`tts*` 配置项及 `ws` 依赖。
- README / 文档同步更新（去除 TTS 相关说明）。

## [0.2.0] - 2026-08-22

### 🚀 全新迭代（四引擎 + 语音输入按钮 + 本地部署）

从初版"能用的工具"升级为"开箱即用、多引擎、小白可上手"的完整插件。

#### 新增

- **四引擎语音转写**（`asrEngine`）：
  - `zhipu` —— 智谱 GLM-ASR-2512：国内直连，中文普通话 + 四川/粤/闽/吴方言 + 数十种外语，CER 0.07，按量计费极低（推荐国内用户）
  - `local` —— 本地 faster-whisper：完全免费、无限用、离线、隐私（音频不出本机）
  - `gemini` —— 海外多模态：音频理解最强，免费档限流自动重试，付费档 ~3厘/分钟
  - `openai` —— 任意 OpenAI 兼容 `/audio/transcriptions` 端点
- **语音输入按钮**（🎤）：录音 → 转写 → 文字自动填入输入框；录音 UI（脉冲光晕/秒表/停止/spinner）；28 秒自动停止（适配智谱 30s 上限）
- **文字注入兼容 React 受控组件**：模拟粘贴事件走 DSH 官方 `pasteBegin` 通道（实测直接赋值/原型 setter/execCommand 均被 React 19 重置吞掉）；注入失败自动把结果复制到剪贴板
- **本地 ASR 部署**：`docs/local-asr/transcribe.py`（faster-whisper，CPU int8），模型自动下载缓存，支持 `localAsrPrompt` 专有名词提示（显著提升 DeepSeek 等术语识别）
- **webm 自动转 wav**：智谱引擎先经 ffmpeg 转 16kHz 单声道（智谱实测拒 webm）
- **429 自动重试**：Gemini 免费额度限流时按提示等待后自动重试一次

#### 修复

- 服务端 Gemini 调用从 undici ProxyAgent 改为系统 `curl.exe` 子进程（DSH 进程内动态 import undici 的 dispatcher 与运行时 fetch 不兼容，实测 "fetch failed"）
- 转写文字不显示（React 受控组件状态不同步）问题
- 录音时长与智谱限制不匹配问题

#### 文档

- 全量重写 README：小白向三步安装、API Key 获取教程、引擎选择指南、FAQ、架构图
- 新增 CHANGELOG.md；`docs/local-asr/` 部署指南与脚本；示例截图

## [0.1.0] - 2026-08-21

### 初版

- audio_probe / audio_transcribe / audio_tts / audio_ask 四个 Agent 工具
- TTS 三引擎：sapi（本地免费）/ edge（微软在线）/ openai（兼容端点）
- 智谱 / OpenAI 兼容 ASR 端点支持
