import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

// 单元测试：纯逻辑为主，需要 DOM 的（DOMPurify、History API）用 jsdom
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
