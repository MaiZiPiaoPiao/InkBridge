# AI 论文阅读助手 Zotero 插件

Zotero 8/9/10 插件，直接调用本地 vLLM 服务（HY-MT1.5-1.8B）做英文 → 中文翻译，不需要额外的后端。

```text
Zotero 插件  ──HTTP/SSE──▶  vLLM (127.0.0.1:8001, OpenAI 兼容接口)
```

## 功能

只做一件事：英文 → 中文翻译。

- 在 PDF 阅读器中选中文字后自动捕获，不需要右键发送。
- `自动` 开关打开时立即流式翻译；关闭时只把选中文字放进输入框，按 Enter 再翻译。
- 也可以在输入框里手动输入英文，按 Enter 翻译。
- 每次翻译都是独立请求，不携带历史，使用官方提示词模板，模型只输出译文。
- 按原文长度限制输出 token 数；原文超过 4000 字符的部分会被截断。

## 启动 vLLM

```bash
conda activate vllm
vllm serve ~/models/HY-MT1.5-1.8B \
    --served-model-name hy-mt \
    --host 127.0.0.1 --port 8001 \
    --max-model-len 4096 \
    --gpu-memory-utilization 0.5
```

看到 `Application startup complete` 后即可在 Zotero 中使用。

- `--served-model-name hy-mt` 必须与 `bootstrap.js` 中的 `MODEL_NAME` 一致。换模型（如 HY-MT1.5-7B-GPTQ-Int4）只需改模型路径，插件无需修改。
- `--max-model-len 4096` 与插件的 `MAX_INPUT_CHARS = 4000` 配套；调小它时要同步调小插件的截断长度。

模型下载：

```bash
modelscope download --model Tencent-Hunyuan/HY-MT1.5-1.8B --local_dir ~/models/HY-MT1.5-1.8B
```

## 翻译参数

都在 `bootstrap.js` 顶部，修改后需重新打包：

| 常量 | 说明 |
|---|---|
| `MODEL_NAME` | vLLM 的 `--served-model-name` |
| `PROMPT_PREFIX` | 官方 ZH<=>XX 提示词模板 |
| `SAMPLING` | 官方推荐采样参数：temperature 0.7 / top_p 0.6 / top_k 20 / repetition_penalty 1.05 |
| `MIN_OUTPUT_TOKENS` / `MAX_OUTPUT_TOKENS` | 输出 token 上下限，实际上限 = 原文字符数 / 2 + 32 |
| `MAX_INPUT_CHARS` | 原文截断长度 |

## 服务地址

插件默认请求 `http://127.0.0.1:8001`，可以在面板顶部的 `API` 输入框里修改。旧版保存的 `http://127.0.0.1:8000` 会自动迁移为新地址。

## 本地开发侧载

1. 在 Zotero 配置目录（`~/.zotero/zotero/<profile>/`）的 `extensions` 文件夹中，创建一个名为 `ai-paper-reader@maipeng.com` 的文本文件。
2. 文件内容写入本目录的绝对路径：

   ```text
   /home/maipeng/Extension/zotero-plugin
   ```

3. 重启 Zotero。必要时用 `-purgecaches` 启动，避免 Zotero 读取旧缓存。

## 打包 XPI

在仓库根目录运行：

```bash
rm -f ai-paper.xpi
cd zotero-plugin && zip -r -X ../ai-paper.xpi . && cd ..
```

然后在 Zotero 的 `工具 -> 插件` 中从文件安装这个 `.xpi`。
