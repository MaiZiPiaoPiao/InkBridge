# AI 论文阅读助手 Zotero 插件

在 Zotero PDF 阅读器里把英文论文翻译成中文。选中文即可翻译；截图可以翻译带公式的段落，公式会保留为 LaTeX 并直接渲染。模型全部在本地运行，插件直接调用 vLLM 的 OpenAI 兼容接口，不需要额外的后端。

```text
                    ┌──▶ vLLM :8001  HY-MT1.5-1.8B     文本翻译
Zotero 插件 ──SSE──┤
                    └──▶ vLLM :8002  HunyuanOCR-1.5    截图识别 + 翻译
```

## 功能

- **选中翻译**：在 PDF 中选中英文后自动翻译，流式输出。`自动` 开关关闭时，选中的文字只放进输入框，按 Enter 再翻译。
- **截图翻译**：截图后在输入框按 Ctrl+V，或把图片拖进面板。先识别原文，再输出译文；公式保留为 LaTeX，并用 KaTeX 渲染。
- **手动输入**：在输入框里输入英文，按 Enter 翻译。
- **只显示当前翻译**：每次翻译都会滚动到面板顶部，历史对话被推到上方，用滚轮向上可以查看。
- **复制**：每条结果下方有「复制原文」「复制译文」，公式复制出来是 LaTeX 源码。
- **服务状态**：顶部两个地址胶囊上的圆点显示服务是否可用（绿色可用，红色无法连接），每 15 秒检测一次。
- 每次翻译都是独立请求，不携带历史，只输出译文。

## 环境要求

- Zotero 8 / 9 / 10
- NVIDIA GPU，显存 12 GB 以上（两个服务同时运行约占 9.3 GB）
- Linux，conda

## 部署

### 1. 安装 vLLM

```bash
conda create -n vllm python=3.12 -y
conda activate vllm
pip install uv
uv pip install vllm --torch-backend=auto
```

### 2. 下载模型

下文用 `<MODEL_DIR>` 表示存放模型的目录，请替换为你自己的路径。模型权重不包含在本仓库中。

```bash
# 文本翻译：HY-MT1.5-1.8B（约 4 GB）
pip install modelscope
modelscope download --model Tencent-Hunyuan/HY-MT1.5-1.8B --local_dir <MODEL_DIR>/HY-MT1.5-1.8B

# 截图识别：HunyuanOCR-1.5（约 2.3 GB）
# HuggingFace 仓库根目录是 1.5 版本；v1.0/、dflash/、assets/ 不需要
hf download tencent/HunyuanOCR --exclude 'v1.0/*' --exclude 'dflash/*' --exclude 'assets/*' \
    --local-dir <MODEL_DIR>/HunyuanOCR-1.5
```

国内网络可以在 `hf download` 前加 `HF_ENDPOINT=https://hf-mirror.com`。如果终端设置了 `socks://` 格式的代理变量，`hf` 会报 `Unknown scheme for proxy URL`，可用 `env -u ALL_PROXY -u all_proxy hf download ...` 临时去掉。

### 3. 启动服务

两个服务依次启动（同时启动时两者的显存探测会互相干扰）：

```bash
# 文本翻译（约 30 秒就绪）
VLLM_USE_FLASHINFER_SAMPLER=0 vllm serve <MODEL_DIR>/HY-MT1.5-1.8B \
    --served-model-name hy-mt \
    --host 127.0.0.1 --port 8001 \
    --max-model-len 4096 \
    --gpu-memory-utilization 0.3 \
    --enforce-eager

# 截图识别（约 55 秒就绪）
VLLM_USE_FLASHINFER_SAMPLER=0 vllm serve <MODEL_DIR>/HunyuanOCR-1.5 \
    --served-model-name hy-ocr \
    --host 127.0.0.1 --port 8002 \
    --trust-remote-code \
    --limit-mm-per-prompt '{"image":1,"video":0}' \
    --max-model-len 8192 \
    --max-num-batched-tokens 8192 \
    --gpu-memory-utilization 0.35 \
    --enforce-eager
```

看到 `Application startup complete` 后即可在 Zotero 中使用。

