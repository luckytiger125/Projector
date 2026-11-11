import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// 虚拟模块 virtual:legacy：把三个老脚本按原来 index.html 的加载顺序拼成一个模块，
// 这样它们还能像经典脚本那样共享顶层作用域。
const ORDER = ["app.js", "admin.js", "kb.js"];
const ID = "virtual:legacy";
const RESOLVED = "\0" + ID;

export default function legacy(): Plugin {
  const dir = resolve(import.meta.dirname, "../src/legacy");
  const vendor = resolve(dir, "../lib/vendor.ts").replaceAll("\\", "/");
  return {
    name: "projector-legacy",
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const prelude = [
        `import { loadQrcode } from ${JSON.stringify(vendor)};`,
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
