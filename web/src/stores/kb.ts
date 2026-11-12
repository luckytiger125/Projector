// 知识库的状态和操作：数据、分区、筛选和搜索、当前笔记、编辑状态、图谱要隐藏的类型。
// 网址是页签和当前笔记的唯一来源（/kb、/kb/notes?note=…、/kb/graph），所以这里不存“当前页签”“当前笔记”，
// 只存从网址推出来的东西；网址变化时的加载、离开守卫、全局点击在 stores/kbsync.ts。
// 本文件也给外壳和别处露出几块：左栏入口旁边的条数（kbCount）、值班板“今日知识库”（kbToday）、文件预览里的卡片提示（kbData.root）。
import { batch, computed, signal } from "@preact/signals";
import { api, post } from "../lib/api";
import { findNote } from "../lib/wikilink";
import type { KbTab } from "../router";
import { navigate, overlayRoute, replace, route } from "../router";
import { toast } from "./ui";
import type { Section } from "../lib/types";

// ---------- 类型 ----------
export interface KbBrief {
  path: string; title: string; type: string; tags: string[]; summary: string; status: string; author?: string;
  created?: number; updated?: string; source: string; mtime: number; section: string;
  /** "changed" 原文件改过 / "missing" 原文件不在了 / 空 */
  source_state: string; links: number; backlinks: number; words: number;
}
/** 值班板和首页“最近更新”里的一条（两个接口字段略有不同，都当可选） */
export interface KbNote { path: string; title?: string; type?: string; note?: string; created?: number; exists?: boolean; by_name?: string }
export interface KbHomeData {
  root?: string;
  notes: KbBrief[];
  types?: string[];
  tags: Array<[string, number]>;
  stats?: { total: number; by_type: Record<string, number>; week: number; stale: number; links: number };
  hubs: Array<KbBrief>;
  ghosts: Array<{ name: string; count: number }>;
  recent: KbNote[];
  today_new?: KbNote[];
  section?: string;
}
export interface KbHit extends KbBrief { snippet: string }
export interface KbNoteDetail {
  note: KbBrief & { body: string; contributors: string[]; aliases: string[]; abs: string; source_abs: string };
  backlinks: Array<{ path: string; title: string; type: string; snippet: string }>;
  links: Record<string, string | null>;
  session: { id: string; title: string } | null;
  history: number;
}
/** 编辑中的笔记：d 是正在改的笔记（新建时是 null）；preset 是新建时预填的标题和类型 */
export interface KbEditing { id: number; d: KbNoteDetail | null; preset: { title?: string; type?: string } }
export interface KbGraphData { nodes: Array<{ id: string; title: string; type: string; status?: string; section?: string; deg?: number }>; edges: Array<[string, string]> }

/** 笔记类型 → 颜色类名；类型之外的归到 other，还没写的链接是 ghost */
export const KB_TYPES: Record<string, string> = { 经验: "exp", 文件卡片: "card", 主题: "topic" };
export const kcls = (t: string | undefined): string => (t && KB_TYPES[t]) || (t === "ghost" ? "ghost" : "other");
export const UNCATEGORIZED = "__uncategorized__";

// ---------- 状态 ----------
export const kbData = signal<KbHomeData | null>(null);
export const kbLoadError = signal("");
export const kbSections = signal<Section[]>([]);
/** 分区筛选：空 = 全部，UNCATEGORIZED = 未分类，其他是分区名 */
export const kbSection = signal("");
export const kbType = signal("");
export const kbTag = signal("");
/** 搜索框里的字（输入就更新）和搜到的结果（null = 没在搜索） */
export const kbQuery = signal("");
export const kbResults = signal<KbHit[] | null>(null);
/** 当前打开的笔记详情；kbNoteError 非空 = 读取失败 */
export const kbNote = signal<KbNoteDetail | null>(null);
export const kbNoteError = signal("");
export const kbNoteLoading = signal(false);
export const kbEditing = signal<KbEditing | null>(null);
export const kbDirty = signal(false);
/** 离开笔记页签前看的那条：切回去时恢复（和老代码一样，笔记页签记得上次看到哪） */
export const lastNote = signal<string | null>(null);
/** 上次停在知识库的哪个网址：从入口再打开时回到这里（老代码也是回到上次的页签） */
export const lastKbPath = signal<string>("/kb");
/** 图谱上被点掉的类型（还没写的用 "ghost"） */
export const kbHidden = signal<Set<string>>(new Set());

