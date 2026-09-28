/* global Services, Components, ChromeUtils, APP_SHUTDOWN, Zotero */

// ── 常量 ────────────────────────────────────────────────────────────────────

const ADDON_ID    = "ai-paper-reader@maipeng.com";
const ADDON_REF   = "ai-paper-reader";
const PREF_KEY    = "extensions.ai-paper-reader.";
const DEFAULT_API = "http://127.0.0.1:8001";   // 本地 vLLM 服务（OpenAI 兼容接口）
const LEGACY_API  = "http://127.0.0.1:8000";   // 旧版 FastAPI 后端地址，自动迁移到 DEFAULT_API
const HTML_NS     = "http://www.w3.org/1999/xhtml";

// ── 翻译模型（HY-MT1.5-1.8B，由 vllm serve --served-model-name hy-mt 提供）──
const MODEL_NAME  = "hy-mt";
// 官方 ZH<=>XX 提示词模板，原文前空一行；中译英时目标语言为「英语」
const PROMPT_PREFIX    = "将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n";
const PROMPT_PREFIX_EN = "将以下文本翻译为英语，注意只需要输出翻译后的结果，不要额外解释：\n\n";
// 官方推荐采样参数
const SAMPLING = { temperature: 0.7, top_p: 0.6, top_k: 20, repetition_penalty: 1.05 };
// 输出长度与原文成正比：英文约 4 字符/token，译文 token 数一般不超过原文的 1.5 倍
const MIN_OUTPUT_TOKENS = 64;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_INPUT_CHARS    = 4000;   // 需与 vllm serve --max-model-len 4096 匹配，超出部分截断
const MAX_INPUT_CHARS_ZH = 1500;   // 中文每字约 1 token，译成英文后 token 更多，截断得更早

// 英译中：英文约 4 字符/token，译文 token 数一般不超过原文的 1.5 倍；中译英：每个汉字约 1.2 个英文 token
function outputTokenLimit(text, toEnglish = false) {
  const estimate = Math.floor(text.length * (toEnglish ? 1.2 : 0.5)) + 32;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, estimate));
}

// 翻译方向：汉字数 ≥ 英文单词数时判为中文（中译英）
function isChinese(text) {
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (text.match(/[A-Za-z]+/g) || []).length;
  return han > 0 && han >= words;
}

// ── 截图翻译（HunyuanOCR-1.5，由 vllm serve --served-model-name hy-ocr 提供）──
const DEFAULT_OCR_API = "http://127.0.0.1:8002";
const OCR_MODEL_NAME  = "hy-ocr";
// 官方 trans_other2zh 任务提示词：先按阅读顺序提取原文（公式为 LaTeX），再输出中文译文
const OCR_PROMPT = "按照阅读顺序，提取图中文字，公式用latex格式表示，表格用markdown格式表示，再将文字内容翻译为中文。";
// 官方 trans_other2en 任务：截图是中文时改用它译成英文
const OCR_PROMPT_EN = "按照阅读顺序，提取图中文字，公式用latex格式表示，表格用markdown格式表示，再将文字内容翻译为英文。";
const OCR_DETECT_CHARS = 20;   // 识别出这么多个非公式字符后判断截图语言
// 官方客户端采样参数（贪心解码）
const OCR_SAMPLING = { temperature: 0, top_p: 1.0, top_k: -1, repetition_penalty: 1.08, skip_special_tokens: true };
const OCR_MAX_TOKENS = 4096;   // 原文 + 译文；需与 vllm serve --max-model-len 8192 配套
const OCR_MAX_SIDE   = 2048;   // 截图长边超过该像素时等比缩小，控制图像 token 数
// 模型输出格式："图中的文字是\n<原文>\n翻译成中文为\n<译文>"（译成英文时标记为 OCR_TRANS_MARKS 中的另一个）
const OCR_SRC_MARK   = "图中的文字是";
const OCR_TRANS_MARKS = ["翻译成中文为", "翻译成英文为"];

const PING_INTERVAL_MS = 2 * 60 * 1000;   // 顶部服务状态圆点的检测间隔

var chromeHandle = null;
var styleSheetSvc = null;
var styleURI = null;
var katex = null;   // 启动时从 chrome/content/lib/katex.min.js 加载，用于渲染 LaTeX 公式

// 每个 pane 实例的状态（key = body 上的 data-uid）
const panels = new Map();

// ── 插件生命周期 ─────────────────────────────────────────────────────────────

function install() {}
function uninstall() {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise;
  if (!rootURI) rootURI = resourceURI.spec;
  if (!rootURI.endsWith("/")) rootURI += "/";

  // 1. 注册 chrome URI，使 chrome://ai-paper-reader/content/... 可访问
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [["content", ADDON_REF, rootURI + "chrome/content/"]]
  );

  // 2. 向 L10nRegistry 注册 FTL 来源，让 Zotero 的 l10n 系统能找到我们的翻译文件
  try {
    const { L10nRegistry, FileSource } = ChromeUtils.importESModule(
      "resource://gre/modules/L10nRegistry.sys.mjs"
    );
    const src = new FileSource(ADDON_REF, ["en-US"], rootURI + "locale/{locale}/");
    L10nRegistry.getInstance().registerSources([src]);
  } catch (e) {
    Zotero.debug(`[AI Translate] L10nRegistry 注册失败: ${e}`);
  }

  // 3. 全局注册 CSS（AUTHOR_SHEET 在所有窗口中生效）
  try {
    styleSheetSvc = Components.classes["@mozilla.org/content/style-sheet-service;1"]
      .getService(Components.interfaces.nsIStyleSheetService);
    styleURI = Services.io.newURI(rootURI + "chrome/skin/panel.css");
    if (!styleSheetSvc.sheetRegistered(styleURI, styleSheetSvc.AUTHOR_SHEET)) {
      styleSheetSvc.loadAndRegisterSheet(styleURI, styleSheetSvc.AUTHOR_SHEET);
    }
  } catch (e) {
    Zotero.debug(`[AI Translate] CSS 注册失败: ${e}`);
  }

  // 4. 加载 KaTeX：截图翻译结果中的 LaTeX 公式渲染为 MathML（Zotero 原生支持，无需字体）
  try {
    const scope = {};
    scope.self = scope;   // KaTeX 的 UMD 包装会把 katex 挂到 self 上
    Services.scriptloader.loadSubScript(rootURI + "chrome/content/lib/katex.min.js", scope);
    katex = scope.katex || null;
  } catch (e) {
    Zotero.debug(`[AI Translate] KaTeX 加载失败: ${e}`);
  }

  // 5. 注册侧边栏 section（显示在 Zotero 条目面板右侧）
  Zotero.ItemPaneManager.registerSection({
    paneID:   "ai-translate",
    pluginID: ADDON_ID,
    header: {
      l10nID: "ai-paper-reader-section-header",
      icon:   `chrome://${ADDON_REF}/content/icons/sparkle.svg`,
    },
    sidenav: {
      l10nID: "ai-paper-reader-section-sidenav",
      icon:   `chrome://${ADDON_REF}/content/icons/sparkle.svg`,
    },
    onInit({ body, doc }) {
      body.style.cssText = "display:flex;flex-direction:column;overflow:hidden;padding:0;";
      buildUI(body, doc);
      // 让面板高度跟随条目面板的可用空间：撑满所在的滚动容器
      try {
        const win = doc.defaultView;
        const BOTTOM_GAP = 8;   // 底部留一点余量
        const MIN_HEIGHT = 300; // 兜底最小高度，避免被压到无法使用

        // 找到最近的可滚动祖先（Zotero 条目面板的滚动容器）
        const findScroller = () => {
          let el = body.parentElement;
          while (el && el !== doc.documentElement) {
            const oy = win.getComputedStyle(el).overflowY;
            if (oy === "auto" || oy === "scroll") return el;
            el = el.parentElement;
          }
          return doc.documentElement;
        };
        const scroller = findScroller();

        const fitHeight = () => {
          try {
            if (!win) return;
            // body 顶部相对滚动容器顶部的偏移（即上方控件占用的高度）
            const offset = body.getBoundingClientRect().top
                         - scroller.getBoundingClientRect().top;
            const avail = scroller.clientHeight - offset - BOTTOM_GAP;
            body.style.height = Math.max(MIN_HEIGHT, Math.round(avail)) + "px";
          } catch (_) {}
        };

        fitHeight();
        win?.requestAnimationFrame(fitHeight);  // 等布局稳定后再算一次
        win?.addEventListener("resize", fitHeight);
        body._aitResize = fitHeight;

        if (win?.ResizeObserver) {
          // 监听滚动容器本身：拖动分隔条 / 展开折叠其它 section 都会触发
          const ro = new win.ResizeObserver(fitHeight);
          ro.observe(scroller);
          if (scroller !== body.parentElement && body.parentElement) {
            ro.observe(body.parentElement);
          }
          body._aitRO = ro;
        }
      } catch (_) {}
    },
    onDestroy({ body }) {
      try { body._aitRO?.disconnect(); } catch (_) {}
      try {
        const win = body.ownerDocument?.defaultView;
        if (win && body._aitResize) win.removeEventListener("resize", body._aitResize);
      } catch (_) {}
      const uid = body.dataset.uid;
      disposePanel(panels.get(uid));
      if (uid) panels.delete(uid);
    },
    onRender() {},
  });

  // 6. 监听 PDF 选中文字事件
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onReaderSelection,
    ADDON_ID
  );

  // 7. 已打开的主窗口挂上 F 快捷键（之后打开的窗口在 onMainWindowLoad 中挂）
  for (const win of Zotero.getMainWindows?.() || []) attachKeyHandler(win);
}

