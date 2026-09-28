/* global Zotero, window, document */
// 「墨桥·InkBridge」设置页脚本：在设置窗口的沙箱中运行，通过 Zotero.AIPaperReader 调用插件

window.AITPrefs = {
  keys: ["apiBase", "ocrApiBase", "ttsApiBase", "dictPath"],

  init() {
    document.getElementById("ait-pref-dict-pick").addEventListener("command", async () => {
      await Zotero.AIPaperReader?.pickDictFile(window);
      this.test();
    });
    document.getElementById("ait-pref-test").addEventListener("command", () => this.test());
    this.test();
  },

  // 检测三个服务与词典，结果显示在各行右侧
  async test() {
    const api = Zotero.AIPaperReader;
    if (!api) return;
    const show = (key, text, cls) => {
      const el = document.getElementById("ait-status-" + key);
      el.textContent = text;
      el.className = "ait-pref-status " + cls;
    };
    for (const key of this.keys) show(key, "检测中…", "");
    const result = await api.checkServices();
    for (const key of ["apiBase", "ocrApiBase", "ttsApiBase"]) {
      show(key, result[key] ? "● 可用" : "● 无法连接", result[key] ? "is-up" : "is-down");
    }
    const dict = {
      ok:      ["● 可用", "is-up"],
      old:     ["● 需重新生成", "is-down"],
      invalid: ["● 文件无效", "is-down"],
      unset:   ["未设置", ""],
    }[result.dictPath];
    show("dictPath", ...dict);
  },
};
