// 技能：我的技能列表、我的提交、技能详情和版本记录、提交（zip / 文件夹）、回滚。网址是唯一的入口：
//   /skills          我的技能（列表 + 提交新技能 + 我的提交）
//   /skills/{name}   技能详情（版本记录、上传新版本、查看版本文件）
// 从列表点进详情用 replace（弹层内部的切换不堆历史），所以后退一步就是关掉弹层。
// “我能用的技能”（输入区的技能选择浮层也读它）在 composer.ts 的 mySkills。
import { batch, effect, signal, untracked } from "@preact/signals";
import { api, post } from "../lib/api";
import { replace, route } from "../router";
import { me } from "./auth";
import { loadSkills } from "./composer";
import { toast } from "./ui";

// ---------- 类型 ----------
export interface Submission {
  id: string; name: string; description: string; status: "pending" | "approved" | "rejected" | string;
  submitted_by: number; created: number; changelog?: string; note?: string; submitter?: string; current_version?: number | null;
}
export interface SkillVersion {
  version: number; created: number; changelog?: string; submitter?: string; submitter_avatar?: string; approver?: string;
}
export interface SkillDetail {
  skill: { name: string; description: string; version: number };
  versions: SkillVersion[];
  pending: Array<{ id: string; changelog?: string; created: number; submitter?: string }>;
}
export interface SkillFile { path: string; size: number; text: string | null; truncated?: boolean }
export interface SkillChanges { added: string[]; modified: string[]; removed: string[] }

// ---------- 状态 ----------
/** 我的提交（含别人提交的，管理员能看到全部；列表里只显示自己的）。null = 还没取到 */
export const submissions = signal<Submission[] | null>(null);
/** 技能详情：null = 还没取到 */
export const detail = signal<SkillDetail | null>(null);
/** 详情是哪个技能的（取的过程中 detail 还是上一个，用它判断要不要显示加载中） */
export const detailName = signal("");

let listSeq = 0;
let detailSeq = 0;

// ---------- 网址 ----------
export const skillsRoute = (name?: string) => ({ name: "skills" as const, ...(name ? { skill: name } : {}) });
/** 在弹层里切到某个技能的详情（replace） */
export const openDetail = (name: string): void => { replace(skillsRoute(name), { force: true }); };
/** 回到技能列表（replace） */
export const openList = (): void => { replace(skillsRoute(), { force: true }); };

// ---------- 读 ----------
/** 取我的技能和我的提交（和老代码一样：提交取不到当成没有） */
export async function loadList(): Promise<void> {
  const seq = ++listSeq;
  void loadSkills();
  const subs = await api<Submission[]>("/api/skills/submissions").catch(() => [] as Submission[]);
  if (seq === listSeq) submissions.value = subs;
}

/** 取技能详情。失败：提示错误并回到列表（和老代码一样只提示，不打开详情） */
export async function loadDetail(name: string): Promise<void> {
  const seq = ++detailSeq;
  try {
    const d = await api<SkillDetail>("/api/skills/" + encodeURIComponent(name));
    if (seq !== detailSeq) return;
    batch(() => { detail.value = d; detailName.value = name; });
  } catch (e) {
    if (seq !== detailSeq) return;
    toast((e as Error).message, "err");
    detail.value = null;
    if (route.peek().name === "skills") openList();
  }
}

export async function loadVersionFiles(name: string, v: number): Promise<{ files: SkillFile[]; changes: SkillChanges | null }> {
  return api(`/api/skills/${encodeURIComponent(name)}/versions/${v}/files`);
}

// ---------- 提交 ----------
/** 上传技能文件（zip 或文件夹）并提交审核；changelog 是更新说明。upload 拿到提交 id 去上传 */
export async function submitSkill(upload: (id: string) => Promise<unknown>, changelog: string): Promise<{ name: string }> {
  const sub = await post("/api/skills/submissions");
  try {
    await upload(sub.id);
    return await post(`/api/skills/submissions/${sub.id}/submit`, { changelog });
  } catch (e) {
    // 上传或检查没过：把刚建的草稿删掉，不在服务端留垃圾（删不掉也不影响报错）
    await post(`/api/skills/submissions/${sub.id}`, undefined, "DELETE").catch(() => {});
    throw e;
  }
}

export const uploadZip = (f: File) => (id: string) => api(`/api/skills/submissions/${id}/zip`, { method: "PUT", body: f, raw: true });

export const uploadDir = (files: File[]) => async (id: string): Promise<void> => {
  for (const f of files) {
    const rel = f.webkitRelativePath.split("/").slice(1).join("/") || f.name;
    await api(`/api/skills/submissions/${id}/file?path=${encodeURIComponent(rel)}`, { method: "PUT", body: f, raw: true });
  }
};

/** 回滚（管理员）：生成一个和 v 内容一样的新版本 */
export async function rollback(name: string, v: number): Promise<number> {
  const r = await post(`/api/admin/library/${encodeURIComponent(name)}/rollback`, { version: v });
  toast(`已回滚，现在是 v${r.version}`, "ok");
  void loadDetail(name);
  void loadSkills();
  return r.version;
}

export function resetSkills(): void {
  listSeq++; detailSeq++;
  batch(() => { submissions.value = null; detail.value = null; detailName.value = ""; });
}

// ---------- 跟着网址走 ----------
let lastKey = "";

/** 开始同步（登录以后才同步）。进入列表就取列表，进入某个技能就取详情；离开就清掉。返回停止函数 */
export function startSkillsSync(): () => void {
  return effect(() => {
    const r = route.value;
    const u = me.value;
    const sk = r.name === "skills" ? r.skill : undefined;
    const key = u && r.name === "skills" ? (sk ? "d:" + sk : "list") : "";
    untracked(() => {
      if (key === lastKey) return;
      lastKey = key;
      if (!key) { resetSkills(); return; }
      if (key === "list") { detailSeq++; batch(() => { detail.value = null; detailName.value = ""; }); void loadList(); }
      else { if (detailName.peek() !== sk) detail.value = null; void loadDetail(sk!); }
    });
  });
}