async function onMainWindowLoad({ window }) {
  // 向每个窗口注入 FTL，section header 才能正确显示中文标题
  try {
    window.MozXULElement?.insertFTLIfNeeded(`${ADDON_REF}.ftl`);
  } catch (_) {}
  // 焦点在主窗口（如点过翻译面板）时也能按 F 翻译
  attachKeyHandler(window);
}

async function onMainWindowUnload({ window }) {}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;

  try { Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", onReaderSelection); } catch (_) {}
  try { Zotero.ItemPaneManager.unregisterSection("ai-translate"); } catch (_) {}

  try {
    if (styleSheetSvc && styleURI &&
        styleSheetSvc.sheetRegistered(styleURI, styleSheetSvc.AUTHOR_SHEET)) {
      styleSheetSvc.unregisterSheet(styleURI, styleSheetSvc.AUTHOR_SHEET);
    }
  } catch (_) {}

  try {
    const { L10nRegistry } = ChromeUtils.importESModule(
      "resource://gre/modules/L10nRegistry.sys.mjs"
    );
    L10nRegistry.getInstance().removeSources([ADDON_REF]);
  } catch (_) {}

  detachKeyHandlers();
  for (const panel of panels.values()) disposePanel(panel);
  panels.clear();
  closeDict();
  katex = null;

  if (chromeHandle) { chromeHandle.destruct(); chromeHandle = null; }
}

// ── 选中事件 ─────────────────────────────────────────────────────────────────

function onReaderSelection(event) {
  const text = getSelectionText(event);
  if (!text) return;

  // 阅读器窗口及其中的 PDF 视图 iframe 挂上 F 快捷键（视图可能重建，每次选中时补挂）
  try {
    const readerWin = event.reader?._iframeWindow || event.doc?.defaultView;
    attachKeyHandler(readerWin);
    for (const frame of readerWin?.document?.querySelectorAll("iframe") || []) {
      attachKeyHandler(frame.contentWindow);
    }
  } catch (_) {}

  let merged = 0;   // 非自动模式下，本次选中是待翻译文本的第几段
  for (const panel of panels.values()) {
    if (panel.state.autoTranslate) {
      sendMessage(panel, text);
    } else {
      merged = Math.max(merged, appendSelection(panel, text));
    }
  }

  // 在选中弹窗中添加提示
  try {
    const note = event.doc.createElement("div");
    note.style.cssText =
      "margin-top:5px;padding:3px 8px;border-radius:4px;" +
      "background:#f0f7ff;color:#2b6fd6;font-size:11px;";
    note.textContent = getPref("autoTranslate", true) !== false
      ? "已发送至 AI 翻译"
      : getPref("mergeSelections", false) === true
        ? `已加入待翻译（第 ${merged} 段）· 按 F 翻译`
        : "已放入输入框 · 按 F 翻译";
    event.append(note);
  } catch (_) {}
}

// 跨页合并：上一段以"字母-"结尾且下一段以小写字母开头时视为断词，去掉连字符直接拼接；否则用空格连接
function mergeSelection(prev, next) {
  prev = prev.replace(/\s+$/, "");
  next = next.replace(/^\s+/, "");
  if (!prev) return next;
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(next)) return prev.slice(0, -1) + next;
  return prev + " " + next;
}

// 非自动模式：把选中文字放入输入框，返回当前段数。
// 开启「合并」时追加到已有内容后面，否则替换。不抢焦点，否则按 F 会输入到输入框里
function appendSelection(panel, text) {
  const ta = panel.els.textarea;
  if (!ta) return 0;
  const merge = panel.state.mergeSelections && !!ta.value.trim();
  // 同一选区的弹窗可能重复渲染，忽略与上一段相同的文本
  if (merge && text === panel.state.lastSegment) return panel.state.segments;
  ta.value = merge ? mergeSelection(ta.value, text) : text;
  panel.state.lastSegment = text;
  panel.state.segments = merge ? panel.state.segments + 1 : 1;
  ta.dispatchEvent(new ta.ownerDocument.defaultView.Event("input"));
  setStatus(panel, panel.state.segments > 1
    ? `已合并 ${panel.state.segments} 段 · 按 F 翻译`
    : "已放入输入框 · 按 F 翻译", false);
  return panel.state.segments;
}

// ── F 快捷键（非自动模式下翻译输入框中的待翻译文本）──────────────────────────

const keyWindows = new Set();

function attachKeyHandler(win) {
  if (!win || keyWindows.has(win)) return;
  // 清理已关闭的窗口（iframe 销毁后访问会抛 dead object）
  for (const w of keyWindows) {
    try { if (w.closed) keyWindows.delete(w); } catch (_) { keyWindows.delete(w); }
  }
  win.addEventListener("keydown", onTranslateKey, true);
  keyWindows.add(win);
}

function detachKeyHandlers() {
  for (const w of keyWindows) {
    try { w.removeEventListener("keydown", onTranslateKey, true); } catch (_) {}
  }
  keyWindows.clear();
}

function isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ["input", "textarea", "select"].includes(el.localName);
}

function onTranslateKey(e) {
  if (e.key !== "f" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing) return;
  // 正在输入框、批注编辑框等处打字时不拦截
  if (isEditable(e.target) || isEditable(e.target?.ownerDocument?.activeElement)) return;
  let handled = false;
  for (const panel of panels.values()) {
    if (panel.state.autoTranslate || panel.state.pending || !panel.els.textarea?.value.trim()) continue;
    submitFromInput(panel);
    handled = true;
  }
  // 没有待翻译文本时不拦截，F 保持原有行为
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function getSelectionText(event) {
  const { params } = event;
  for (const v of [
    params?.annotation?.text,
    params?.annotation?.comment,
    params?.text,
    params?.selectionText,
  ]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  try {
    const s = event.reader?._iframeWindow?.getSelection?.().toString();
    if (s?.trim()) return s.trim();
  } catch (_) {}
  return "";
}

// ── Prefs ────────────────────────────────────────────────────────────────────

function getPref(key, fallback) {
  try {
    const v = Zotero.Prefs.get(PREF_KEY + key, true);
    return v === undefined ? fallback : v;
  } catch (_) { return fallback; }
}

function setPref(key, value) {
  try { Zotero.Prefs.set(PREF_KEY + key, value, true); } catch (_) {}
}

// ── UI 构建 ───────────────────────────────────────────────────────────────────

function h(doc, tag, attrs, children) {
  const el = doc.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "className")  el.className = v;
    else if (k === "text")  el.textContent = v;
    else if (k === "html")  el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of (children || [])) {
    if (typeof c === "string") el.appendChild(doc.createTextNode(c));
    else if (c) el.appendChild(c);
  }
  return el;
}

