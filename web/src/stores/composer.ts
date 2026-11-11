// 输入区的引用、技能、工作目录，以及我能用的技能列表。输入框的文字不放这里（不受控，发送时读值）。
import { signal } from "@preact/signals";
import { api } from "../lib/api";

export interface Ref { path: string; abs: string; name: string; dir: boolean }
export interface Skill { name: string; description?: string; version?: number; [k: string]: unknown }

export const refs = signal<Ref[]>([]);
/** 选中的技能名，空串表示没选 */
export const skill = signal("");
/** 新会话还没创建时先记着的工作目录 */
export const workDir = signal("");
export const mySkills = signal<Skill[]>([]);

/** 清掉引用和技能（发送后、新建会话时）。workDir 不动：它在会话创建时才清 */
export function resetComposer(): void {
  refs.value = [];
  skill.value = "";
}

export function addRef(entry: { abs: string; name: string; dir?: boolean }): void {
  if (refs.value.some((r) => r.abs === entry.abs)) return;
  refs.value = [...refs.value, { path: entry.abs, abs: entry.abs, name: entry.name, dir: !!entry.dir }];
}

export function removeRef(i: number): void {
  refs.value = refs.value.filter((_, j) => j !== i);
}

export async function loadSkills(): Promise<void> {
  mySkills.value = await api<Skill[]>("/api/skills/mine").catch(() => []);
}
