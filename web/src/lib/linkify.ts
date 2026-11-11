// 把回复（或笔记）里提到的文件库、工作区路径变成可点的“文件名小标签”。从老代码 linkifyPaths 搬来，规则不变；
// 根目录由调用方传入（stores/roots）。点击由外层统一处理（读 data-fpath）。
import { baseName } from "./format";
import { KIND_COLOR, kindOf } from "./filekind";
import { iconSvg } from "./icons";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 路径尾部不该带的标点和括号 */
const TAIL = `[^\\s<>"'\`|*?，。；：、！？（）()【】「」]*[^\\s<>"'\`|*?，。；：、！？（）()【】「」.,:;]`;

export function pathRegex(roots: string[]): RegExp | null {
  if (!roots.length) return null;
  const parts = roots.map((root) => {
    const sep = root.includes("\\") ? "\\\\" : "/";
    return escapeRe(root.replace(/[\\/]$/, "")) + sep;
  });
  return new RegExp(`(?:${parts.join("|")})${TAIL}`, "gi");
}

export function linkifyPaths(container: HTMLElement, roots: string[]): void {
  const re = pathRegex(roots);
  if (!re) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest("a, textarea, .ticket, .chip, .tl") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    re.lastIndex = 0;
    if (re.test(t.nodeValue || "")) nodes.push(t);
  }
  for (const node of nodes) {
    const text = node.nodeValue || "";
    const frag = document.createDocumentFragment();
    let last = 0;
    re.lastIndex = 0;
    text.replace(re, (m: string, idx: number) => {
      frag.append(text.slice(last, idx));
      // 显示成“文件名小标签”：完整路径太长，放在悬停提示里
      const a = document.createElement("a");
      const name = baseName(m);
      const isDir = !/\.[A-Za-z0-9]{1,6}$/.test(name);
      a.className = "fchip";
      a.dataset.fpath = m;
      a.title = m + "\n点击预览";
      // 图标和色块都是本文件里写死的内容，文件名走 textContent
      a.innerHTML = (isDir ? iconSvg("folder", 13) : `<i style="background:${KIND_COLOR[kindOf(name)]}"></i>`) + "<span></span>";
      a.querySelector("span")!.textContent = name;
      frag.append(a);
      last = idx + m.length;
      return m;
    });
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}