// 行内 $…$ / \(…\) 与独立 $$…$$ / \[…\] 公式
const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;

// 将 Markdown 文本直接渲染为 DOM 节点（除 KaTeX 生成的 MathML 外不经过 innerHTML）
// 支持：# 标题、**粗体**、`行内代码`、> 引用、--- 分割线、| 表格、段落
// opts.math：渲染 LaTeX 公式（仅用于截图翻译，避免普通文本里的 $ 被误判为公式）
function renderToDOM(raw, doc, opts = {}) {
  const frag = doc.createDocumentFragment();

  function el(tag) { return doc.createElementNS(HTML_NS, tag); }

  // 用 KaTeX 渲染为 MathML；公式有误或 KaTeX 不可用时显示 LaTeX 原文
  function appendMath(parent, part) {
    const display = part.startsWith("$$") || part.startsWith("\\[");
    const tex = (display || part.startsWith("\\(") ? part.slice(2, -2) : part.slice(1, -1)).trim();
    const span = el("span");
    span.className = display ? "ait-math ait-math-display" : "ait-math";
    span.title = tex;
    try {
      span.innerHTML = katex.renderToString(tex, { output: "mathml", displayMode: display, throwOnError: true });
    } catch (_) {
      span.textContent = part;
      span.classList.add("ait-math-raw");
    }
    parent.appendChild(span);
  }

  function appendInline(parent, text) {
    if (!opts.math || !katex) { appendRich(parent, text); return; }
    // split 带捕获组：奇数下标是公式，偶数下标是普通文本
    text.split(MATH_RE).forEach((part, i) => {
      if (!part) return;
      if (i % 2) appendMath(parent, part);
      else appendRich(parent, part);
    });
  }

  // 处理 **bold** 和 `code` 行内语法
  function appendRich(parent, text) {
    const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
    for (const part of parts) {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        const strong = el("strong");
        strong.textContent = part.slice(2, -2);
        parent.appendChild(strong);
      } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        const code = el("code");
        code.textContent = part.slice(1, -1);
        parent.appendChild(code);
      } else if (part) {
        parent.appendChild(doc.createTextNode(part));
      }
    }
  }

  // 构建 Markdown 表格（| 开头 | 结尾的行集合）
  function buildTable(tableLines) {
    const table = el("table");
    table.className = "ait-table";
    let headerCells = null;
    let bodyRows = [];
    let pastSep = false;

    for (const line of tableLines) {
      // 分隔行：只包含 |、-、:、空格
      if (/^\|[\|\-\:\s]+\|$/.test(line) && line.includes("-")) {
        pastSep = true;
        continue;
      }
      const cells = line.slice(1, -1).split("|").map(c => c.trim());
      if (!pastSep) {
        headerCells = cells;
      } else {
        bodyRows.push(cells);
      }
    }

    if (headerCells) {
      const thead = el("thead");
      const tr = el("tr");
      for (const cell of headerCells) {
        const th = el("th");
        appendInline(th, cell);
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (bodyRows.length > 0) {
      const tbody = el("tbody");
      for (const row of bodyRows) {
        const tr = el("tr");
        for (const cell of row) {
          const td = el("td");
          appendInline(td, cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    return table;
  }

  const lines = raw.split("\n");
  let paraLines  = [];
  let tableLines = [];
  let inTable    = false;

  function flushPara() {
    if (!paraLines.length) return;
    const text = paraLines.join("\n").trim();
    if (text) {
      const p = el("p");
      appendInline(p, text);
      frag.appendChild(p);
    }
    paraLines = [];
  }

  function flushTable() {
    if (!tableLines.length) return;
    frag.appendChild(buildTable(tableLines));
    tableLines = [];
    inTable = false;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // 表格行：以 | 开头且以 | 结尾
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1) {
      if (!inTable) { flushPara(); inTable = true; }
      tableLines.push(trimmed);
      continue;
    }

    if (inTable) flushTable();

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      flushPara();
      const h = el(`h${hMatch[1].length}`);
      appendInline(h, hMatch[2]);
      frag.appendChild(h);
    } else if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      flushPara();
      frag.appendChild(el("hr"));
    } else if (trimmed.startsWith("> ")) {
      flushPara();
      const bq = el("blockquote");
      appendInline(bq, trimmed.slice(2));
      frag.appendChild(bq);
    } else if (trimmed === "") {
      flushPara();
    } else {
      paraLines.push(line);
    }
  }

  if (inTable) flushTable();
  flushPara();
  return frag;
}

function buildUI(body, doc) {
  const uid = Math.random().toString(36).slice(2, 10);
  body.dataset.uid = uid;

  const state = {
    uid,
    pending:       false,
    autoTranslate: getPref("autoTranslate", true) !== false,
    mergeSelections: getPref("mergeSelections", false) === true,   // 非自动模式下多次选中是否合并
    apiBase:       (() => {
      const v = (getPref("apiBase", DEFAULT_API) || DEFAULT_API).replace(/\/+$/, "");
      return v === LEGACY_API ? DEFAULT_API : v;
    })(),
    ocrApiBase:    (getPref("ocrApiBase", DEFAULT_OCR_API) || DEFAULT_OCR_API).replace(/\/+$/, ""),
    dictPath:      getPref("dictPath", "") || "",   // ECDICT 词典文件（build_ecdict.py 生成）
    segments:      0,    // 非自动模式下输入框中已合并的选中段数
    lastSegment:   "",   // 上一次合并的选中文本，用于忽略重复事件
  };
  const els = {};
  panels.set(uid, { state, els });

  // ── 顶栏控件 ──
  els.statusDot  = h(doc, "span", { className: "ait-dot" });
  els.statusText = h(doc, "span", { className: "ait-status", text: "就绪" });

  // 开关：状态保存到 state[key] 和同名偏好
  const toggle = (key, label, onChange) => {
    const input = h(doc, "input", { type: "checkbox" });
    input.checked = state[key];
    input.addEventListener("change", () => {
      state[key] = input.checked;
      setPref(key, input.checked);
      onChange?.();
    });
    const el = h(doc, "label", { className: "ait-toggle" }, [input,
      h(doc, "span", { className: "ait-toggle-track" }),
      h(doc, "span", { className: "ait-toggle-label", text: label }),
    ]);
    return { el, input };
  };
  // 「合并」只在非自动模式下起作用，自动模式时置灰
  const syncMerge = () => {
    mergeToggle.input.disabled = state.autoTranslate;
    mergeToggle.el.classList.toggle("is-disabled", state.autoTranslate);
  };
  const autoToggle  = toggle("autoTranslate", "自动", syncMerge);
  const mergeToggle = toggle("mergeSelections", "合并");
  syncMerge();

  // 服务地址胶囊：● 名称 地址。显示时省略 http://；回车或失焦后保存，清空恢复默认
  els.endpoints = {};
  const endpoint = (key, label, def) => {
    const dot = h(doc, "span", { className: "ait-endpoint-dot" });
    const input = h(doc, "input", {
      className:   "ait-endpoint-input",
      type:        "text",
      value:       hostOf(state[key]),
      placeholder: hostOf(def),
      spellcheck:  "false",
    });
    input.addEventListener("change", () => {
      const v = input.value.trim().replace(/\/+$/, "");
      state[key] = v ? (/^https?:\/\//.test(v) ? v : "http://" + v) : def;
      input.value = hostOf(state[key]);
      setPref(key, state[key]);
      refreshEndpoint({ state, els }, key);
    });
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
    els.endpoints[key] = { dot };
    return h(doc, "label", { className: "ait-endpoint" }, [
      dot,
      h(doc, "span", { className: "ait-endpoint-label", text: label }),
      input,
    ]);
  };
  const transChip = endpoint("apiBase", "翻译", DEFAULT_API);
  const ocrChip   = endpoint("ocrApiBase", "OCR", DEFAULT_OCR_API);

  // 词典胶囊：● 词典 文件名，点击选择 build_ecdict.py 生成的 .db 文件
  const dictDot  = h(doc, "span", { className: "ait-endpoint-dot" });
  const dictName = h(doc, "span", { className: "ait-endpoint-file" });
  els.showDictName = () => {
    dictName.textContent = state.dictPath ? state.dictPath.split(/[\\/]/).pop() : "点击选择";
    dictName.classList.toggle("is-empty", !state.dictPath);
  };
  els.showDictName();
  els.endpoints.dictPath = { dot: dictDot };
  const dictChip = h(doc, "button", {
    className: "ait-endpoint ait-endpoint-btn", type: "button",
    onclick: () => pickDict({ state, els }),
  }, [dictDot, h(doc, "span", { className: "ait-endpoint-label", text: "词典" }), dictName]);

  const clearBtn = h(doc, "button", {
    className: "ait-action-btn ait-action-ghost", type: "button", text: "清空",
    onclick: () => panelClear({ state, els }),
  });

  // ── 顶栏：标题行 + 服务地址行 ──
  const topbar = h(doc, "div", { className: "ait-topbar" }, [
    h(doc, "div", { className: "ait-topbar-row" }, [
      h(doc, "div", { className: "ait-topbar-left" }, [
        els.statusDot,
        h(doc, "span", { className: "ait-title", text: "AI 翻译" }),
      ]),
      h(doc, "div", { className: "ait-topbar-right" }, [
        els.statusText,
        autoToggle.el,
        mergeToggle.el,
        clearBtn,
      ]),
    ]),
    h(doc, "div", { className: "ait-endpoints" }, [transChip, ocrChip, dictChip]),
  ]);

  // ── 消息区（空状态 + 动态卡片）──
  els.empty = h(doc, "div", { className: "ait-empty" }, [
    h(doc, "div", { className: "ait-empty-icon", text: "✦" }),
    h(doc, "div", { text: "在 PDF 中选中英文，或在下方输入" }),
    h(doc, "div", { className: "ait-empty-sub", text: "截图后在输入框 Ctrl+V，可翻译含公式的内容" }),
    h(doc, "div", { className: "ait-empty-sub", text: "关闭「自动」后按 F 翻译，打开「合并」可把多次选中合在一起" }),
  ]);
  els.messages = h(doc, "div", { className: "ait-messages" }, [els.empty]);

  // ── 输入区 ──
  els.textarea = h(doc, "textarea", {
    className:   "ait-input",
    placeholder: "输入英文，或 Ctrl+V 粘贴截图…  Enter 翻译",
    rows:        "1",
    spellcheck:  "false",
  });
  els.textarea.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitFromInput({ state, els });
    }
  });
  els.textarea.addEventListener("input", () => {
    els.textarea.style.height = "auto";
    els.textarea.style.height = Math.min(els.textarea.scrollHeight, 120) + "px";
    if (!els.textarea.value.trim()) { state.segments = 0; state.lastSegment = ""; }
  });

  els.sendBtn = h(doc, "button", {
    className: "ait-send-btn", type: "button",
    onclick: () => submitFromInput({ state, els }),
  });
  const sendLabel = doc.createElementNS(HTML_NS, "span");
  sendLabel.textContent = "↑";
  els.sendBtn.appendChild(sendLabel);

  const inputArea = h(doc, "div", { className: "ait-input-area" }, [
    h(doc, "div", { className: "ait-input-wrap" }, [els.textarea]),
    els.sendBtn,
  ]);

  // 粘贴截图：剪贴板里有图片时走截图翻译，否则按普通文本粘贴
  els.textarea.addEventListener("paste", e => {
    const file = imageFromTransfer(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    sendImage({ state, els }, file);
  });

  const root = h(doc, "div", { className: "ait-root" }, [topbar, els.messages, inputArea]);

  // 拖入图片文件到面板任意位置
  root.addEventListener("dragover", e => {
    const items = Array.from(e.dataTransfer?.items || []);
    if (items.some(i => i.kind === "file" && i.type.startsWith("image/"))) e.preventDefault();
  });
  root.addEventListener("drop", e => {
    const file = imageFromTransfer(e.dataTransfer);
    if (!file) return;
    e.preventDefault();
    sendImage({ state, els }, file);
  });

  body.appendChild(root);

  // 面板高度变化时（拖动分隔条、缩放窗口），让最新一轮继续占满可视区
  const win = doc.defaultView;
  if (win?.ResizeObserver) {
    els.messagesRO = new win.ResizeObserver(() => fitTurn({ els }));
    els.messagesRO.observe(els.messages);
  }

  // 每 2 分钟检测两个服务是否可用，更新地址胶囊上的圆点（每次翻译结束后也会立即检测）
  const refreshAll = () => {
    if (!els.messages.isConnected) return;
    refreshEndpoint({ state, els }, "apiBase");
    refreshEndpoint({ state, els }, "ocrApiBase");
    refreshEndpoint({ state, els }, "dictPath");
  };
  refreshAll();
  els.win = win;
  els.pingTimer = win?.setInterval(refreshAll, PING_INTERVAL_MS);
}

// ── 消息卡片 ──────────────────────────────────────────────────────────────────

// 每一轮翻译（原文卡 + 结果卡）放在一个 .ait-turn 里。
// 最新一轮至少占满消息区的可视高度，并滚动到顶部：历史对话被推到上方，滚轮向上即可查看。

// 让最新一轮的最小高度 = 可视高度 − 轮间距 − 底部内边距，
// 这样才能滚到"上方只留一个轮间距"的位置，上一轮恰好完全移出视口
function fitTurn(panel) {
  const box = panel.els.messages, turn = panel.els.turn;
  if (!box || !turn) return;
  const cs = box.ownerDocument.defaultView.getComputedStyle(box);
  const gap = parseFloat(cs.rowGap) || 0;
  turn.style.minHeight = Math.max(0, box.clientHeight - gap - parseFloat(cs.paddingBottom)) + "px";
}

function startTurn(panel) {
  const doc = panel.els.messages.ownerDocument;
  if (panel.els.empty.parentElement === panel.els.messages)
    panel.els.messages.removeChild(panel.els.empty);
  if (panel.els.turn) panel.els.turn.style.minHeight = "";   // 上一轮恢复自然高度
  panel.els.turn = h(doc, "div", { className: "ait-turn" });
  panel.els.messages.appendChild(panel.els.turn);
  fitTurn(panel);
  return panel.els.turn;
}

// 把最新一轮滚到顶部，上方只留一个轮间距（.ait-messages 设置了 scroll-behavior: smooth）
function scrollTurnToTop(panel) {
  const box = panel.els.messages, turn = panel.els.turn;
  if (!box || !turn) return;
  const gap = parseFloat(box.ownerDocument.defaultView.getComputedStyle(box).rowGap) || 0;
  box.scrollTop += turn.getBoundingClientRect().top - box.getBoundingClientRect().top - gap;
}

function appendUserMsg(panel, text) {
  const doc = panel.els.messages.ownerDocument;
  const content = h(doc, "div", { className: "ait-msg-content" });
  content.textContent = text;
  const card = h(doc, "div", { className: "ait-msg ait-msg-user" }, [
    h(doc, "div", { className: "ait-msg-label", text: "原文" }),
    content,
  ]);
  startTurn(panel).appendChild(card);
}

// 结果卡底部的「复制原文 / 复制译文」，读取 view.source / view.translation；完成后再显示
function copyActions(doc, view) {
  const copySrc = h(doc, "button", { className: "ait-mini-btn", type: "button", text: "复制原文",
    onclick: () => copyText(doc, view.source, copySrc) });
  const copyTrans = h(doc, "button", { className: "ait-mini-btn", type: "button", text: "复制译文",
    onclick: () => copyText(doc, view.translation, copyTrans) });
  return h(doc, "div", { className: "ait-card-actions", hidden: "" }, [copySrc, copyTrans]);
}

// 词典卡片的一个词条：单词 + 音标 + 标签，按词性分行的全部释义，词形变化
function dictEntryNodes(doc, entry, isLemma) {
  const nodes = [];
  const badges = entry.tag.split(/\s+/).filter(t => DICT_TAGS[t]).map(t => DICT_TAGS[t]);
  if (entry.collins) badges.push("★".repeat(entry.collins));
  if (entry.oxford) badges.push("牛津3000");
  nodes.push(h(doc, "div", { className: "ait-dict-head" }, [
    isLemma ? h(doc, "span", { className: "ait-dict-lemma-tag", text: "原形" }) : null,
    h(doc, "span", { className: isLemma ? "ait-dict-word is-lemma" : "ait-dict-word", text: entry.word }),
    entry.phonetic ? h(doc, "span", { className: "ait-dict-phonetic", text: `/${entry.phonetic}/` }) : null,
    ...badges.map(b => h(doc, "span", { className: "ait-dict-badge", text: b })),
  ]));
  // 每行一个义项，行首的 "n." "vt." "[计]" 等作为词性/领域标签
  for (const line of entry.translation.split("\n").map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^((?:[a-z]+\.)+|\[[^\]]+\])\s*(.*)$/);
    nodes.push(h(doc, "div", { className: "ait-dict-sense" }, m
      ? [h(doc, "span", { className: "ait-dict-pos", text: m[1] }), h(doc, "span", { text: m[2] })]
      : [h(doc, "span", { text: line })]));
  }
  const { forms } = parseExchange(entry.exchange);
  if (forms.length && !isLemma) {
    nodes.push(h(doc, "div", { className: "ait-dict-forms" },
      forms.flatMap((f, i) => [i ? " · " : null, f.name + " ", h(doc, "b", { text: f.value })])));
  }
  return nodes;
}

