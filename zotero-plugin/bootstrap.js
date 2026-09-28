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
// 官方 ZH<=>XX 提示词模板，原文前空一行
const PROMPT_PREFIX = "将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n";
// 官方推荐采样参数
const SAMPLING = { temperature: 0.7, top_p: 0.6, top_k: 20, repetition_penalty: 1.05 };
// 输出长度与原文成正比：英文约 4 字符/token，译文 token 数一般不超过原文的 1.5 倍
const MIN_OUTPUT_TOKENS = 64;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_INPUT_CHARS   = 4000;   // 需与 vllm serve --max-model-len 4096 匹配，超出部分截断

function outputTokenLimit(text) {
  const estimate = Math.floor(text.length / 2) + 32;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, estimate));
}

var chromeHandle = null;
var styleSheetSvc = null;
var styleURI = null;

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

  // 4. 注册侧边栏 section（显示在 Zotero 条目面板右侧）
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
      if (uid) panels.delete(uid);
    },
    onRender() {},
  });

  // 5. 监听 PDF 选中文字事件
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onReaderSelection,
    ADDON_ID
  );
}

async function onMainWindowLoad({ window }) {
  // 向每个窗口注入 FTL，section header 才能正确显示中文标题
  try {
    window.MozXULElement?.insertFTLIfNeeded(`${ADDON_REF}.ftl`);
  } catch (_) {}
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

  panels.clear();

  if (chromeHandle) { chromeHandle.destruct(); chromeHandle = null; }
}

// ── 选中事件 ─────────────────────────────────────────────────────────────────

