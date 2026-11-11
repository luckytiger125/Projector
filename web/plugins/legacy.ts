import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// 虚拟模块 virtual:legacy：把两个老脚本按顺序拼成一个模块（admin.js 先，kb.js 后），
// 这样它们还能像经典脚本那样共享顶层作用域（kb.js 用 admin.js 顶部定义的 $）。阶段七删掉整个 legacy 目录时，这个插件一起删。
const ORDER = ["admin.js", "kb.js"];
const ID = "virtual:legacy";
const RESOLVED = "\0" + ID;

export default function legacy(): Plugin {
  const dir = resolve(import.meta.dirname, "../src/legacy");
  return {
    name: "projector-legacy",
    resolveId(id) {
      return id === ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const parts = ORDER.map((f) => {
        const p = resolve(dir, f);
        this.addWatchFile(p);
        return `\n// ===== ${f} =====\n` + readFileSync(p, "utf8");
      });
      return parts.join("\n");
    },
  };
}
