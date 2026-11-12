// 我的用量：本月 / 上月 / 全部。网址 /usage（页签不写进网址，每次打开都从“本月”开始，和老代码一样）。
import { batch, effect, signal, untracked } from "@preact/signals";
import { api } from "../lib/api";
import { localYmd } from "../lib/format";
import { route } from "../router";
import { me } from "./auth";

export type UsageRange = "month" | "last" | "all";

export interface UsageTotal { input?: number; output?: number; cache_read?: number; turns?: number; cost?: number | null }
export interface UsageModel { model?: string; input?: number; output?: number; cost?: number | null }
export interface UsageTurn { session_title?: string; preview?: string; input?: number; output?: number; cost?: number | null }
export interface UsageData { has_data: boolean; total?: UsageTotal; by_model?: UsageModel[]; turns: UsageTurn[] }

export const range = signal<UsageRange>("month");
export const state = signal<"loading" | "ok" | "error">("loading");
export const data = signal<UsageData | null>(null);
export const error = signal("");

/** 范围对应的查询串：本月不带参数（服务端默认本月）；上月是上个月 1 号到最后一天；全部 all=true。now 可注入 */
export function usageQuery(r: UsageRange, now: Date = new Date()): string {
  if (r === "all") return "all=true";
  if (r === "last") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return `from=${localYmd(start)}&to=${localYmd(end)}`;
  }
  return "";
}

let seq = 0;

export async function loadUsage(r: UsageRange): Promise<void> {
  const my = ++seq;
  batch(() => { range.value = r; state.value = "loading"; });
  try {
    const qs = usageQuery(r);
    const d = await api("/api/usage/me" + (qs ? "?" + qs : ""));
    // 最近 20 轮取不到就当没有（和老代码一样），不影响汇总
    const tr = await api("/api/usage/me/turns?limit=20").catch(() => ({ turns: [] }));
    if (my !== seq) return;
    d.turns = Array.isArray(tr) ? tr : (tr.turns || []);
    batch(() => { data.value = d; state.value = "ok"; });
  } catch (e) {
    if (my !== seq) return;
    batch(() => { error.value = (e as Error).message; state.value = "error"; });
  }
}

let was = false;

/** 进入 /usage 就取“本月”。返回停止函数 */
export function startUsageSync(): () => void {
  return effect(() => {
    const on = !!me.value && route.value.name === "usage";
    untracked(() => {
      if (on && !was) void loadUsage("month");
      if (!on && was) { seq++; data.value = null; }
      was = on;
    });
  });
}
