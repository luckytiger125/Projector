// 知识库的 [[双链]] 解析：纯函数，不碰 DOM、不碰 store。规则从老代码（kbLinkify / kbFind / kbRelOf）原样搬来。
import { escapeHtml } from "./markdown";

/** [[目标#小节|别名]]；前面带 ! 的是嵌入写法，按普通链接处理（和老代码一样）。目标里不许有 [ ] | # ^ 和换行 */
export const WL_RE = /(!?)\[\[([^\[\]\n|#^]+)(#[^\[\]\n|]*)?(?:\|([^\[\]\n]*))?\]\]/g;

export interface NoteRef { path: string; title: string }

/**
 * 按名字找笔记：先比标题（不分大小写），再比不带 .md 的路径，最后拿路径最后一段去比标题。
 * 反斜杠当斜杠、去掉结尾的 .md、去首尾空白。
 */
export function findNote<T extends NoteRef>(notes: readonly T[] | null | undefined, name: string): T | null {
  if (!notes) return null;
  const t = name.trim().replaceAll("\\", "/").replace(/\.md$/i, "").toLowerCase();
  return notes.find((n) => n.title.toLowerCase() === t)
    || notes.find((n) => n.path.slice(0, -3).toLowerCase() === t)
    || notes.find((n) => n.title.toLowerCase() === t.split("/").pop())
    || null;
}

/** 知识库根目录下的 .md 文件的绝对路径 → 相对路径；不在知识库里或不是 .md 就是 null（比较时不分大小写、不分斜杠方向） */
export function relOfKbPath(root: string | undefined | null, abs: string | undefined | null): string | null {
  const r0 = (root || "").replace(/[\\/]+$/, "");
  if (!r0 || !abs) return null;
  const a = abs.replaceAll("\\", "/"), r = r0.replaceAll("\\", "/");
  if (!a.toLowerCase().startsWith(r.toLowerCase() + "/") || !/\.md$/i.test(a)) return null;
  return a.slice(r.length + 1);
}

/**
 * 把正文里的 [[链接]] 变成可以点的 <a class="wl" data-kb="目标">；代码块和行内代码里的不动。
 * links：服务端给的 {目标: 路径或 null}（null = 还没有这条笔记）；没有 links 时用 find 现查：
 * find 返回笔记路径、null（知识库已加载但没有这条）、undefined（知识库还没加载，不知道）。
 * 返回的是带标签的 Markdown 文本，要再交给 md() 渲染并净化。
 */
export function linkify(
  text: string | null | undefined,
  links?: Record<string, string | null> | null,
  find?: (name: string) => string | null | undefined,
): string {
  return (text || "").split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part.replace(WL_RE, (_m, _bang, t: string, hash?: string, alias?: string) => {
    const target = t.trim();
    const known = links ? (target in links ? links[target] : undefined) : find?.(target);
    const label = (alias || target + (hash || "")).trim();
    return `<a class="wl${known === null ? " ghost" : ""}" data-kb="${escapeHtml(target)}" title="${known === null ? "还没有这条笔记，点击新建" : "打开笔记"}">${escapeHtml(label)}</a>`;
  })).join("");
}

/** 去掉正文开头和标题一样的一级标题（阅读时标题已经单独显示了） */
export function stripTitleHeading(body: string, title: string): string {
  return body.replace(new RegExp("^\\s*#\\s+" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\n"), "");
}

/** 输入框里光标前面是不是正在写 [[…：是就返回 { query, from（查询词在文本里的起点） } */
export function wikiQueryAt(before: string): { query: string; from: number } | null {
  const m = /\[\[([^\[\]\n|#]*)$/.exec(before);
  return m ? { query: m[1], from: before.length - m[1].length } : null;
}