// 查词结果卡：词条 + 原形词条（如有）+ 复制按钮
function appendDictMsg(panel, { entry, lemma }) {
  const doc = panel.els.messages.ownerDocument;
  const text = [entry, lemma].filter(e => e?.translation)
    .map(e => (e === lemma ? `原形 ${e.word}\n` : "") + e.translation).join("\n\n");
  const view = { source: entry.word, translation: text };
  const content = h(doc, "div", { className: "ait-msg-content ait-dict" }, [
    ...(entry.translation || entry.phonetic ? dictEntryNodes(doc, entry, false) : []),
    ...(lemma?.translation ? [h(doc, "div", { className: "ait-dict-lemma" }, dictEntryNodes(doc, lemma, true))] : []),
  ]);
  const actions = copyActions(doc, view);
  actions.hidden = false;
  const card = h(doc, "div", { className: "ait-msg ait-msg-ai" }, [
    h(doc, "div", { className: "ait-msg-header" }, [
      h(doc, "span", { className: "ait-avatar", text: "词" }),
      h(doc, "span", { className: "ait-msg-label", text: "词典" }),
    ]),
    content,
    actions,
  ]);
  (panel.els.turn || startTurn(panel)).appendChild(card);
  scrollTurnToTop(panel);
}

// 汉英查词结果卡：每个英文候选一行（单词、音标、标签），下方是包含查询词的那条释义，查询词高亮
function appendZhDictMsg(panel, { term, candidates }) {
  const doc = panel.els.messages.ownerDocument;
  const view = { source: term, translation: candidates.map(c => c.word).join(", ") };
  const rows = candidates.map(c => {
    const badges = c.tag.split(/\s+/).filter(t => DICT_TAGS[t]).map(t => DICT_TAGS[t]);
    if (c.collins) badges.push("★".repeat(c.collins));
    const line = c.translation.split("\n").find(l => l.includes(term)) || "";
    return h(doc, "div", { className: "ait-zh-cand" }, [
      h(doc, "div", { className: "ait-dict-head" }, [
        h(doc, "span", { className: "ait-zh-word", text: c.word }),
        c.phonetic ? h(doc, "span", { className: "ait-dict-phonetic", text: `/${c.phonetic}/` }) : null,
        ...badges.map(b => h(doc, "span", { className: "ait-dict-badge", text: b })),
      ]),
      h(doc, "div", { className: "ait-zh-sense" }, line.split(term).flatMap((part, i) =>
        [i ? h(doc, "mark", { text: term }) : null, part])),
    ]);
  });
  const actions = copyActions(doc, view);
  actions.hidden = false;
  const card = h(doc, "div", { className: "ait-msg ait-msg-ai" }, [
    h(doc, "div", { className: "ait-msg-header" }, [
      h(doc, "span", { className: "ait-avatar", text: "词" }),
      h(doc, "span", { className: "ait-msg-label", text: "汉英词典" }),
    ]),
    h(doc, "div", { className: "ait-msg-content ait-dict" }, rows),
    actions,
  ]);
  (panel.els.turn || startTurn(panel)).appendChild(card);
  scrollTurnToTop(panel);
}

