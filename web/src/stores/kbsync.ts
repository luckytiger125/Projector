// 知识库和网址、全局的衔接：
//  - 网址变成 /kb… 时加载数据、读笔记；离开 /kb 时清掉编辑和笔记（页签和当前笔记就是网址，见 stores/kb.ts）
//  - 离开守卫：有没保存的编辑时，关闭、切页签、换笔记、后退键都先问一句
//  - 全局点击：对话回复里的 [[链接]]、指向知识库笔记的文件路径小标签，都在知识库里打开
//  - 进入应用时取一次数据（左栏的条数、值班板“今日知识库”、文件预览里的卡片提示都读它）；退出登录时清掉
import { batch, effect, untracked } from "@preact/signals";
import { setMarkdownLinkify } from "../lib/markdown";
import { linkify, relOfKbPath } from "../lib/wikilink";
import { addLeaveGuard, loc, route } from "../router";
import { me } from "./auth";
import { onEnter } from "./boot";
import {
  clearNote, clearSearch, kbData, kbDirty, kbEditing, kbFind, kbLoad, kbLoadError, lastKbPath, lastNote, loadNote, resetKb, stopEdit,
} from "./kb";
import { toast } from "./ui";

/** 离开守卫：有没保存的编辑才问。去的还是知识库里就问“离开”，去别处就问“关闭”（文字和老代码一样） */
export function kbLeaveGuard(to: string): boolean {
  if (route.peek().name !== "kb" || !kbEditing.peek() || !kbDirty.peek()) return true;
  if (to === loc.peek().path) return true;
  return confirm(to.startsWith("/kb") ? "编辑的内容还没保存，确定离开吗？" : "编辑的内容还没保存，确定关闭吗？");
}

let lastKey = "";

/** 网址 → 数据：页签和笔记变了才动，同一个页面重复进入不重取 */
export function syncKbRoute(): void {
  const r = route.value;
  const u = me.value;
  const key = u && r.name === "kb" ? r.tab + "|" + (r.tab === "notes" ? r.note || "" : "") : "";
  untracked(() => {
    if (key === lastKey) return;
    const was = lastKey;
    lastKey = key;
    if (!key) {   // 离开知识库
      batch(() => { kbEditing.value = null; kbDirty.value = false; });
      clearNote(); clearSearch();
      return;
    }
    if (r.name !== "kb") return;
    lastKbPath.value = loc.peek().path;
    stopEdit();
    if (!was) {   // 刚打开：重新取一遍（分区也重新取）；失败时弹层里显示错误
      void kbLoad(true).catch((e: Error) => { kbLoadError.value = e.message; toast(e.message, "err"); });
    }
    if (r.tab === "notes" && r.note) { lastNote.value = r.note; void loadNote(r.note); }
    else clearNote();
  });
}

/** 点 [[链接]]、点知识库里 .md 文件的路径 → 在知识库里打开（捕获阶段，抢在文件库的点击处理之前） */
export function installKbClicks(openByName: (name: string) => void, openPath: (rel: string) => void): () => void {
  const h = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (!t || !t.closest) return;
    const wl = t.closest("[data-kb]") as HTMLElement | null;
    if (wl) { e.preventDefault(); e.stopPropagation(); openByName(wl.dataset.kb || ""); return; }
    const fp = t.closest("[data-fpath]") as HTMLElement | null;
    const rel = fp && relOfKbPath(kbData.peek()?.root, fp.dataset.fpath);
    if (rel) { e.preventDefault(); e.stopPropagation(); openPath(rel); }
  };
  document.addEventListener("click", h, true);
  return () => document.removeEventListener("click", h, true);
}

export function startKbSync(openByName: (name: string) => void, openPath: (rel: string) => void): () => void {
  // 对话回复里的 [[笔记名]]：知识库加载了就按它判断有没有这条
  setMarkdownLinkify((t) => linkify(t, undefined, (name) => (kbData.value ? kbFind(name)?.path ?? null : undefined)));
  const stops = [
    effect(syncKbRoute),
    addLeaveGuard(kbLeaveGuard),
    installKbClicks(openByName, openPath),
    // 退出登录：清掉上一个人的数据
    effect(() => { if (!me.value) untracked(resetKb); }),
    // 进入应用：先取一次数据，左栏的条数、值班板“今日知识库”、文件预览里的卡片提示都读它（网址就在知识库里时，上面的同步已经在取了）
    onEnter(() => { if (route.peek().name !== "kb") void kbLoad().catch(() => {}); }),
  ];
  return () => stops.forEach((f) => f());
}
