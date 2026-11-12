// 会话列表和分区。当前打开的会话在 chat.ts；这里不依赖 chat.ts（chat.ts 依赖这里）。
import { computed, signal } from "@preact/signals";
import { api } from "../lib/api";
import type { Section, Session } from "../lib/types";
import { mainRoute } from "../router";
import { me } from "./auth";

export const sessions = signal<Session[]>([]);
export const sections = signal<Section[]>([]);
/** null=全部，0=未分类，其他=分区 id */
export const currentSection = signal<number | null>(null);
/** 会话列表快照的事件序号：session 事件序号不大于它就不覆盖列表项 */
export const listSeq = signal(0);
/** 列表搜索框的内容 */
export const query = signal("");

/** home 值班板 / chat 会话页。由路由推出（老代码里是独立变量），弹层不改变它 */
export const viewMode = computed<"home" | "chat">(() => {
  const n = mainRoute.value.name;
  return n === "new" || n === "session" ? "chat" : "home";
});

// ---------- 分区 ----------

export function sectionName(id: unknown): string {
  if (id === null || id === undefined || id === "") return "全部";
  if (Number(id) === 0) return "未分类";
  const s = sections.value.find((x) => Number(x.id) === Number(id));
  return s ? s.name : "未分类";
}

export function sessionSectionName(id: unknown): string {
  if (id === null || id === undefined || Number(id) === 0) return "未分类";
  const s = sections.value.find((x) => Number(x.id) === Number(id));
  return s ? s.name : "未分类";
}

export function sectionMatch(sectionId: unknown, cur: number | null = currentSection.value): boolean {
  if (cur === null) return true;
  if (Number(cur) === 0) return sectionId === null || sectionId === undefined || Number(sectionId) === 0;
  return Number(sectionId) === Number(cur);
}

export async function loadSections(): Promise<void> {
  try {
    const d = await api("/api/sections");
    sections.value = Array.isArray(d) ? d : (d && d.sections) || [];
  } catch { sections.value = []; }
  const cur = currentSection.value;
  if (cur !== null && cur !== 0 && !sections.value.some((s) => Number(s.id) === Number(cur))) currentSection.value = null;
}

/** 选分区：重取列表（失败不抛，和老代码选分区后的行为一致由调用方处理） */
export function selectSection(id: number | null): Promise<void> {
  currentSection.value = id;
  return loadSessions();
}

// ---------- 列表 ----------

export async function loadSessions(): Promise<void> {
  const cur = currentSection.value;
  const qs = cur === null ? "" : `?section_id=${encodeURIComponent(cur)}`;
  const onSeq = (n: number) => { listSeq.value = n; };
  try { sessions.value = await api<Session[]>("/api/sessions" + qs, { onSeq }); }
  catch { sessions.value = await api<Session[]>("/api/sessions", { onSeq }); }
}

/** 只处理列表这一半：自己的会话放到最前并按 updated 倒序。当前会话的更新在 chat.ts 的 upsertSession 里 */
export function upsertInList(s: Session): void {
  if (!me.value || s.user_id !== me.value.id) return;
  const list = sessions.value.filter((x) => x.id !== s.id);
  list.unshift(s);
  list.sort((a, b) => b.updated - a.updated);
  sessions.value = list;
}

export function removeFromList(id: string): void {
  sessions.value = sessions.value.filter((s) => s.id !== id);
}

// ---------- 分组（今天 / 昨天 / 7 天内 / 更早） ----------

export interface SessionGroup { name: string; items: Session[] }

/** 纯函数：把会话按更新时间分组。now 可注入。先匹配到的组优先，一个会话只出现一次 */
export function groupSessions(list: Session[], now: Date = new Date()): SessionGroup[] {
  const today = new Date(now.toDateString()).getTime() / 1000;
  const groups: [string, (s: Session) => boolean][] = [
    ["今天", (s) => s.updated >= today],
    ["昨天", (s) => s.updated >= today - 86400],
    ["7 天内", (s) => s.updated >= today - 6 * 86400],
    ["更早", () => true],
  ];
  const used = new Set<string>();
  const out: SessionGroup[] = [];
  for (const [name, test] of groups) {
    const items = list.filter((s) => !used.has(s.id) && test(s));
    if (!items.length) continue;
    items.forEach((s) => used.add(s.id));
    out.push({ name, items });
  }
  return out;
}

/** 当前分区 + 搜索词过滤后的会话 */
export const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return sessions.value.filter((s) => sectionMatch(s.section_id) && (!q || s.title.toLowerCase().includes(q)));
});

export const groups = computed(() => groupSessions(filtered.value));

/** 当前分区里今天有更新的会话数（左栏计数） */
export const todayCount = computed(() => {
  const today = new Date(new Date().toDateString()).getTime() / 1000;
  return sessions.value.filter((s) => sectionMatch(s.section_id) && s.updated >= today).length;
});

export function resetSessions(): void {
  sessions.value = [];
  sections.value = [];
  currentSection.value = null;
}