export const sectionMatch = (n: { section?: string }, section = kbSection.value): boolean => {
  if (!section) return true;
  if (section === UNCATEGORIZED) return !n.section;
  return n.section === section;
};

/** 当前分区下的笔记 */
export const visibleNotes = computed<KbBrief[]>(() => (kbData.value?.notes || []).filter((n) => sectionMatch(n)));

/** 左栏“知识库”旁边的条数：当前分区里超过 1 条才显示（和老代码一样） */
export const kbCount = computed(() => {
  const n = visibleNotes.value.length;
  return n > 1 ? n : 0;
});

/** 今天新增的知识库内容。老代码的规则：优先用 today_new，否则从 recent 里挑今天新建的 */
export const kbToday = computed<KbNote[]>(() => {
  const data = kbData.value;
  const start = new Date(new Date().toDateString()).getTime() / 1000;
  if (data && Array.isArray(data.today_new)) return data.today_new;
  return ((data && data.recent) || []).filter((r) =>
    r.exists !== false && (r.created ?? 0) >= start && (r.note === "新建" || String(r.note || "").startsWith("Claude")));
});

/** 当前网址指向的页签和笔记（不在知识库里是 null） */
export const kbTab = computed<KbTab | null>(() => { const r = route.value; return r.name === "kb" ? r.tab : null; });
export const kbSel = computed<string | null>(() => { const r = route.value; return r.name === "kb" && r.tab === "notes" ? r.note ?? null : null; });

export const kbFind = (name: string): KbBrief | null => findNote(kbData.value?.notes, name);

// ---------- 网址 ----------
export function kbRoute(tab: KbTab, note?: string | null) {
  return { name: "kb" as const, tab, ...(tab === "notes" && note ? { note } : {}) };
}

/**
 * 去知识库的某个页签（可带笔记）。已经在知识库里就 replace（弹层内部切换不堆历史），否则 push 打开弹层。
 * 有未保存的编辑时离开守卫会先问；用户选不离开就返回 false。
 */
export function kbGo(tab: KbTab, note?: string | null): boolean {
  const r = kbRoute(tab, note);
  return overlayRoute.peek()?.name === "kb" ? replace(r) : navigate(r);
}
export const openNote = (path: string): boolean => kbGo("notes", path);

// ---------- 加载 ----------
let sectionsLoaded = false;
let dataSeq = 0;

export async function loadKbSections(): Promise<void> {
  try {
    const d = await api("/api/sections");
    kbSections.value = Array.isArray(d) ? d : (d && d.sections) || [];
  } catch { kbSections.value = []; }
  sectionsLoaded = true;
}

/** 取知识库首页数据（全库笔记 + 当前分区的统计）。refreshSections：重新取分区（每次打开弹层时） */
export async function kbLoad(refreshSections = false): Promise<KbHomeData> {
  if (refreshSections || !sectionsLoaded) await loadKbSections();
  const seq = ++dataSeq;
  const qs = kbSection.peek() ? "?section=" + encodeURIComponent(kbSection.peek()) : "";
  let d: KbHomeData;
  try { d = await api("/api/kb" + qs); }
  catch { d = await api("/api/kb"); }
  if (seq === dataSeq) { kbData.value = d; kbLoadError.value = ""; }
  return d;
}

let noteSeq = 0;
let noteLoadingPath = "";

/** 读一条笔记。同一条正在读就不重复读（保存后网址变化和显式刷新会碰上）；失败时显示错误并重新取列表（可能已被别人删了） */
export async function loadNote(path: string): Promise<void> {
  if (noteLoadingPath === path) return;
  const seq = ++noteSeq;
  noteLoadingPath = path;
  batch(() => { kbNoteLoading.value = true; kbNoteError.value = ""; if (kbNote.peek()?.note.path !== path) kbNote.value = null; });
  try {
    const d = await api<KbNoteDetail>("/api/kb/note?path=" + encodeURIComponent(path));
    if (seq !== noteSeq) return;
    batch(() => { kbNote.value = d; kbNoteLoading.value = false; });
  } catch (e) {
    if (seq !== noteSeq) return;
    batch(() => { kbNote.value = null; kbNoteError.value = (e as Error).message; kbNoteLoading.value = false; });
    void kbLoad().catch(() => {});
  } finally {
    if (seq === noteSeq) noteLoadingPath = "";
  }
}

/** 网址上没有笔记了（回到列表、换页签、关闭弹层） */
export function clearNote(): void {
  noteSeq++; noteLoadingPath = "";
  batch(() => { kbNote.value = null; kbNoteError.value = ""; kbNoteLoading.value = false; });
}

