# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
