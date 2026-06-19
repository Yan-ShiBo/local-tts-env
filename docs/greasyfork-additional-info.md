# Greasy Fork Additional Info

Copy the Markdown below into Greasy Fork's "Additional info" field.

Greasy Fork reads the project links from the userscript metadata:

- `@homepageURL https://github.com/Yan-ShiBo/LocalReadTranslate`
- `@supportURL https://github.com/Yan-ShiBo/LocalReadTranslate/issues`

Keep the GitHub links in both places: metadata makes them appear in Greasy Fork's structured script links, while the text below makes them visible inside the script description.

---

## 本地划词听译助手

选中网页上的文本后，可以直接：

- `Read`：英文含公式时先读正文，同时后台处理公式；播放到公式处如果还没处理好再等待，然后继续交给 Kokoro TTS 朗读
- `Translate`：调用本机 Ollama 模型翻译，默认 `translategemma:4b`
- 在设置面板里切换并保存声音、语速、翻译模型和目标语言
- 查看本地 TTS 服务与 Ollama 模型状态
- 英文会尽量原样保留，中文会翻成英文；英文含公式的朗读会优先开始正文，公式在后台变成英文口语描述
- MathJax/MathML/LaTeX 会优先提取语义公式；翻译结果会把公式渲染为带上下标的易读公式，而不是显示原始 LaTeX 代码
- 翻译请求可附带附近正文作为本地参考上下文，只用于术语和指代消歧；真正翻译和输出的只有选中内容
- 上下文长度会按模型大小自动裁剪：4B 模型翻译和公式朗读不参考上下文，9B/14B/更大模型会逐级保留更多上下文
- 选择 4B 模型时，常见公式会优先使用本地保守字面读法，例如 `D_I` 读作 `D sub I`，`\hat{B}(x)` 读作 `B hat of x`
- 公式口语化会参考项目里的数学术语表；50+ 个核心数学符号会按语境选择更合适的读法，例如右箭头可读作“映射到、趋向于、推导出、得到、右箭头”
- 如果朗读稿准备接口不可用，`Read` 会退回到 `/translate` 并指定翻译成 English 后再朗读
- `Read` 和 `Translate` 可以同时进行；按钮行固定在选区下方，译文卡片会根据空间避让，减少遮挡正文
- 只选中 MathJax/MathML/KaTeX 公式的一部分时，脚本会尽量扩展到完整公式框；如果选中的是包含公式的一整句话，会保留公式前后的句子内容

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

翻译、朗读稿准备和复杂公式口语化默认都使用 `translategemma:4b`。可在服务端通过 `OLLAMA_TRANSLATE_MODEL`、`OLLAMA_READ_MODEL`、`OLLAMA_FORMULA_MODEL` 覆盖，也可在脚本设置里切换当前翻译/朗读准备模型。如果第一次变慢，通常是 Ollama 正在加载模型。4B 模型的翻译和公式朗读不参考上下文，公式朗读也会优先采用保守字面规则；14B 模型会保留更多上下文。
数学符号读法可在项目的 `config/math_glossary.json` 中调整，当前覆盖箭头、上下标、集合、逻辑、求和、积分、偏导等常见论文符号。

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

- GitHub: https://github.com/Yan-ShiBo/LocalReadTranslate
- 问题反馈: https://github.com/Yan-ShiBo/LocalReadTranslate/issues
- Raw userscript: https://raw.githubusercontent.com/Yan-ShiBo/LocalReadTranslate/main/tts-userscript.js
