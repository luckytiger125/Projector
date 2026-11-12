import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const target = `http://127.0.0.1:${process.env.PROJECTOR_PORT || 8080}`;

// 开发时 /static/app/ 是 Vite 自己的 base，不能被 /static 代理吞掉
const proxy = {
  "/api": {
    target,
    // /api/events 是 SSE：不要让代理缓冲或压缩
    configure: (p: any) => {
      p.on("proxyRes", (res: any) => {
        if (String(res.headers["content-type"] || "").includes("text/event-stream")) {
          res.headers["cache-control"] = "no-cache, no-transform";
          res.headers["x-accel-buffering"] = "no";
        }
      });
    },
  },
  "^/static/(?!app/)": target,
  "/manifest.webmanifest": target,
};

export default defineConfig({
  base: "/static/app/",
  plugins: [preact()],
  build: { outDir: "../static/app", emptyOutDir: true },
  server: { proxy },
});
