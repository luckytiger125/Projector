// 管理后台：用户、聊天记录、技能库、待审核、文件记录、用量、分区、设置。只有管理员能打开。
// 网址 /admin/{tab}，聊天记录里点开的会话是 /admin/chats?session=…（刷新后还在）。
// 组件不直接 fetch：读写都在这里；每个操作做完重取当前页签的数据（和老代码“做完重画整页”一致，但不闪“读取中…”）。
import { batch, effect, signal, untracked } from "@preact/signals";
import { api, apiPages, post } from "../lib/api";
import type { AdminTab } from "../router";
import { mainRoute, navigate, replace, route } from "../router";
import type { Section, Session } from "../lib/types";
import { me } from "./auth";
import { loadSections as loadSideSections } from "./sessions";
import { current, onSessionUpdate, openSession } from "./chat";
import { syncRoute } from "./routesync";
import { usageQuery } from "./usage";
import type { UsageData, UsageRange } from "./usage";
import { toast } from "./ui";

// ---------- 类型（字段按老代码实际用到的写） ----------
export interface AdminUser {
  id: number; username: string; display_name: string; role: string; avatar: string;
  can_bypass?: boolean; disabled?: boolean; sessions: number; last_seen?: number | null;
}
export interface AdminSessionRow extends Session { running?: boolean; pending?: number }
export interface WorkspaceUsage {
  users: Array<{ display_name: string; username: string; size: number; files: number }>;
  trash: { size: number; files: number };
}
export interface LibrarySkill {
  name: string; version?: number; pending?: number; description: string; submitter?: string; updated: number;
  everyone: boolean; users: number[];
}
export interface LocalSkills { dir: string; skills: Array<{ name: string; description: string; in_library: boolean }> }
export interface AdminSubmission {
  id: string; name: string; description: string; status: string; submitted_by: number; created: number;
  changelog?: string; note?: string; submitter?: string; current_version?: number | null;
}
export interface FileOp { created: number; user_id: number; who?: string; action: string; path: string; detail?: string }
export interface AdminSettings {
  perm_mode: "standard" | "strict" | string; max_concurrent: number;
  ask_cmds: string[]; bash_allow: string[]; default_ask: string[]; default_allow: string[]; safe: string[];
  /** 运行方式：cli 每轮起一个 claude 进程（默认）/ sdk 常驻会话。老版本服务端没有这几个字段 */
  runner_mode?: "cli" | "sdk" | string; sdk_available?: boolean; sdk_error?: string; sdk_idle_seconds?: number; sdk_clients?: number;
}
export interface AdminSection extends Section { session_count?: number; note_count?: number }
export interface AdminUsageData extends UsageData {
  by_user?: Array<{ user_id: number; display_name?: string; input?: number; output?: number; cache_read?: number; turns?: number; cost?: number | null }>;
}

// ---------- 状态 ----------
export const state = signal<"loading" | "ok" | "error">("loading");
export const error = signal("");
export const users = signal<AdminUser[]>([]);
/** 待审核的数量（页签上的角标） */
export const pendingCount = signal(0);
export const allSessions = signal<AdminSessionRow[]>([]);
export const workspaceUsage = signal<WorkspaceUsage | null>(null);
export const library = signal<LibrarySkill[]>([]);
export const localSkills = signal<LocalSkills>({ dir: "", skills: [] });
export const submissions = signal<AdminSubmission[]>([]);
export const fileOps = signal<FileOp[]>([]);
export const settings = signal<AdminSettings | null>(null);
export const sections = signal<AdminSection[]>([]);
/** 聊天记录里展开的用户组（刷新列表时保持） */
export const openGroups = signal<number[]>([]);

export const usageRange = signal<UsageRange>("month");
export const usageState = signal<"loading" | "ok" | "error">("loading");
export const usageData = signal<AdminUsageData | null>(null);
export const usageError = signal("");

export const userOf = (id: number): { display_name: string; avatar: string } =>
  users.value.find((u) => u.id === id) || { display_name: "#" + id, avatar: "orange" };

// ---------- 读 ----------
let seq = 0;
let currentTab: AdminTab | null = null;

async function loadUsers(): Promise<void> { users.value = await api("/api/admin/users"); }

/** 取待审核数量（和老代码一样：取不到当成没有）。返回全部提交 */
export async function refreshPending(): Promise<AdminSubmission[]> {
  const subs = await api<AdminSubmission[]>("/api/skills/submissions").catch(() => [] as AdminSubmission[]);
  pendingCount.value = subs.filter((s) => s.status === "pending").length;
  return subs;
}

/** 全队的会话：按页取完再一起给（后台的表格要完整的列表才能统计） */
async function loadAllSessions(): Promise<AdminSessionRow[]> {
  const all: AdminSessionRow[] = [];
  await apiPages<AdminSessionRow>("/api/admin/sessions", 500, (rows) => { all.push(...rows); });
  return all;
}