// 文本翻译结果卡：译文 + 复制按钮
function appendAiMsg(panel, source, label = "译文") {
  const doc = panel.els.messages.ownerDocument;
  const view = { source, translation: "" };
  view.content = h(doc, "div", { className: "ait-msg-content ait-streaming" });
  const cursor = doc.createElementNS(HTML_NS, "span");
  cursor.className = "ait-cursor";
  view.content.appendChild(cursor);
  view.actions = copyActions(doc, view);
  const card = h(doc, "div", { className: "ait-msg ait-msg-ai" }, [
    h(doc, "div", { className: "ait-msg-header" }, [
      h(doc, "span", { className: "ait-avatar", text: "AI" }),
      h(doc, "span", { className: "ait-msg-label", text: label }),
    ]),
    view.content,
    view.actions,
  ]);
  (panel.els.turn || startTurn(panel)).appendChild(card);
  scrollTurnToTop(panel);
  return view;
}

// ── 面板状态 ──────────────────────────────────────────────────────────────────

function setStatus(panel, text, busy) {
  if (panel.els.statusText) panel.els.statusText.textContent = text;
  if (panel.els.statusDot)
    panel.els.statusDot.className = "ait-dot" + (busy ? " is-busy" : "");
}

// 面板销毁或插件卸载时：停止尺寸监听和服务检测定时器
function disposePanel(panel) {
  if (!panel) return;
  try { panel.els.messagesRO?.disconnect(); } catch (_) {}
  try { panel.els.win?.clearInterval(panel.els.pingTimer); } catch (_) {}
}

function panelClear(panel) {
  panel.state.pending      = false;
  panel.state.segments     = 0;
  panel.state.lastSegment  = "";
  if (panel.els.textarea) { panel.els.textarea.value = ""; panel.els.textarea.style.height = ""; }
  panel.els.messages?.replaceChildren(panel.els.empty);
  panel.els.turn = null;
  setStatus(panel, "就绪", false);
}

