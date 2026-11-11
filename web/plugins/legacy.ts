import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// 虚拟模块 virtual:legacy：把老脚本拼成一个模块（现在只剩 admin.js，保持经典脚本的顶层作用域写法）。
// 阶段七删掉整个 legacy 目录时，这个插件一起删。
const ORDER = ["admin.js"];
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