async function loadTabData(t: AdminTab): Promise<void> {
  if (t === "users") {
    const [all, subs, usage] = await Promise.all([
      loadAllSessions(), refreshPending(), api<WorkspaceUsage>("/api/admin/workspace-usage").catch(() => null)]);
    batch(() => { allSessions.value = all; submissions.value = subs; workspaceUsage.value = usage; });
  } else if (t === "chats") {
    allSessions.value = await loadAllSessions();
  } else if (t === "library") {
    const [lib, local] = await Promise.all([api<LibrarySkill[]>("/api/admin/library"), api<LocalSkills>("/api/admin/local-skills")]);
    batch(() => { library.value = lib; localSkills.value = local; });
  } else if (t === "review") {
    submissions.value = await refreshPending();
  } else if (t === "files") {
    fileOps.value = await api("/api/admin/file-ops");
  } else if (t === "settings") {
    settings.value = await api("/api/admin/settings");
  } else if (t === "sections") {
    const d = await api("/api/sections?include_archived=1");
    sections.value = Array.isArray(d) ? d : (d && d.sections) || [];
  } else if (t === "usage") {
    void loadAdminUsage("month");
  }
}

/** 取一个页签的数据。silent：做完操作后的刷新，不显示“读取中…” */
export async function loadTab(t: AdminTab, silent = false): Promise<void> {
  const my = ++seq;
  if (!silent) state.value = "loading";
  try {
    await loadUsers();
    await loadTabData(t);
    if (my !== seq) return;
    state.value = "ok";
  } catch (e) {
    if (my !== seq) return;
    batch(() => { error.value = (e as Error).message; state.value = "error"; });
  }
  if (my === seq && t !== "review" && t !== "users") void refreshPending();
}

const reload = (silent = true): Promise<void> => (currentTab ? loadTab(currentTab, silent) : Promise.resolve());

// ---------- 用户 ----------
export async function createUser(username: string, display_name: string, password: string): Promise<void> {
  await post("/api/admin/users", { username, display_name, password });
  toast("已创建账号 " + username, "ok");
  await reload();
}

export async function patchUser(uid: number, body: Record<string, unknown>, msg = "已保存"): Promise<void> {
  try { await post("/api/admin/users/" + uid, body, "PATCH"); toast(msg, "ok", 1800); }
  catch (e) { toast((e as Error).message, "err"); }
  await reload();
}

export async function deleteUser(uid: number): Promise<void> {
  try { await api("/api/admin/users/" + uid, { method: "DELETE" }); toast("已删除", "ok"); }
  catch (e) { toast((e as Error).message, "err"); }
  await reload();
}

// ---------- 聊天记录 ----------
let chatsTimer: ReturnType<typeof setTimeout> | undefined;
/** 会话有更新（session 事件）：聊天记录页签 800 毫秒后重取列表（展开状态在 openGroups 里，不受影响） */
function onSession(_s: Session): void {
  if (currentTab !== "chats") return;
  clearTimeout(chatsTimer);
  chatsTimer = setTimeout(() => { if (currentTab === "chats") void loadTab("chats", true); }, 800);
}

export function toggleGroup(uid: number): void {
  const on = openGroups.value.includes(uid);
  openGroups.value = on ? openGroups.value.filter((x) => x !== uid) : [...openGroups.value, uid];
}

/** 打开 / 关闭聊天记录里的某个会话（replace：弹层内部的切换不堆历史） */
export const openChat = (id: string): void => {
  // 自己的会话直接回主界面打开，可以接着聊（老版本就是这样）；别人的会话在后台里只读查看
  const own = allSessions.peek().find((x) => x.id === id)?.user_id === me.peek()?.id;
  if (own) { navigate({ name: "session", id }); return; }
  replace({ name: "admin", tab: "chats", session: id }, { force: true });
};
export const closeChat = (): void => { replace({ name: "admin", tab: "chats" }, { force: true }); };

let viewing = "";
async function viewSession(id: string): Promise<void> {
  try { await openSession(id); }
  catch (e) {
    if (current.peek() !== id) return;
    toast((e as Error).message, "err");
    if (route.peek().name === "admin") closeChat();
  }
}

// ---------- 技能库 ----------
export async function saveAccess(name: string, everyone: boolean, ids: number[]): Promise<void> {
  // 先改界面（老代码是复选框自己变），请求失败再取回真实状态
  library.value = library.value.map((s) => (s.name === name ? { ...s, everyone, users: ids } : s));
  try { await post(`/api/admin/library/${encodeURIComponent(name)}/access`, { everyone, users: ids }, "PUT"); toast("已保存分配", "ok", 1500); }
  catch (e) { toast((e as Error).message, "err"); void reload(); }
}

export async function importLocal(names: string[]): Promise<void> {
  const r = await post("/api/admin/local-skills/import", { names });
  toast(`已导入 ${r.imported.length} 个，记得分配给需要的人`, "ok");
  await reload();
}

