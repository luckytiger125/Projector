// 文本编码相关的小工具：给文件预览用。

/** 把字节解成文字：是合法的 UTF-8 就按 UTF-8，否则按 GBK（国内老文件最常见）；去掉开头的 BOM */
export function decodeText(buf: ArrayBuffer): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { text = new TextDecoder("gbk").decode(buf); }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 看起来不是文本：开头一段里控制字符或解不出来的字符占了一成以上 */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, 4000);
  if (!head) return false;
  let bad = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad / head.length > 0.1;
}

/** 搜索结果和反向链接里的摘要：去掉 Markdown 表格的分隔行和竖线，免得显示成一串 |---| */
export function cleanSnippet(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/\|?\s*:?-{2,}:?\s*(?=\|)/g, "").replace(/\s*\|\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}
