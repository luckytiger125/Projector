// 文件库、工作区的根目录（/api/files 返回的 roots）和“能不能预览 Office 文件”。
// 对话里把完整路径缩成“文件库/…”、把路径变成可点的链接、后台文件记录里缩短路径都要用。
import { signal } from "@preact/signals";
import { api } from "../lib/api";

export const roots = signal<string[]>([]);
export const office = signal(false);

/** 取一次（已经有了就不再取，和老代码一样） */
export async function loadRoots(): Promise<void> {
  if (roots.value.length) return;
  try {
    const d = await api<{ roots: string[]; office: boolean }>("/api/files");
    roots.value = d.roots; office.value = !!d.office;
  } catch { /* 忽略 */ }
}
