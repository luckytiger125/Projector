// 文件库：当前目录、列表、搜索、预览、回收站。网址是唯一的入口：
//   /files                 打开文件库（回到上次的目录，第一次是“我的文件”）
//   /files?path=…          当前目录；路径是一个文件时，列出它所在的目录并预览它（刷新后还在）
//   /files/trash           回收站
// 路径用服务端的“虚拟路径”：我的文件是 ws:…，公共文件库是相对路径，公共文件库的根目录是空串，
// 在网址里空串写成 “/”（免得和“没写 path”混在一起）。
// 目录里的切换用 replace（不堆历史），所以后退一步就是关掉文件库，和其它弹层一致。
import { batch, effect, signal, untracked } from "@preact/signals";
import { api, apiBlob } from "../lib/api";
import { kindOf } from "../lib/filekind";
import { sanitizeHtml, md } from "../lib/markdown";
import { loadDocx, loadXlsx } from "../lib/vendor";
import type { Route } from "../router";
import { navigate, replace, route } from "../router";
import { me } from "./auth";
import { relOfKbPath } from "../lib/wikilink";
import { kbData } from "./kb";
import { office, roots } from "./roots";

// ---------- 类型 ----------
export interface FileEntry { name: string; dir: boolean; size: number; mtime: number; path: string; abs: string }
export interface Crumb { label: string; path: string }
export interface TrashItem {
  id: string; name: string; is_dir?: number | boolean; size: number; orig_path: string; personal?: boolean; owner_name?: string;
  can_restore?: boolean; who?: string; deleted_at: number; reason?: string; days_left: number;
}
export type FileMode = "browse" | "workdir";

export type PreviewBody =
  | { t: "none" }
  | { t: "loading" }
  | { t: "cannot"; why: string }
  | { t: "media"; kind: "image" | "pdf" | "video" | "audio" | "office"; url: string }
  | { t: "text"; text: string; truncated: boolean }
  | { t: "md"; html: string; truncated: boolean }
  | { t: "docx"; blob: Blob }
  | { t: "sheet"; names: string[]; render: (name: string) => string };

export interface KbBanner { kind: "note" | "card"; title?: string; path: string; changed?: boolean }

// ---------- 网址 ↔ 路径 ----------
export const toUrlPath = (v: string): string => (v === "" ? "/" : v);
export const fromUrlPath = (u: string): string => (u === "/" ? "" : u);

/** 文件库的路由；path 是虚拟路径（空串 = 公共文件库根），null/undefined = 回到上次的目录 */
export function filesRoute(path?: string | null): Route {
  return path === null || path === undefined ? { name: "files" } : { name: "files", path: toUrlPath(path) };
}

export const fileUrl = (p: string, extra = ""): string => `/api/files/${extra || "raw"}?path=${encodeURIComponent(p)}`;

/** 知识库根目录下的 .md 文件 → 相对路径；否则 null（规则在 lib/wikilink.ts） */
export const kbRelOf = relOfKbPath;

// ---------- 状态 ----------
export const mode = signal<FileMode>("browse");
export const dirPath = signal("ws:");
export const dirAbs = signal("");
export const crumbs = signal<Crumb[]>([]);
export const entries = signal<FileEntry[]>([]);
export const writable = signal(false);
export const listState = signal<"idle" | "loading" | "ok" | "error">("idle");
export const listError = signal("");
export const query = signal("");
export const searching = signal(false);
export const searchBusy = signal(false);
export const searchPartial = signal(false);
export const sel = signal<FileEntry | null>(null);
export const preview = signal<PreviewBody>({ t: "none" });
export const kbBanner = signal<KbBanner | null>(null);
export const progress = signal<{ done: number; total: number; text: string } | null>(null);
/** 回收站（null = 还没取到或取失败） */
export const trash = signal<{ items: TrashItem[]; days: number } | null>(null);
export const trashError = signal("");

let loaded = false;
let loadSeq = 0;
let previewSeq = 0;

export function resetFiles(): void {
  loadSeq++; previewSeq++; loaded = false;
  batch(() => {
    mode.value = "browse"; dirPath.value = "ws:"; dirAbs.value = ""; crumbs.value = []; entries.value = []; writable.value = false;
    listState.value = "idle"; listError.value = ""; query.value = ""; searching.value = false; searchBusy.value = false;
    searchPartial.value = false; sel.value = null; preview.value = { t: "none" }; kbBanner.value = null; progress.value = null;
    trash.value = null; trashError.value = "";
  });
}

