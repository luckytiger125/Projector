// Markdown 渲染：marked 输出一律交给 DOMPurify 净化后才能进 DOM。
// 净化配置：DOMPurify 默认配置，再去掉 <style>（老代码没去，是收紧：回复里的 Markdown 不能注入全局样式）。
import { marked } from "marked";
import DOMPurify from "dompurify";

const CONFIG = { FORBID_TAGS: ["style"] };
let linkify: ((text: string) => string) | null = null;

/** 注册“[[笔记名]] → 可点开的知识库链接”的预处理（由 stores/kbsync.ts 接上 lib/wikilink 的 linkify） */
export function setMarkdownLinkify(fn: ((text: string) => string) | null): void {
  linkify = fn;
}

/** 转义成可以放进 HTML 文本和双引号属性的字符串 */
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** 净化一段 HTML（文件预览里的 HTML 类内容也走这里） */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, CONFIG);
}

/** Markdown → 净化后的 HTML 字符串，可直接给 dangerouslySetInnerHTML */
export function md(text: string | null | undefined): string {
  let src = text || "";
  if (linkify) src = linkify(src);
  return DOMPurify.sanitize(marked.parse(src) as string, CONFIG);
}