| 参数                              | 说明                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `--enforce-eager`               | 必需。vLLM 对 HunYuan 系列使用 transformers 实现，与 CUDA 图捕获冲突       |
| `VLLM_USE_FLASHINFER_SAMPLER=0` | 没有安装 CUDA 编译器`nvcc` 时需要，改用 PyTorch 采样实现                 |
| `--served-model-name`           | 必须与插件中的`MODEL_NAME` / `OCR_MODEL_NAME` 一致                     |
| `--max-model-len`               | 与插件的`MAX_INPUT_CHARS`、`OCR_MAX_TOKENS` 配套，调小时需同步修改插件 |
| `--gpu-memory-utilization`      | OCR 服务低于 0.35 时 KV 缓存不足，无法启动                                 |

启动后第一次翻译较长文本时，Triton 会现场编译内核，可能卡住几十秒，之后恢复正常。

## 安装插件

在仓库根目录打包：

```bash
rm -f ai-paper.xpi
cd zotero-plugin && zip -r -X ../ai-paper.xpi . && cd ..
```

在 Zotero 的「工具 → 插件」中，点齿轮菜单 →「从文件安装插件」，选择 `ai-paper.xpi`，然后重启 Zotero。

## 使用

1. 打开一篇 PDF，在右侧条目面板中找到「AI 翻译」。
2. **选中翻译**：在 PDF 中选中英文。
3. **截图翻译**：用系统截图工具框选区域（GNOME 下按 PrtSc，截图会自动复制到剪贴板），点一下面板底部的输入框，按 Ctrl+V。
4. 顶部两个地址可以直接修改，回车或点击别处后保存；清空则恢复默认。地址可以省略 `http://`。

## 配置

翻译参数都在 `zotero-plugin/bootstrap.js` 顶部，修改后需重新打包：

| 常量                                          | 说明                                                      |
| --------------------------------------------- | --------------------------------------------------------- |
| `MODEL_NAME` / `OCR_MODEL_NAME`           | 对应 vLLM 的`--served-model-name`                       |
| `PROMPT_PREFIX`                             | HY-MT 官方中英翻译提示词模板                              |
| `OCR_PROMPT`                                | HunyuanOCR 官方`trans_other2zh` 任务提示词              |
| `SAMPLING` / `OCR_SAMPLING`               | 两个模型的官方推荐采样参数                                |
| `MIN_OUTPUT_TOKENS` / `MAX_OUTPUT_TOKENS` | 文本翻译输出 token 上下限，实际上限 = 原文字符数 / 2 + 32 |
| `MAX_INPUT_CHARS`                           | 文本翻译原文截断长度                                      |
| `OCR_MAX_TOKENS`                            | 截图翻译输出上限（原文 + 译文）                           |
| `OCR_MAX_SIDE`                              | 截图长边超过该像素时等比缩小                              |

两个服务地址默认是 `http://127.0.0.1:8001` 和 `http://127.0.0.1:8002`，可在面板顶部修改。

## 本地开发

不打包、直接加载源码目录：

1. 在 Zotero 配置目录的 `extensions` 文件夹中，新建一个名为 `ai-paper-reader@maipeng.com` 的文本文件。
2. 文件内容写入本仓库 `zotero-plugin` 目录的绝对路径，即 `<仓库目录>/zotero-plugin`。
3. 重启 Zotero。修改后若未生效，用 `-purgecaches` 参数启动以清除缓存。

## 目录结构

```text
zotero-plugin/
├── bootstrap.js              插件全部逻辑：面板 UI、选中/截图翻译、流式请求、公式渲染
├── manifest.json
├── prefs.js                  默认配置（服务地址等）
├── chrome/
│   ├── content/lib/          KaTeX（公式渲染）
│   ├── content/icons/
│   └── skin/panel.css        面板样式
└── locale/
```

## 许可

- [KaTeX](https://katex.org/)：MIT，见 `zotero-plugin/chrome/content/lib/KATEX_LICENSE`
- [HY-MT1.5](https://huggingface.co/tencent/HY-MT1.5-1.8B)、[HunyuanOCR](https://huggingface.co/tencent/HunyuanOCR)：模型权重遵循腾讯混元各自的许可协议
