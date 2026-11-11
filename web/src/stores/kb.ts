// 知识库在外壳和首页上露出的两块：左栏入口旁边的条数、首页“今日知识库”那一列。
// 数据由还没迁移的老知识库代码（legacy/kb.js）加载，通过 bridge 写进来。
import { computed, signal } from "@preact/signals";

export interface KbNote { path: string; title?: string; type?: string; note?: string; created?: number; exists?: boolean }

export const kbCount = signal(0);
export const kbData = signal<{ root?: string; today_new?: KbNote[]; recent?: KbNote[] } | null>(null);

/** 今天新增的知识库内容。老代码的规则：优先用 today_new，否则从 recent 里挑今天新建的 */
export const kbToday = computed<KbNote[]>(() => {
  const data = kbData.value;
  const start = new Date(new Date().toDateString()).getTime() / 1000;
  if (data && Array.isArray(data.today_new)) return data.today_new;
  return ((data && data.recent) || []).filter((r) =>
    r.exists !== false && (r.created ?? 0) >= start && (r.note === "新建" || String(r.note || "").startsWith("Claude")));
});