// ── 发送逻辑（每次独立翻译，不带历史）────────────────────────────────────────

function submitFromInput(panel) {
  const text = panel.els.textarea?.value?.trim();
  if (!text) return;
  panel.els.textarea.value = "";
  panel.els.textarea.style.height = "";
  panel.state.segments = 0;
  panel.state.lastSegment = "";
  sendMessage(panel, text);
}

async function sendMessage(panel, userText) {
  if (!userText.trim() || panel.state.pending) return;
  panel.state.pending = true;

  const doc = panel.els.messages?.ownerDocument;
  if (!doc) { panel.state.pending = false; return; }

  appendUserMsg(panel, userText);

  // 汉字为主判为中译英，否则英译中
  const toEnglish = isChinese(userText);

  // 单词 / 短语：先查离线词典（中文词查英文候选，英文词查全部词义）；查不到或未配置词典时交给翻译模型
  try {
    const hit = toEnglish
      ? await lookupZh(panel.state.dictPath, userText)
      : await lookupDict(panel.state.dictPath, userText);
    if (hit) {
      (toEnglish ? appendZhDictMsg : appendDictMsg)(panel, hit);
      setStatus(panel, "查词完成", false);
      panel.state.pending = false;
      return;
    }
  } catch (e) {
    Zotero.debug(`[AI Translate] 查词失败: ${e}`);
  }

  // 追加 AI 回复卡（带光标）
  const view = appendAiMsg(panel, userText.trim(), toEnglish ? "译文（英）" : "译文");
  setStatus(panel, "翻译中…", true);

  let aiText = "";

  try {
    const source = userText.trim().slice(0, toEnglish ? MAX_INPUT_CHARS_ZH : MAX_INPUT_CHARS);
    const url  = panel.state.apiBase + "/v1/chat/completions";
    const body = JSON.stringify({
      model:      MODEL_NAME,
      messages:   [{ role: "user", content: (toEnglish ? PROMPT_PREFIX_EN : PROMPT_PREFIX) + source }],
      max_tokens: outputTokenLimit(source, toEnglish),
      stream:     true,
      ...SAMPLING,
    });

    const finishReason = await xhrSSE(url, body, chunk => {
      aiText = (aiText + chunk).replace(/^\s+/, "");
      // 不跟随滚动：本轮已对齐到顶部，译文在下方增长
      const frag = renderToDOM(aiText, doc);
      const cur = doc.createElementNS(HTML_NS, "span");
      cur.className = "ait-cursor";
      frag.appendChild(cur);
      view.content.replaceChildren(frag);
    });

    view.content.replaceChildren(renderToDOM(aiText, doc));
    view.content.className = "ait-msg-content";
    view.translation = aiText;
    view.actions.hidden = false;

    setStatus(panel, finishReason === "length" ? "完成（已达长度上限）" : "完成", false);
  } catch (err) {
    Zotero.debug(`[AI Translate] sendMessage 失败: ${err?.stack || err?.message || err}`);
    view.content.className = "ait-msg-content ait-error";
    view.content.textContent = "失败：" + (err?.message || "未知错误");
    setStatus(panel, "失败", false);
  }

  refreshEndpoint(panel, "apiBase");
  panel.state.pending = false;
}

// ── 查词（ECDICT 离线词典，由 tools/build_ecdict.py 生成）────────────────────

const DICT_FORMAT = "ai-paper-ecdict-2";   // build_ecdict.py 写入 meta 表的格式标识（2：含中文反查索引）
// 单词或不超过 4 个词的短语（如 take off）才查词典，其余交给翻译模型
const LOOKUP_RE = /^[A-Za-z]+(?:['-][A-Za-z]+)*(?: [A-Za-z]+(?:['-][A-Za-z]+)*){0,3}$/;
const DICT_TAGS  = { zk: "中考", gk: "高考", cet4: "四级", cet6: "六级", ky: "考研", toefl: "托福", ielts: "雅思", gre: "GRE" };
// 用 Map 保证显示顺序（普通对象会把数字键 "3" 排到最前）
const DICT_FORMS = new Map([["s", "复数"], ["p", "过去式"], ["d", "过去分词"], ["i", "现在分词"],
                            ["3", "三单"], ["r", "比较级"], ["t", "最高级"]]);
// 按小写匹配；大小写完全一致的词条优先，其次是全小写词条（如 US → us）
const DICT_SQL = "SELECT word, phonetic, translation, collins, oxford, tag, exchange FROM ecdict " +
                 "WHERE sw = :sw ORDER BY (word = :w) DESC, (word = :sw) DESC LIMIT 1";

// 中文词反查：1–8 个汉字，按 zh_index 的排序分取前 8 个英文候选
const ZH_LOOKUP_RE = /^[\u4e00-\u9fff]{1,8}$/;
const ZH_SQL = "SELECT z.word, e.phonetic, e.translation, e.collins, e.oxford, e.tag FROM zh_index z " +
               "JOIN ecdict e ON e.sw = z.word AND e.word = z.word WHERE z.term = :t ORDER BY z.score LIMIT 8";

// 当前词典连接。打开失败时清空 promise，下次查询会重试（例如词典文件稍后才生成）。
// oldFormat：选中的是旧版脚本生成的词典，需要重新运行 build_ecdict.py
var dict = { path: "", promise: null, oldFormat: false };

function openDict(path) {
  if (!path) return Promise.resolve(null);
  if (dict.path === path && dict.promise) return dict.promise;
  const previous = dict.promise;
  const promise = (async () => {
    try { await (await previous)?.close(); } catch (_) {}
    try {
      const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
      const conn = await Sqlite.openConnection({ path, readOnly: true });
      const rows = await conn.execute("SELECT value FROM meta WHERE key = 'format'");
      const format = rows[0]?.getResultByName("value") || "";
      if (format === DICT_FORMAT) return conn;
      if (dict.promise === promise) dict.oldFormat = format.startsWith("ai-paper-ecdict-");
      await conn.close();
    } catch (e) {
      Zotero.debug(`[AI Translate] 词典打开失败: ${e}`);
    }
    if (dict.promise === promise) dict.promise = null;
    return null;
  })();
  dict = { path, promise, oldFormat: false };
  return promise;
}

function closeDict() {
  const { promise } = dict;
  dict = { path: "", promise: null, oldFormat: false };
  promise?.then(conn => conn?.close()).catch(() => {});
}

async function findEntry(conn, word) {
  const rows = await conn.executeCached(DICT_SQL, { w: word, sw: word.toLowerCase() });
  if (!rows.length) return null;
  const get = key => rows[0].getResultByName(key);
  return {
    word:        get("word"),
    phonetic:    get("phonetic") || "",
    translation: get("translation") || "",
    collins:     get("collins") || 0,
    oxford:      get("oxford") || 0,
    tag:         get("tag") || "",
    exchange:    get("exchange") || "",
  };
}

// exchange 形如 "s:models/p:modelled/d:modelled/0:propose"：0 为原形，其余为词形变化。
// 按 DICT_FORMS 的顺序排列；同一个词形对应多个类型时合并标签，如 "过去式/过去分词 modelled"
function parseExchange(exchange) {
  let lemma = "";
  const byType = {};
  for (const item of exchange.split("/")) {
    const [type, value] = item.split(":");
    if (!value) continue;
    if (type === "0") lemma = value;
    else if (DICT_FORMS.has(type)) byType[type] = value;
  }
  const forms = new Map();
  for (const [type, name] of DICT_FORMS) {
    const value = byType[type];
    if (value) forms.set(value, [...(forms.get(value) || []), name]);
  }
  return { lemma, forms: [...forms].map(([value, names]) => ({ name: names.join("/"), value })) };
}

