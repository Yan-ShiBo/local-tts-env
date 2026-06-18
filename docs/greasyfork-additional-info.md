# Greasy Fork Additional Info

Copy the Markdown below into Greasy Fork's "Additional info" field.

Greasy Fork reads the project links from the userscript metadata:

- `@homepageURL https://github.com/Yan-ShiBo/local-tts-env`
- `@supportURL https://github.com/Yan-ShiBo/local-tts-env/issues`

Keep the GitHub links in both places: metadata makes them appear in Greasy Fork's structured script links, while the text below makes them visible inside the script description.

---

## 本地划词听译助手

选中网页上的文本后，可以直接：

- `Read`：先调用本机 `translategemma:4b` 准备英文朗读稿，再交给 Kokoro TTS 朗读
- `Translate`：调用本机 Ollama 模型翻译，默认 `translategemma:4b`
- 在设置面板里切换声音、语速、翻译模型和目标语言
- 查看本地 TTS 服务与 Ollama 模型状态
- 英文会尽量原样保留，中文会翻成英文，公式会变成英文口语描述
- MathJax/MathML/LaTeX 会优先提取语义公式；翻译结果保留公式符号，并附加专业中文描述
- 如果朗读稿准备接口不可用，`Read` 会退回到 `/translate` 并指定翻译成 English 后再朗读
- 按钮和译文卡片会根据选区自动选择上方或下方，减少遮挡正文

## 重要：需要本地服务

这个脚本不是单独安装就能工作的云端脚本。它只负责浏览器里的划词按钮和交互，需要你先在电脑上启动本地服务：

1. 安装并启动本项目的本地 FastAPI 服务
2. 朗读需要 Kokoro TTS 环境
3. 翻译需要安装 Ollama，并拉取本地模型，例如：

```powershell
ollama pull translategemma:4b
# 可选更大模型
ollama pull qwen3:14b
```

翻译、朗读稿准备和复杂公式口语化默认都使用 `translategemma:4b`。可在服务端通过 `OLLAMA_TRANSLATE_MODEL`、`OLLAMA_READ_MODEL`、`OLLAMA_FORMULA_MODEL` 覆盖。如果第一次变慢，通常是 Ollama 正在加载模型。

## 隐私说明

脚本只请求本机地址：

```text
http://127.0.0.1:5000
```

选中文本不会被发送到外部云端服务。朗读和翻译都在你的电脑本地完成。

## 常见问题

### 安装后没有反应

先确认本地服务已启动：

```text
http://127.0.0.1:5000/health
```

如果打不开，先运行项目里的 `start.bat` 或推荐的托盘启动器 `Kokoro TTS.bat`。
新版 `start.bat` 和 `Kokoro TTS.bat` 会直接定位 `kokoro-tts` 环境里的 Python，不需要先执行 `conda init`；`Kokoro TTS.pyw` 只在 Windows 已有关联 `.pyw` 到 Python 时适合双击。

### 翻译健康检测失败

通常是浏览器脚本已更新，但本地后台服务还没重启到最新版。重启本地服务后再刷新网页。

### 翻译第一次比较慢

Ollama 第一次使用某个模型时需要把模型加载到 GPU/内存，之后同一模型会快很多。

## 项目地址

- GitHub: https://github.com/Yan-ShiBo/local-tts-env
- 问题反馈: https://github.com/Yan-ShiBo/local-tts-env/issues
- Raw userscript: https://raw.githubusercontent.com/Yan-ShiBo/local-tts-env/main/tts-userscript.js