export async function removeFromLibrary(name: string): Promise<void> {
  await api(`/api/admin/library/${encodeURIComponent(name)}`, { method: "DELETE" });
  toast("已删除", "ok");
  await reload();
}

export const loadLibraryFiles = (name: string) => api<{ files: any[] }>(`/api/admin/library/${encodeURIComponent(name)}/files`);

// ---------- 待审核 ----------
export async function deleteSubmission(id: string): Promise<void> {
  await api("/api/skills/submissions/" + id, { method: "DELETE" });
  await reload();
}

export const loadSubmissionFiles = (id: string) => api<any>(`/api/skills/submissions/${id}/files`);

/** 通过或退回。通过后去“技能库”分配，退回留在待审核 */
export async function reviewSubmission(id: string, name: string, approve: boolean, note: string): Promise<void> {
  await post(`/api/skills/submissions/${id}/review`, { approve, note });
  toast(approve ? `已入库：${name}。到“技能库”里分配给需要的人` : "已退回", approve ? "ok" : "info");
  if (approve && currentTab !== "library") replace({ name: "admin", tab: "library" }, { force: true });
  else await reload();
}

// ---------- 设置 ----------
export async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  try { await post("/api/admin/settings", patch, "PUT"); toast("已保存，新的对话开始生效", "ok", 2000); }
  catch (e) { toast((e as Error).message, "err"); }
  await reload();
}

// ---------- 用量 ----------
let usageSeq = 0;
export async function loadAdminUsage(r: UsageRange): Promise<void> {
  const my = ++usageSeq;
  batch(() => { usageRange.value = r; usageState.value = "loading"; });
  try {
    const qs = usageQuery(r);
    const d = await api<AdminUsageData>("/api/admin/usage" + (qs ? "?" + qs : ""));
    if (my !== usageSeq) return;
    batch(() => { usageData.value = d; usageState.value = "ok"; });
  } catch (e) {
    if (my !== usageSeq) return;
    batch(() => { usageError.value = (e as Error).message; usageState.value = "error"; });
  }
}

/** 导出当前区间的 CSV（带 BOM，Excel 直接打开不乱码）。没有数据返回 false */
export function usageCsv(): string | null {
  const d = usageData.value;
  if (!d || !d.by_user) return null;
  const head = ["用户", "输入", "输出", "缓存读", "轮次", "费用"];
  const lines = [head].concat(d.by_user.map((u) => [u.display_name || ("#" + u.user_id), u.input ?? 0, u.output ?? 0, u.cache_read ?? 0, u.turns ?? 0, u.cost ?? ""] as any));
  return lines.map((r) => r.map((x) => `"${String(x).replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

// ---------- 分区 ----------
export async function sectionCreate(name: string): Promise<void> {
  await post("/api/sections", { name });
  void loadSideSections();   // 左栏的分区列表跟着更新
}
export async function sectionPatch(id: number, body: Record<string, unknown>): Promise<void> {
  await post(`/api/sections/${id}`, body, "PATCH");
  void loadSideSections();
  await reload();
}
export const reloadSections = (): Promise<void> => reload();

// ---------- 跟着网址走 ----------
let lastKey = "";

function leave(): void {
  seq++; usageSeq++;
  clearTimeout(chatsTimer);
  currentTab = null;
  batch(() => {
    state.value = "loading"; users.value = []; allSessions.value = []; workspaceUsage.value = null; library.value = [];
    localSkills.value = { dir: "", skills: [] }; submissions.value = []; fileOps.value = []; settings.value = null; sections.value = [];
    usageData.value = null; pendingCount.value = 0; openGroups.value = [];
  });
}

/** 开始同步（登录以后才同步）：进入 /admin/{tab} 就取数据，离开就清掉；非管理员回首页；
 *  聊天记录里的会话（?session=）交给 chat store 取，离开时把主界面的会话还给背景页。返回停止函数 */
export function startAdminSync(): () => void {
  const stopSess = onSessionUpdate(onSession);
  const stop = effect(() => {
    const r = route.value;
    const u = me.value;
    const on = !!u && r.name === "admin";
    const tab = on ? (r as { tab: AdminTab }).tab : null;
    const sid = on && tab === "chats" ? ((r as { session?: string }).session || "") : "";
    untracked(() => {
      if (on && u!.role !== "admin") { replace("/", { force: true }); return; }
      const key = tab || "";
      if (key !== lastKey) {
        lastKey = key;
        if (tab) { currentTab = tab; void loadTab(tab); } else leave();
      }
      if (sid !== viewing) {
        const was = viewing;
        viewing = sid;
        if (sid) void viewSession(sid);
        else if (was) void syncRoute(mainRoute.peek());   // 看完别人的会话：主界面还给背景页
      }
    });
  });
  return () => { stop(); stopSess(); };
}