// ---------- 打开 ----------
/** 打开文件库（push 一条历史）。path 为空 = 上次的目录；"" = 公共文件库根；m = workdir 时是“选工作文件夹”模式 */
export function showFiles(path: string | null = null, m: FileMode = "browse"): void {
  mode.value = m;
  navigate(filesRoute(path));
}
export const openTrash = (): void => { navigate({ name: "files", trash: true }); };

/** 文件库里切目录、选文件：replace，不堆历史 */
export function go(path: string): void {
  replace(filesRoute(path), { force: true });
}

// ---------- 列表 ----------
interface DirReply {
  path: string; abs: string; crumbs: Crumb[]; select: string | null; entries: FileEntry[]; office: boolean; writable: boolean; roots: string[];
}

/** keep：只刷新列表，不动预览和网址（上传、新建、改名之后） */
async function load(want: string, keep = false): Promise<void> {
  const seq = ++loadSeq;
  listState.value = "loading"; listError.value = "";
  try {
    const d = await api<DirReply>("/api/files?path=" + encodeURIComponent(want));
    if (seq !== loadSeq) return;
    batch(() => {
      roots.value = d.roots; office.value = !!d.office;
      dirPath.value = d.path; dirAbs.value = d.abs; crumbs.value = d.crumbs; entries.value = d.entries; writable.value = d.writable;
      searching.value = false; searchPartial.value = false; query.value = "";
      listState.value = "ok";
    });
    loaded = true;
    if (keep) return;
    const chosen = d.select ? d.entries.find((x) => x.path === d.select) : undefined;
    if (chosen) startPreview(chosen); else clearSel();
    // 把网址写成规范的样子（绝对路径、没写 path 的都换成虚拟路径）
    const canon = toUrlPath(d.select || d.path);
    const r = route.peek();
    if (r.name === "files" && !r.trash && r.path !== canon) replace(filesRoute(d.select || d.path), { force: true });
  } catch (e) {
    if (seq !== loadSeq) return;
    batch(() => { listState.value = "error"; listError.value = (e as Error).message; });
  }
}

/** 重新读当前目录（保留预览） */
export function refresh(): Promise<void> {
  return load(dirPath.peek(), true);
}

/** 网址上的 path 变了（或第一次进来）：让列表和预览跟上。entering = 文件库刚打开，一律重新读 */
export function syncFromRoute(urlPath: string | undefined, entering: boolean): void {
  const want = urlPath === undefined ? (loaded ? dirPath.peek() : "ws:") : fromUrlPath(urlPath);
  if (!entering && loaded) {
    if (sel.peek()?.path === want) return;                // 已经在预览它
    if (want === dirPath.peek()) { if (sel.peek()) clearSel(); return; }   // 后退到了目录本身：收起预览
    const e = entries.peek().find((x) => x.path === want);   // 就在当前列表（或搜索结果）里
    if (e) { if (e.dir) void load(want); else startPreview(e); return; }
  }
  void load(want);
}

// ---------- 搜索 ----------
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** 输入框变了：防抖 350 毫秒后搜索；清空就回到目录列表 */
export function onSearchInput(q: string): void {
  query.value = q;
  clearTimeout(searchTimer);
  const t = q.trim();
  if (!t) { searchBusy.value = false; if (searching.value) void load(dirPath.peek(), true); return; }
  searchTimer = setTimeout(async () => {
    searchBusy.value = true; listError.value = "";
    try {
      const d = await api<{ results: FileEntry[]; partial: boolean }>(`/api/files/search?path=${encodeURIComponent(dirPath.peek())}&q=${encodeURIComponent(t)}`);
      if (query.peek().trim() !== t) return;
      batch(() => { searching.value = true; entries.value = d.results; searchPartial.value = !!d.partial; listState.value = "ok"; });
    } catch (e) {
      if (query.peek().trim() !== t) return;
      batch(() => { listState.value = "error"; listError.value = (e as Error).message; });
    } finally { if (query.peek().trim() === t) searchBusy.value = false; }
  }, 350);
}

// ---------- 预览 ----------
export function clearSel(): void {
  previewSeq++;
  batch(() => { sel.value = null; preview.value = { t: "none" }; kbBanner.value = null; });
}

/** 预览失败后（比如媒体放不了）换成提示。entry 不是当前选中的就忽略 */
export function previewCannot(path: string, why: string): void {
  if (sel.peek()?.path === path) preview.value = { t: "cannot", why };
}

