# 本地语音转写（faster-whisper）部署指南

完全**免费**、**无限用**、**离线**、**隐私**（音频不出本机）的语音转写方案。适合不想用云端 API、或云端免费额度不够用的场景。

## 一、安装依赖

需要 **Python 3.9+**（Windows 到 [python.org](https://www.python.org/downloads/) 下载安装，勾选 "Add to PATH"）。

```bash
pip install faster-whisper
```

## 二、放置脚本

```bash
# 建目录
mkdir -p C:/Users/<你>/dsh-local-asr
# 复制本目录的 transcribe.py 过去
cp transcribe.py C:/Users/<你>/dsh-local-asr/
```

## 三、配置插件

`cordis.patch.yml`：

```yaml
- id: audio-copilot
  config:
    asrEngine: local
    localAsrRoot: C:/Users/<你>/dsh-local-asr
    localAsrModel: medium        # 推荐 medium(中文准);small 更快但差一些
    localAsrThreads: 4
    localAsrPrompt: DeepSeek, DSH, 智能体, Flash, V4
```

## 四、命令行直接测试

```bash
python C:/Users/<你>/dsh-local-asr/transcribe.py test.wav medium 4
# 首次运行自动下载模型(~1.5GB medium / ~460MB small,缓存于 ~/.cache/huggingface)
```

## 五、参数说明

| 参数 | 说明 |
|---|---|
| `transcribe.py <音频>` | 必填，任意 ffmpeg 可解格式：webm/mp3/wav/m4a… |
| `[模型名]` | tiny / base / small / medium / large-v3，默认 small |
| `[线程数]` | CPU 线程数，默认 4 |
| `[语言]` | 指定语言（如 `zh`/`en`/`yue`），留空自动检测 |
| `[提示词]` | 专有名词/术语，逗号分隔，显著提升识别（如 `DeepSeek, DSH, 智能体`） |

## 六、模型怎么选

| 模型 | 大小 | 中文准确度 | 速度（CPU） | 建议 |
|---|---|---|---|---|
| tiny | ~75MB | 差 | 极快 | 不推荐 |
| base | ~145MB | 一般 | 快 | 英文场景 |
| **small** | ~460MB | 好 | 快（3.5s 音频 ~2s） | 轻量中文 |
| **medium** | ~1.5GB | **准**（专有名词+提示后几乎完美） | 中（3.5s 音频 ~6-20s） | **推荐** |
| large-v3 | ~3GB | 最准 | 慢 | 追求极致 |

> 方言：whisper 对粤语等方言效果一般，中文方言/外语建议用智谱 GLM-ASR-2512 引擎（`asrEngine: zhipu`）。
