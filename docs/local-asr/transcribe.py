"""本地语音转写(faster-whisper, 免费无限用)。

用法: python transcribe.py <音频路径> [模型名] [cpu线程数] [语言] [提示词]
  - 模型名: tiny/base/small/medium/large-v3/distil-* (默认 small, 中文准确/速度快)
  - 提示词: 专有名词/术语列表, 逗号分隔(如 "DeepSeek, DSH, 智能体"), 显著提升识别
  - 输出: 转写文本(UTF-8, 仅一行, 打印到 stdout; 日志走 stderr)
  - 模型首次使用自动从 HuggingFace 下载并缓存
"""
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python transcribe.py <audio> [model] [threads] [lang] [prompt]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
    cpu_threads = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    language = (sys.argv[4] if len(sys.argv) > 4 else "") or None
    prompt = (sys.argv[5] if len(sys.argv) > 5 else "") or ""

    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
    segments, info = model.transcribe(
        path,
        language=language,
        beam_size=5,
        vad_filter=False,
        initial_prompt=prompt or None,
    )
    text = "".join(s.text for s in segments).strip()
    if not text:
        print("ERROR: 无转写结果(音频可能为空或过短)", file=sys.stderr)
        return 3
    print(text)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