function onReaderSelection(event) {
  const text = getSelectionText(event);
  if (!text) return;

  // 在弹出菜单中添加提示
  try {
    const note = event.doc.createElement("div");
    note.style.cssText =
      "margin-top:5px;padding:3px 8px;border-radius:4px;" +
      "background:#f0f7ff;color:#2b6fd6;font-size:11px;";
    note.textContent = getPref("autoTranslate", true) !== false
      ? "已发送至 AI 翻译"
      : "AI 翻译：自动翻译已关闭";
    event.append(note);
  } catch (_) {}

  // 通知所有活跃面板
  for (const panel of panels.values()) {
    if (panel.state.autoTranslate) {
      sendMessage(panel, text);
    } else {
      // 关闭自动翻译：把选中文字放入输入框，按 Enter 再翻译
      if (panel.els.textarea) {
        panel.els.textarea.value = text;
        panel.els.textarea.dispatchEvent(new Event("input"));
        try { panel.els.textarea.focus(); } catch (_) {}
      }
      setStatus(panel, "已放入输入框", false);
    }
  }
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

// 将 Markdown 文本直接渲染为 DOM 节点（不经过 innerHTML，与 UI 构建方式一致）
// 支持：# 标题、**粗体**、`行内代码`、> 引用、--- 分割线、| 表格、段落
function renderToDOM(raw, doc) {
  const frag = doc.createDocumentFragment();

  function el(tag) { return doc.createElementNS(HTML_NS, tag); }

  // 处理 **bold** 和 `code` 行内语法
  function appendInline(parent, text) {
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
    apiBase:       (() => {
      const v = (getPref("apiBase", DEFAULT_API) || DEFAULT_API).replace(/\/+$/, "");
      return v === LEGACY_API ? DEFAULT_API : v;
    })(),
    lastAiText:    "",  // 用于复制按钮
  };
  const els = {};
  panels.set(uid, { state, els });

  // ── 顶栏控件 ──
  els.statusDot  = h(doc, "span", { className: "ait-dot" });
  els.statusText = h(doc, "span", { className: "ait-status", text: "就绪" });

  const autoCheck = h(doc, "input", { type: "checkbox" });
  autoCheck.checked = state.autoTranslate;
  autoCheck.addEventListener("change", () => {
    state.autoTranslate = autoCheck.checked;
    setPref("autoTranslate", autoCheck.checked);
  });

  els.apiInput = h(doc, "input", {
    className:   "ait-api-input",
    type:        "text",
    value:       state.apiBase,
    placeholder: DEFAULT_API,
    spellcheck:  "false",
  });
  els.apiInput.addEventListener("change", () => {
    const v = els.apiInput.value.trim().replace(/\/+$/, "");
    state.apiBase = v || DEFAULT_API;
    els.apiInput.value = state.apiBase;
    setPref("apiBase", state.apiBase);
  });

  const copyBtn = h(doc, "button", { className: "ait-action-btn", type: "button", text: "复制",
    onclick: () => {
      if (!state.lastAiText) return;
      try { doc.defaultView?.navigator?.clipboard?.writeText(state.lastAiText); } catch (_) {}
      copyBtn.textContent = "已复制";
      doc.defaultView?.setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
    },
  });
  const clearBtn = h(doc, "button", {
    className: "ait-action-btn ait-action-ghost", type: "button", text: "清空",
    onclick: () => panelClear({ state, els }),
  });

  // ── 顶栏（双行）──
  const topbar = h(doc, "div", { className: "ait-topbar" }, [
    h(doc, "div", { className: "ait-topbar-row" }, [
      h(doc, "div", { className: "ait-topbar-left" }, [
        els.statusDot,
        h(doc, "span", { className: "ait-title", text: "AI 翻译" }),
      ]),
      h(doc, "div", { className: "ait-topbar-right" }, [
        els.statusText,
        h(doc, "label", { className: "ait-toggle" }, [autoCheck,
          h(doc, "span", { className: "ait-toggle-track" }),
          h(doc, "span", { className: "ait-toggle-label", text: "自动" }),
        ]),
      ]),
    ]),
    h(doc, "div", { className: "ait-topbar-row ait-ctrl-row" }, [
      h(doc, "span", { className: "ait-api-label", text: "API" }),
      els.apiInput,
      copyBtn,
      clearBtn,
    ]),
  ]);

  // ── 消息区（空状态 + 动态卡片）──
  els.empty = h(doc, "div", { className: "ait-empty" }, [
    h(doc, "div", { className: "ait-empty-icon", text: "✦" }),
    h(doc, "div", { text: "在 PDF 中选中英文，或在下方输入" }),
    h(doc, "div", { className: "ait-empty-sub", text: "自动翻译为中文" }),
  ]);
  els.messages = h(doc, "div", { className: "ait-messages" }, [els.empty]);

  // ── 输入区 ──
  els.textarea = h(doc, "textarea", {
    className:   "ait-input",
    placeholder: "输入英文…  Shift+Enter 换行，Enter 翻译",
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

  const root = h(doc, "div", { className: "ait-root" }, [topbar, els.messages, inputArea]);
  body.appendChild(root);
}

// ── 消息卡片 ──────────────────────────────────────────────────────────────────

// 用户是否停在（接近）底部：用来决定流式输出时要不要自动跟随滚动
function isNearBottom(el, threshold = 40) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function appendUserMsg(panel, text) {
  const doc = panel.els.messages.ownerDocument;
  if (panel.els.empty.parentElement === panel.els.messages)
    panel.els.messages.removeChild(panel.els.empty);
  const content = h(doc, "div", { className: "ait-msg-content" });
  content.textContent = text;
  const card = h(doc, "div", { className: "ait-msg ait-msg-user" }, [
    h(doc, "div", { className: "ait-msg-label", text: "原文" }),
    content,
  ]);
  panel.els.messages.appendChild(card);
  panel.els.messages.scrollTop = panel.els.messages.scrollHeight;
}

function appendAiMsg(panel) {
  const doc = panel.els.messages.ownerDocument;
  const content = h(doc, "div", { className: "ait-msg-content ait-streaming" });
  const cursor = doc.createElementNS(HTML_NS, "span");
  cursor.className = "ait-cursor";
  content.appendChild(cursor);
  const card = h(doc, "div", { className: "ait-msg ait-msg-ai" }, [
    h(doc, "div", { className: "ait-msg-header" }, [
      h(doc, "span", { className: "ait-avatar", text: "AI" }),
      h(doc, "span", { className: "ait-msg-label", text: "译文" }),
    ]),
    content,
  ]);
  panel.els.messages.appendChild(card);
  panel.els.messages.scrollTop = panel.els.messages.scrollHeight;
  return content;
}

// ── 面板状态 ──────────────────────────────────────────────────────────────────

function setStatus(panel, text, busy) {
  if (panel.els.statusText) panel.els.statusText.textContent = text;
  if (panel.els.statusDot)
    panel.els.statusDot.className = "ait-dot" + (busy ? " is-busy" : "");
}

function panelClear(panel) {
  panel.state.lastAiText   = "";
  panel.state.pending      = false;
  if (panel.els.textarea) { panel.els.textarea.value = ""; panel.els.textarea.style.height = ""; }
  panel.els.messages?.replaceChildren(panel.els.empty);
  setStatus(panel, "就绪", false);
}

// ── 发送逻辑（每次独立翻译，不带历史）────────────────────────────────────────

function submitFromInput(panel) {
  const text = panel.els.textarea?.value?.trim();
  if (!text) return;
  panel.els.textarea.value = "";
  panel.els.textarea.style.height = "";
  sendMessage(panel, text);
}

async function sendMessage(panel, userText) {
  if (!userText.trim() || panel.state.pending) return;
  panel.state.pending = true;

  const doc = panel.els.messages?.ownerDocument;
  if (!doc) { panel.state.pending = false; return; }

  appendUserMsg(panel, userText);

  // 追加 AI 回复卡（带光标）
  const aiContent = appendAiMsg(panel);
  setStatus(panel, "翻译中…", true);

  let aiText = "";

  try {
    const source = userText.trim().slice(0, MAX_INPUT_CHARS);
    const url  = panel.state.apiBase + "/v1/chat/completions";
    const body = JSON.stringify({
      model:      MODEL_NAME,
      messages:   [{ role: "user", content: PROMPT_PREFIX + source }],
      max_tokens: outputTokenLimit(source),
      stream:     true,
      ...SAMPLING,
    });

    const finishReason = await xhrSSE(url, body, chunk => {
      aiText = (aiText + chunk).replace(/^\s+/, "");
      // 渲染前先记录用户是否停在底部；若用户已往上滚去看历史，则不打断
      const stick = isNearBottom(panel.els.messages);
      const frag = renderToDOM(aiText, doc);
      const cur = doc.createElementNS(HTML_NS, "span");
      cur.className = "ait-cursor";
      frag.appendChild(cur);
      aiContent.replaceChildren(frag);
      if (stick) panel.els.messages.scrollTop = panel.els.messages.scrollHeight;
    });

    aiContent.replaceChildren(renderToDOM(aiText, doc));
    aiContent.className = "ait-msg-content";

    panel.state.lastAiText = aiText;
    setStatus(panel, finishReason === "length" ? "完成（已达长度上限）" : "完成", false);
  } catch (err) {
    Zotero.debug(`[AI Translate] sendMessage 失败: ${err?.stack || err?.message || err}`);
    aiContent.className = "ait-msg-content ait-error";
    aiContent.textContent = "失败：" + (err?.message || "未知错误");
    setStatus(panel, "失败", false);
  }

  panel.state.pending = false;
}

// ── XHR（mozBackgroundRequest 绕过 Firefox 私有网络访问限制）────────────────

function xhrSSE(url, jsonBody, onChunk) {
  return new Promise((resolve, reject) => {
    let xhr;
    try {
      xhr = new XMLHttpRequest();
    } catch (_) {
      xhr = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
        .createInstance(Components.interfaces.nsIXMLHttpRequest);
    }
    try { xhr.mozBackgroundRequest = true; } catch (_) {}
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
          try { onChunk(choice.delta.content); } catch (_) {}  // 隔离 UI 更新异常，不中止流
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
    xhr.onerror    = () => settle(() => reject(new Error("无法连接到 vLLM，请确认服务已启动")));
    xhr.ontimeout  = () => settle(() => reject(new Error("请求超时")));
    xhr.onabort    = () => settle(() => reject(new Error("已取消")));
    xhr.send(jsonBody);
    armIdle();  // 启动空闲计时；之后每次收到数据都会重置
  });
}
