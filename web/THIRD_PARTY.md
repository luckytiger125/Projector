# 第三方库

这些库从 npm 安装，版本在 `package.json` 里精确钉死，构建时打进 `static/app/`（运行时不依赖外网 CDN）。
docx-preview、jszip、xlsx、qrcode-generator 只在预览文件或手机扫码时才加载（动态 `import()`，单独分包）。

- `marked` 12.0.2 — Markdown 渲染，MIT License，来源：https://github.com/markedjs/marked
- `dompurify` 3.1.6 — HTML 清洗，Apache-2.0 OR MPL-2.0，来源：https://github.com/cure53/DOMPurify
- `qrcode-generator` 1.4.4 — 二维码生成，MIT License，来源：https://github.com/kazuhikoarase/qrcode-generator
- `jszip` 3.10.1 — zip 读取，MIT / GPLv3 双许可，来源：https://github.com/Stuk/jszip
- `docx-preview` 0.3.5 — docx 预览，MIT License，来源：https://github.com/VolodymyrBaydalka/docxjs
- `xlsx` 0.18.5 — Excel 读取，Apache-2.0 License，来源：https://github.com/SheetJS/sheetjs

升级时请同时更新 `package.json` 和本文件的版本说明，并保留上游许可证。
