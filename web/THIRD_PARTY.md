# 第三方库

这些库从 npm 安装，版本在 `package.json` 里精确钉死，构建时打进 `static/app/`（运行时不依赖外网 CDN）。
docx-preview、jszip、xlsx、qrcode-generator 只在预览文件或手机扫码时才加载（动态 `import()`，单独分包）。

- `marked` 12.0.2 — Markdown 渲染，MIT License，来源：https://github.com/markedjs/marked
- `dompurify` 3.4.17 — HTML 清洗，Apache-2.0 OR MPL-2.0，来源：https://github.com/cure53/DOMPurify
- `qrcode-generator` 1.4.4 — 二维码生成，MIT License，来源：https://github.com/kazuhikoarase/qrcode-generator
- `jszip` 3.10.1 — zip 读取，MIT / GPLv3 双许可，来源：https://github.com/Stuk/jszip
- `docx-preview` 0.3.5 — docx 预览，MIT License，来源：https://github.com/VolodymyrBaydalka/docxjs
- `xlsx` 0.20.3 — Excel 读取，Apache-2.0 License，来源：https://git.sheetjs.com/sheetjs/sheetjs。npm 上的 `xlsx` 停在 0.18.5（有已知漏洞），修复版只在 SheetJS 自己的 CDN 发布，所以 `package.json` 里写的是 tarball 地址 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`；升级时改这个地址里的版本号。

## 仅开发和测试用（不进构建产物）

- `vitest` ^4.1.12 — 单元测试运行器，MIT License，来源：https://github.com/vitest-dev/vitest。理由：seq 去重、路由、格式化、Markdown 净化这些纯逻辑要有回归测试，且和 Vite 共用配置。
- `jsdom` ^29.1.1 — 测试里的 DOM 环境（DOMPurify 和 History API 需要），MIT License，来源：https://github.com/jsdom/jsdom。

升级时请同时更新 `package.json` 和本文件的版本说明，并保留上游许可证。
