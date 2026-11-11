import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// 虚拟模块 virtual:legacy：把四个老脚本按原来 index.html 的加载顺序拼成一个模块，
// 这样它们还能像经典脚本那样共享顶层作用域。
const ORDER = ["ui.js", "app.js", "admin.js", "kb.js"];
const ID = "virtual:legacy";
const RESOLVED = "\0" + ID;

export default function legacy(): Plugin {
  const dir = resolve(import.meta.dirname, "../src/legacy");
  const vendor = resolve(dir, "vendor.ts").replaceAll("\\", "/");
  return {
    name: "projector-legacy",
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const prelude = [
        `import { marked } from "marked";`,
        `import DOMPurify from "dompurify";`,
        `import { loadDocx, loadXlsx, loadQrcode } from ${JSON.stringify(vendor)};`,
        // 原来 vendor 脚本把它们挂在 window 上，legacy 里有 window.marked && window.DOMPurify 的判断
        `window.marked = marked; window.DOMPurify = DOMPurify;`,
        "",
      ].join("\n");
      const parts = ORDER.map((f) => {
        const p = resolve(dir, f);
        this.addWatchFile(p);
        return `\n// ===== ${f} =====\n` + readFileSync(p, "utf8");
      });
      return prelude + parts.join("\n");
    },
  };
}