// 选中的是单词或短语且词典中有释义时返回 { entry, lemma }，否则返回 null（交给翻译模型）
async function lookupDict(path, text) {
  const word = text.replace(/[’‘]/g, "'").replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "").replace(/\s+/g, " ");
  if (!LOOKUP_RE.test(word)) return null;
  const conn = await openDict(path);
  if (!conn) return null;
  const entry = await findEntry(conn, word);
  if (!entry) return null;
  // 屈折形式（如 proposed）附上原形（propose）的释义
  const lemmaWord = parseExchange(entry.exchange).lemma;
  const lemma = lemmaWord && lemmaWord.toLowerCase() !== entry.word.toLowerCase()
    ? await findEntry(conn, lemmaWord) : null;
  if (!entry.translation && !lemma?.translation) return null;
  return { entry, lemma };
}

// 选中 / 输入的是中文词时返回 { term, candidates }，否则返回 null（交给翻译模型中译英）
async function lookupZh(path, text) {
  const term = text.replace(/[\s\p{P}]/gu, "");
  if (!ZH_LOOKUP_RE.test(term)) return null;
  const conn = await openDict(path);
  if (!conn) return null;
  const rows = await conn.executeCached(ZH_SQL, { t: term });
  if (!rows.length) return null;
  const candidates = rows.map(r => {
    const get = key => r.getResultByName(key);
    return {
      word: get("word"), phonetic: get("phonetic") || "", translation: get("translation") || "",
      collins: get("collins") || 0, oxford: get("oxford") || 0, tag: get("tag") || "",
    };
  });
  return { term, candidates };
}

// ── 截图翻译 ──────────────────────────────────────────────────────────────────