export function startPreview(e: FileEntry): void {
  const seq = ++previewSeq;
  batch(() => { sel.value = e; preview.value = { t: "loading" }; kbBanner.value = null; });
  void runPreview(e, seq);
  void loadKbBanner(e, seq);
}

async function runPreview(e: FileEntry, seq: number): Promise<void> {
  const live = (): boolean => seq === previewSeq;
  const set = (b: PreviewBody): void => { if (live()) preview.value = b; };
  const kind = kindOf(e.name);
  const url = fileUrl(e.path);
  try {
    if (kind === "image" || kind === "pdf" || kind === "video" || kind === "audio") {
      set({ t: "media", kind, url });
    } else if (kind === "md" || kind === "text") {
      const d = await api<{ text: string; truncated: boolean }>("/api/files/text?path=" + encodeURIComponent(e.path));
      if (!live()) return;
      set(kind === "md" ? { t: "md", html: md(d.text), truncated: !!d.truncated } : { t: "text", text: d.text, truncated: !!d.truncated });
    } else if (kind === "docx") {
      if (e.size > 50 * 1048576) return set({ t: "cannot", why: "文件太大，不适合在这里预览。" });
      await loadDocx();   // 先加载组件（失败了就不用下载文件）
      const blob = await apiBlob(url);
      set({ t: "docx", blob });
    } else if (kind === "sheet") {
      if (e.size > 30 * 1048576) return set({ t: "cannot", why: "表格太大，不适合在这里预览。" });
      const XLSX = await loadXlsx();
      const buf = await (await apiBlob(url)).arrayBuffer();
      if (!live()) return;
      const wb = XLSX.read(buf, { type: "array", codepage: 936 });
      set({
        t: "sheet", names: wb.SheetNames,
        render: (name: string) => sanitizeHtml(XLSX.utils.sheet_to_html(wb.Sheets[name], { header: "", footer: "" })),
      });
    } else if (kind === "office") {
      if (!office.peek()) return set({ t: "cannot", why: "这种格式需要台式机装了 LibreOffice 才能预览。" });
      set({ t: "media", kind: "office", url: fileUrl(e.path, "pdf") });
    } else {
      set({ t: "cannot", why: "这种格式不能在这里预览。" });
    }
  } catch (err) {
    set({ t: "cannot", why: "预览失败：" + (err as Error).message });
  }
}

/** 这份文件有没有知识库卡片？本身是不是知识库笔记？ */
async function loadKbBanner(e: FileEntry, seq: number): Promise<void> {
  const kb = kbData.peek();
  if (!kb || e.dir) return;
  const rel = kbRelOf(kb.root, e.abs);
  if (rel) { kbBanner.value = { kind: "note", path: rel }; return; }
  const r = await api<{ cards: Array<{ title: string; path: string; source_state?: string }> }>("/api/kb/cards?path=" + encodeURIComponent(e.path)).catch(() => ({ cards: [] }));
  if (seq !== previewSeq || !r.cards.length) return;
  const c = r.cards[0];
  kbBanner.value = { kind: "card", title: c.title, path: c.path, changed: c.source_state === "changed" };
}

// ---------- 回收站 ----------
export async function loadTrash(): Promise<void> {
  trashError.value = "";
  try { trash.value = await api("/api/trash"); }
  catch (e) { trash.value = null; trashError.value = (e as Error).message; }
}

// ---------- 路由同步 ----------
let sheetView: "browse" | "trash" | null = null;

/** 开始跟着网址走（登录以后才同步）。返回停止函数 */
export function startFilesSync(): () => void {
  // 知识库数据比预览晚到（直接打开网址时常见）：到了以后补查这份文件有没有卡片
  const stopKb = effect(() => {
    void kbData.value;
    untracked(() => { const e = sel.peek(); if (e) void loadKbBanner(e, previewSeq); });
  });
  const stopRoute = effect(() => {
    const r = route.value;
    const u = me.value;
    const view = u && r.name === "files" ? (r.trash ? "trash" : "browse") : null;
    untracked(() => {
      if (view === null) {
        if (sheetView !== null) { sheetView = null; mode.value = "browse"; clearSel(); searching.value = false; query.value = ""; }
        return;
      }
      const entering = sheetView !== view;
      sheetView = view;
      if (r.name !== "files") return;
      if (view === "trash") { if (entering) void loadTrash(); return; }
      syncFromRoute(r.path, entering);
    });
  });
  return () => { stopKb(); stopRoute(); };
}