export function resetKb(): void {
  dataSeq++; sectionsLoaded = false; clearNote();
  batch(() => {
    kbData.value = null; kbLoadError.value = ""; kbSections.value = []; kbSection.value = ""; kbType.value = ""; kbTag.value = "";
    kbQuery.value = ""; kbResults.value = null; kbEditing.value = null; kbDirty.value = false; lastNote.value = null; kbHidden.value = new Set(); lastKbPath.value = "/kb";
  });
}

// ---------- 分区、筛选、搜索 ----------
/** 换分区：清掉搜索，重新取数据 */
export async function setSection(section: string): Promise<void> {
  batch(() => { kbSection.value = section; kbResults.value = null; kbQuery.value = ""; });
  try { await kbLoad(); } catch (e) { toast((e as Error).message, "err"); }
}

/** 清掉搜索结果和搜索框（换页签、清除按钮） */
export function clearSearch(): void {
  batch(() => { kbResults.value = null; kbQuery.value = ""; });
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** 搜索框输入：停 260 毫秒再搜；清空就退出搜索；搜到结果后如果不在笔记页签就切过去 */
export function onSearchInput(text: string): void {
  kbQuery.value = text;
  clearTimeout(searchTimer);
  const q = text.trim();
  searchTimer = setTimeout(async () => {
    if (!q) { kbResults.value = null; return; }
    try {
      const d = await api<{ results: KbHit[] }>("/api/kb/search?q=" + encodeURIComponent(q) + (kbSection.peek() ? "&section=" + encodeURIComponent(kbSection.peek()) : ""));
      if (kbQuery.peek().trim() !== q) return;
      kbResults.value = d.results;
      if (kbTab.peek() !== "notes") kbGo("notes", lastNote.peek());
    } catch (e) { toast((e as Error).message, "err"); }
  }, 260);
}

/** 首页点类型 / 标签：去笔记页签，按它筛选，不选中任何笔记 */
export function filterNotes(by: { type?: string; tag?: string }): void {
  batch(() => { kbType.value = by.type || ""; kbTag.value = by.tag || ""; lastNote.value = null; });
  kbGo("notes");
}

// ---------- 编辑 ----------
let editSeq = 0;
export function startEdit(d: KbNoteDetail | null, preset: KbEditing["preset"] = {}): void {
  batch(() => { kbEditing.value = { id: ++editSeq, d, preset }; kbDirty.value = false; });
}
export function stopEdit(): void {
  batch(() => { kbEditing.value = null; kbDirty.value = false; });
}

export interface NoteForm { title: string; type: string; tags: string[]; summary: string; body: string; section: string; source: string }

/** 保存（新建或修改）。成功后刷新列表、提示、打开保存后的笔记；失败抛错，由调用方提示 */
export async function saveNote(d: KbNoteDetail | null, f: NoteForm): Promise<void> {
  const n = d?.note;
  const body: Record<string, unknown> = {
    path: n ? n.path : "", title: f.title, type: f.type, tags: f.tags, summary: f.summary, body: f.body,
    base_mtime: n ? n.mtime : null, section: f.section,
  };
  if (f.source !== (n?.source || "")) body.source = f.source;
  const r = await post<{ path: string }>("/api/kb/note", body, "PUT");
  stopEdit();
  await kbLoad();
  toast(d ? "已保存" : "笔记已建好", "ok");
  kbGo("notes", r.path);
  void loadNote(r.path);
}

/** 标为有效 / 过时 */
export async function toggleStatus(n: KbNoteDetail["note"]): Promise<void> {
  try {
    await post("/api/kb/status", { path: n.path, status: n.status === "过时" ? "有效" : "过时" });
    await kbLoad();
    await loadNote(n.path);
  } catch (e) { toast((e as Error).message, "err"); }
}

/** 删除（进回收站）。出错抛给对话框显示 */
export async function deleteNote(n: KbNoteDetail["note"]): Promise<void> {
  await post("/api/kb/delete", { path: n.path });
  batch(() => { lastNote.value = null; });
  await kbLoad();
  kbGo("notes");
  toast("已删除，可以在回收站里恢复", "ok");
}

/** 恢复到某个历史版本 */
export async function restoreVersion(path: string, id: string | number): Promise<void> {
  await post(`/api/kb/history/${id}/restore`);
  await kbLoad();
  await loadNote(path);
  toast("已恢复", "ok");
}