// 从剪贴板 / 拖放数据中取第一张图片
function imageFromTransfer(dt) {
  if (!dt) return null;
  for (const item of Array.from(dt.items || [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return Array.from(dt.files || []).find(f => f.type.startsWith("image/")) || null;
}

// 读入图片并统一转为 PNG data URL：透明背景填白，长边超过 OCR_MAX_SIDE 时等比缩小
async function prepareImage(win, file) {
  const src = await new Promise((resolve, reject) => {
    const reader = new win.FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
  const img = new win.Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, OCR_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = win.document.createElementNS(HTML_NS, "canvas");
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(img, 0, 0, w, hgt);
  return canvas.toDataURL("image/png");
}

// 拆分模型输出 "图中的文字是\n<原文>\n翻译成中文为\n<译文>"
// 流式输出时，末尾尚未收完整的标记前缀会被暂时隐藏
function splitOcrOutput(raw) {
  let text = raw.replace(/```[a-z]*\n?/gi, "");   // 去掉模型偶尔输出的代码围栏
  const lead = text.trimStart();
  if (OCR_SRC_MARK.startsWith(lead)) return { source: "", translation: "", hasTranslation: false };
  if (lead.startsWith(OCR_SRC_MARK)) text = lead.slice(OCR_SRC_MARK.length).replace(/^[：:]/, "");

  let i = -1, mark = "";
  for (const m of OCR_TRANS_MARKS) {
    const j = text.indexOf(m);
    if (j >= 0 && (i < 0 || j < i)) { i = j; mark = m; }
  }
  if (i < 0) {
    const hide = Math.max(0, ...OCR_TRANS_MARKS.map(m => {
      for (let k = m.length - 1; k > 0; k--) if (text.endsWith(m.slice(0, k))) return k;
      return 0;
    }));
    if (hide) text = text.slice(0, -hide);
    return { source: text.trim(), translation: "", hasTranslation: false };
  }
  return {
    source:         text.slice(0, i).trim(),
    translation:    text.slice(i + mark.length).replace(/^[：:]/, "").trim(),
    hasTranslation: true,
  };
}

function copyText(doc, text, btn) {
  if (!text) return;
  try { doc.defaultView?.navigator?.clipboard?.writeText(text); } catch (_) {}
  const old = btn.textContent;
  btn.textContent = "已复制";
  doc.defaultView?.setTimeout(() => { btn.textContent = old; }, 1500);
}

function appendUserImage(panel, dataURL) {
  const doc = panel.els.messages.ownerDocument;
  const card = h(doc, "div", { className: "ait-msg ait-msg-user" }, [
    h(doc, "div", { className: "ait-msg-label", text: "截图" }),
    h(doc, "div", { className: "ait-msg-content ait-msg-image-wrap" }, [
      h(doc, "img", { className: "ait-msg-image", src: dataURL, alt: "截图" }),
    ]),
  ]);
  startTurn(panel).appendChild(card);
}

// 截图翻译结果卡：可折叠的识别原文 + 译文 + 复制按钮
function appendOcrMsg(panel) {
  const doc = panel.els.messages.ownerDocument;
  const view = { source: "", translation: "" };
  view.sourceBody = h(doc, "div", { className: "ait-ocr-source-body" });
  view.details = h(doc, "details", { className: "ait-ocr-source", open: "" }, [
    h(doc, "summary", { text: "识别原文" }),
    view.sourceBody,
  ]);
  view.trans = h(doc, "div", { className: "ait-ocr-trans" });
  view.content = h(doc, "div", { className: "ait-msg-content ait-streaming" }, [view.details, view.trans]);
  view.actions = copyActions(doc, view);
  const card = h(doc, "div", { className: "ait-msg ait-msg-ai" }, [
    h(doc, "div", { className: "ait-msg-header" }, [
      h(doc, "span", { className: "ait-avatar", text: "AI" }),
      view.label = h(doc, "span", { className: "ait-msg-label", text: "截图翻译" }),
    ]),
    view.content,
    view.actions,
  ]);
  (panel.els.turn || startTurn(panel)).appendChild(card);
  scrollTurnToTop(panel);
  return view;
}

function renderOcr(view, doc, parts, streaming) {
  const withCursor = frag => {
    const cur = doc.createElementNS(HTML_NS, "span");
    cur.className = "ait-cursor";
    frag.appendChild(cur);
    return frag;
  };
  // 译文开始输出后自动收起原文，只在切换的那一刻收起一次，之后尊重用户的展开/收起
  if (parts.hasTranslation && !view.collapsed) { view.details.open = false; view.collapsed = true; }
  const src = renderToDOM(parts.source, doc, { math: true });
  view.sourceBody.replaceChildren(streaming && !parts.hasTranslation ? withCursor(src) : src);
  const trans = renderToDOM(parts.translation, doc, { math: true });
  view.trans.replaceChildren(streaming && parts.hasTranslation ? withCursor(trans) : trans);
  view.source = parts.source;
  view.translation = parts.translation;
}

async function sendImage(panel, file) {
  if (panel.state.pending) return;
  panel.state.pending = true;

  const doc = panel.els.messages?.ownerDocument;
  if (!doc) { panel.state.pending = false; return; }

  let view = null;
  try {
    const dataURL = await prepareImage(doc.defaultView, file);
    appendUserImage(panel, dataURL);
    view = appendOcrMsg(panel);
    setStatus(panel, "识别中…", true);

    const url  = panel.state.ocrApiBase + "/v1/chat/completions";
    const body = prompt => JSON.stringify({
      model:    OCR_MODEL_NAME,
      messages: [
        { role: "system", content: "" },
        { role: "user", content: [
          { type: "image_url", image_url: { url: dataURL } },
          { type: "text", text: prompt },
        ] },
      ],
      max_tokens: OCR_MAX_TOKENS,
      stream:     true,
      ...OCR_SAMPLING,
    });

    // 先按译成中文识别；识别出足够原文后判断一次语言，是中文就中止并改用 trans_other2en 重新请求
    let raw = "", checked = false;
    const onChunk = chunk => {
      raw += chunk;
      const parts = splitOcrOutput(raw);
      if (!checked) {
        const text = parts.source.replace(MATH_RE, " ");   // 公式里的 \mathbf 等不参与语言判断
        if (text.replace(/\s/g, "").length >= OCR_DETECT_CHARS || parts.hasTranslation) {
          checked = true;
          if (isChinese(text)) return "stop";
        }
      }
      if (parts.hasTranslation) setStatus(panel, "翻译中…", true);
      renderOcr(view, doc, parts, true);
    };
    let finishReason = await xhrSSE(url, body(OCR_PROMPT), onChunk);
    if (finishReason === "stopped") {
      raw = "";
      view.label.textContent = "截图翻译（英）";
      view.details.open = true;
      view.collapsed = false;
      renderOcr(view, doc, { source: "", translation: "", hasTranslation: false }, true);
      setStatus(panel, "检测到中文，改为译成英文…", true);
      finishReason = await xhrSSE(url, body(OCR_PROMPT_EN), onChunk);
    }

    const parts = splitOcrOutput(raw);
    renderOcr(view, doc, parts, false);
    view.content.className = "ait-msg-content";
    view.actions.hidden = false;
    if (!parts.hasTranslation) view.details.open = true;   // 没有译文时展开原文

    setStatus(panel,
      finishReason === "length" ? "完成（已达长度上限）"
        : parts.hasTranslation ? "完成" : "完成（模型未给出译文）",
      false);
  } catch (err) {
    Zotero.debug(`[AI Translate] sendImage 失败: ${err?.stack || err?.message || err}`);
    if (!view) { startTurn(panel); view = appendOcrMsg(panel); }   // 读图失败时单独成一轮
    view.details.hidden = true;
    view.content.className = "ait-msg-content ait-error";
    view.trans.textContent = "失败：" + (err?.message || "未知错误");
    setStatus(panel, "失败", false);
  }

  refreshEndpoint(panel, "ocrApiBase");
  panel.state.pending = false;
}

// ── XHR（mozBackgroundRequest 绕过 Firefox 私有网络访问限制）────────────────

function newXHR() {
  let xhr;
  try {
    xhr = new XMLHttpRequest();
  } catch (_) {
    xhr = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
      .createInstance(Components.interfaces.nsIXMLHttpRequest);
  }
  try { xhr.mozBackgroundRequest = true; } catch (_) {}
  return xhr;
}

// 地址显示时省略 http://（https:// 保留）
function hostOf(url) {
  return url.replace(/^http:\/\//, "");
}

// 服务是否可用：GET /v1/models，3 秒超时
function pingService(base) {
  return new Promise(resolve => {
    const xhr = newXHR();
    xhr.open("GET", base + "/v1/models", true);
    xhr.timeout = 3000;
    xhr.onload    = () => resolve(xhr.status === 200);
    xhr.onerror   = () => resolve(false);
    xhr.ontimeout = () => resolve(false);
    try { xhr.send(); } catch (_) { resolve(false); }
  });
}

// 更新胶囊上的状态圆点：绿 = 可用，红 = 无法连接 / 词典无效，灰 = 未设置词典
async function refreshEndpoint(panel, key) {
  const ep = panel.els.endpoints?.[key];
  if (!ep) return;
  const base = panel.state[key];
  if (key === "dictPath" && !base) { ep.dot.className = "ait-endpoint-dot"; return; }
  const up = key === "dictPath" ? !!(await openDict(base)) : await pingService(base);
  if (panel.state[key] !== base) return;   // 检测期间地址被改过，结果作废
  ep.dot.className = "ait-endpoint-dot " + (up ? "is-up" : "is-down");
}

// 用 Zotero 的文件选择框选择词典文件
async function pickDict(panel) {
  try {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const fp = new FilePicker();
    fp.init(panel.els.messages.ownerDocument.defaultView, "选择词典文件（tools/build_ecdict.py 生成的 .db）", fp.modeOpen);
    fp.appendFilter("SQLite 词典", "*.db; *.sqlite");
    fp.appendFilters(fp.filterAll);
    if (await fp.show() !== fp.returnOK) return;
    panel.state.dictPath = fp.file;
    setPref("dictPath", fp.file);
    panel.els.showDictName();
    await refreshEndpoint(panel, "dictPath");
    const ok = panel.els.endpoints.dictPath.dot.classList.contains("is-up");
    setStatus(panel, ok ? "词典已加载" : dict.oldFormat ? "词典需重新生成" : "词典无效", false);
  } catch (e) {
    Zotero.debug(`[AI Translate] 选择词典失败: ${e}`);
    setStatus(panel, "选择词典失败", false);
  }
}

function xhrSSE(url, jsonBody, onChunk) {
  return new Promise((resolve, reject) => {
    const xhr = newXHR();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    // 不用 XHR 的"总时长"超时：流式回答越长总耗时越久，会被误判超时。
    // 改用"空闲超时"——只要后端还在持续吐字就不算超时。
    xhr.timeout = 0;

    const win = (typeof Zotero !== "undefined" && Zotero.getMainWindow)
      ? Zotero.getMainWindow() : null;
    const IDLE_MS = 90000;  // 90 秒内没有任何新数据才判定超时
    let idleTimer = null;

    let offset = 0;
    let finishReason = null;
    let settled = false;

    function clearIdle() {
      if (idleTimer != null) { try { win?.clearTimeout(idleTimer); } catch (_) {} idleTimer = null; }
    }
    function armIdle() {
      clearIdle();
      idleTimer = win?.setTimeout(() => {
        settle(() => reject(new Error("请求超时（长时间无响应）")));
        try { xhr.abort(); } catch (_) {}
      }, IDLE_MS);
    }

    function settle(fn) { if (!settled) { settled = true; clearIdle(); fn(); } }

    // 解析 OpenAI 格式的 SSE：data: {"choices":[{"delta":{"content":"..."}}]}，以 data: [DONE] 结束
    function parseNew() {
      if (xhr.status !== 200) return;  // 错误响应是普通 JSON，交给 onload 处理
      // 只消费到最后一个换行，未收完整的行留到下次，避免 JSON 被截断丢字
      const end = xhr.responseText.lastIndexOf("\n") + 1;
      if (end <= offset) return;
      const newText = xhr.responseText.slice(offset, end);
      offset = end;
      for (const line of newText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json;
        try { json = JSON.parse(payload); } catch (_) { continue; }
        if (json.error) { settle(() => reject(new Error(json.error.message || "stream error"))); return; }
        const choice = json.choices?.[0];
        if (choice?.delta?.content) {
          let result;
          try { result = onChunk(choice.delta.content); } catch (_) {}  // 隔离 UI 更新异常，不中止流
          // 回调要求停止：正常返回 "stopped"，不当作错误
          if (result === "stop") { settle(() => resolve("stopped")); try { xhr.abort(); } catch (_) {} return; }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }

    function httpError() {
      let msg = `HTTP ${xhr.status}`;
      try { msg = JSON.parse(xhr.responseText).error?.message || msg; } catch (_) {}
      return new Error(msg);
    }

    xhr.onprogress = () => { armIdle(); try { parseNew(); } catch (e) { settle(() => reject(e)); } };
    xhr.onload     = () => {
      try {
        if (xhr.status !== 200) { settle(() => reject(httpError())); return; }
        parseNew();
        settle(() => resolve(finishReason));
      } catch (e) { settle(() => reject(e)); }
    };
    xhr.onerror    = () => settle(() => reject(new Error(
      `无法连接到 ${url.replace(/\/v1\/.*$/, "")}，请确认服务已启动（hymt status）`)));
    xhr.ontimeout  = () => settle(() => reject(new Error("请求超时")));
    xhr.onabort    = () => settle(() => reject(new Error("已取消")));
    xhr.send(jsonBody);
    armIdle();  // 启动空闲计时；之后每次收到数据都会重置
  });
}
