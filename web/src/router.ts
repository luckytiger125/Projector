// History API 路由（总方案第 4 节）：一个 location signal，navigate / replace / back，监听 popstate。
// 本模块 import 时没有副作用；要开始监听前进后退，调用 startRouter()。
import { computed, signal } from "@preact/signals";

// ---------- 路由类型 ----------

export const ADMIN_TABS = ["users", "chats", "library", "review", "files", "usage", "sections", "settings"] as const;
export const KB_TABS = ["home", "notes", "graph"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];
export type KbTab = (typeof KB_TABS)[number];

export type Route =
  | { name: "home" }                               // /
  | { name: "board" }                              // /board
  | { name: "new" }                                // /s/new
  | { name: "session"; id: string }                // /s/{id}
  | { name: "steps"; id: string }                  // /s/{id}/steps
  | { name: "files"; path?: string; trash?: boolean }   // /files、/files?path=…、/files/trash
  | { name: "kb"; tab: KbTab; note?: string }      // /kb、/kb/notes?note=…、/kb/graph
  | { name: "skills"; skill?: string }             // /skills、/skills/{name}
  | { name: "usage" }
  | { name: "mobile" }
  | { name: "admin"; tab: AdminTab; session?: string }   // /admin/{tab}、/admin/chats?session=…
  | { name: "notfound" };

/** 写进 history.state 的内容 */
export interface HistoryState {
  /** 这条历史在本应用里的序号：用来在拦截后退时算出要走回去几步 */
  idx: number;
  /** 弹层打开时的主界面路径（刷新后弹层和背景都能还原） */
  bg?: string;
  /** 这条历史是应用里 push 出来的（后退不会离开应用） */
  app?: true;
}

export interface Loc {
  route: Route;
  /** pathname + search，已规范化 */
  path: string;
  state: HistoryState;
}

// ---------- 解析和生成 ----------

const ID_RE = /^[A-Za-z0-9_-]+$/;

function dec(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

export function parseRoute(pathname: string, search = ""): Route {
  const q = new URLSearchParams(search);
  const parts = pathname.split("/").filter(Boolean).map(dec);
  if (parts.some((p) => p === null)) return { name: "notfound" };
  const seg = parts as string[];
  const [a, b, c] = seg;
  if (!a) return { name: "home" };
  if (seg.length === 1 && a === "board") return { name: "board" };
  if (a === "s") {
    if (seg.length === 2 && b === "new") return { name: "new" };
    if (seg.length === 2 && ID_RE.test(b)) return { name: "session", id: b };
    if (seg.length === 3 && c === "steps" && ID_RE.test(b) && b !== "new") return { name: "steps", id: b };
    return { name: "notfound" };
  }
  if (a === "files") {
    if (seg.length === 1) { const path = q.get("path"); return path ? { name: "files", path } : { name: "files" }; }
    if (seg.length === 2 && b === "trash") return { name: "files", trash: true };
    return { name: "notfound" };
  }
  if (a === "kb") {
    if (seg.length === 1) return { name: "kb", tab: "home" };
    if (seg.length === 2 && (b === "notes" || b === "graph")) {
      const note = b === "notes" ? q.get("note") : null;
      return note ? { name: "kb", tab: b, note } : { name: "kb", tab: b };
    }
    return { name: "notfound" };
  }
  if (a === "skills") {
    if (seg.length === 1) return { name: "skills" };
    if (seg.length === 2) return { name: "skills", skill: b };
    return { name: "notfound" };
  }
  if (a === "usage" && seg.length === 1) return { name: "usage" };
  if (a === "mobile" && seg.length === 1) return { name: "mobile" };
  if (a === "admin") {
    if (seg.length === 1) return { name: "admin", tab: "users" };
    if (seg.length === 2 && (ADMIN_TABS as readonly string[]).includes(b)) {
      // 聊天记录里点开的会话：/admin/chats?session=…（只有聊天记录页签认）
      const sid = b === "chats" ? q.get("session") : null;
      return sid && ID_RE.test(sid) ? { name: "admin", tab: "chats", session: sid } : { name: "admin", tab: b as AdminTab };
    }
    return { name: "notfound" };
  }
  return { name: "notfound" };
}

const enc = encodeURIComponent;

export function routeToPath(r: Route): string {
  switch (r.name) {
    case "home": case "notfound": return "/";
    case "board": return "/board";
    case "new": return "/s/new";
    case "session": return "/s/" + enc(r.id);
    case "steps": return "/s/" + enc(r.id) + "/steps";
    case "files":
      if (r.trash) return "/files/trash";
      return r.path ? "/files?path=" + enc(r.path) : "/files";
    case "kb":
      if (r.tab === "home") return "/kb";
      return "/kb/" + r.tab + (r.tab === "notes" && r.note ? "?note=" + enc(r.note) : "");
    case "skills": return r.skill ? "/skills/" + enc(r.skill) : "/skills";
    case "usage": return "/usage";
    case "mobile": return "/mobile";
    case "admin": return "/admin/" + r.tab + (r.tab === "chats" && r.session ? "?session=" + enc(r.session) : "");
  }
}

export function parsePath(path: string): Route {
  const i = path.indexOf("?");
  return i < 0 ? parseRoute(path) : parseRoute(path.slice(0, i), path.slice(i));
}

/** 盖在主界面上的弹层类路由（桌面上是弹层，手机上是全屏页） */
export function isOverlay(r: Route): boolean {
  return r.name === "steps" || r.name === "files" || r.name === "kb" || r.name === "skills" ||
    r.name === "usage" || r.name === "mobile" || r.name === "admin";
}

/** 弹层没有 bg（直接输入网址打开）时的默认背景：步骤记录的背景是它所属的会话，其余是值班板 */
export function defaultBackground(r: Route): string {
  return r.name === "steps" ? routeToPath({ name: "session", id: r.id }) : "/";
}

// ---------- 状态 ----------

function readLoc(): Loc {
  const st = (history.state || {}) as Partial<HistoryState>;
  const path = location.pathname + location.search;
  return { route: parseRoute(location.pathname, location.search), path, state: { idx: st.idx ?? 0, bg: st.bg, app: st.app } };
}

/** 当前位置。组件读它；它只在 navigate / replace / back / popstate 后更新 */
export const loc = signal<Loc>(readLoc());
export const route = computed(() => loc.value.route);

/** 主界面应该显示的路由：当前是弹层就取 history.state.bg（没有就用默认背景），否则就是当前路由 */
export const mainRoute = computed<Route>(() => {
  const l = loc.value;
  if (!isOverlay(l.route)) return l.route;
  return parsePath(l.state.bg ?? defaultBackground(l.route));
});
export const overlayRoute = computed<Route | null>(() => (isOverlay(loc.value.route) ? loc.value.route : null));

// ---------- 离开守卫 ----------

/** 返回 false 表示拦住这次离开（比如知识库有未保存的编辑）。只能同步，因为后退键拦截要立刻决定 */
export type LeaveGuard = (to: string) => boolean;
const guards = new Set<LeaveGuard>();

export function addLeaveGuard(fn: LeaveGuard): () => void {
  guards.add(fn);
  return () => guards.delete(fn);
}
function allowed(to: string): boolean {
  for (const g of guards) if (!g(to)) return false;
  return true;
}

// ---------- 导航 ----------

let lastIdx = 0;   // 上一次确认过的历史序号：拦截后退时据此算出要走回去几步

function commit(): void {
  loc.value = readLoc();
  lastIdx = loc.value.state.idx;
}

function toPath(to: string | Route): string {
  return typeof to === "string" ? routeToPath(parsePath(to)) : routeToPath(to);
}

function stamp(): void {
  // 直接打开或刷新时，当前历史项可能没有我们的 state：补上序号，保留已有的 bg / app
  const st = history.state as Partial<HistoryState> | null;
  if (!st || typeof st.idx !== "number") history.replaceState({ ...(st || {}), idx: 0 }, "");
}

export interface NavOptions {
  /** 不拦截（离开守卫已经问过了，或者是代码内部的跳转） */
  force?: boolean;
}

/** push 一条新历史。从主界面打开弹层时自动记下背景；弹层里再跳弹层，背景沿用 */
export function navigate(to: string | Route, opts: NavOptions = {}): boolean {
  const path = toPath(to);
  if (!opts.force && !allowed(path)) return false;
  stamp();
  const cur = readLoc();
  if (path === cur.path) return true;
  const target = parsePath(path);
  const state: HistoryState = { idx: cur.state.idx + 1, app: true };
  if (isOverlay(target)) state.bg = isOverlay(cur.route) ? (cur.state.bg ?? defaultBackground(cur.route)) : cur.path;
  history.pushState(state, "", path);
  commit();
  return true;
}

/** 换掉当前历史项（弹层内部切页签、进目录、重定向）。保留 idx、bg、app */
export function replace(to: string | Route, opts: NavOptions = {}): boolean {
  const path = toPath(to);
  if (!opts.force && !allowed(path)) return false;
  stamp();
  const cur = readLoc();
  const state: HistoryState = { ...cur.state };
  // 从弹层换成非弹层：背景没意义了，去掉；换成弹层且还没有背景：记下
  if (!isOverlay(parsePath(path))) delete state.bg;
  else if (!isOverlay(cur.route) && state.bg === undefined) state.bg = cur.path;
  history.replaceState(state, "", path);
  commit();
  return true;
}

export function back(): void {
  history.back();
}

/**
 * 关闭弹层：从应用里点开的（历史里有上一条）就后退，一致于后退键；
 * 直接打开的就 replace 到背景路径，这样不会后退出应用。
 */
export function closeOverlay(opts: NavOptions = {}): boolean {
  const cur = readLoc();
  if (cur.state.app && cur.state.idx > 0) {
    history.back();   // 守卫在 popstate 里统一问一次，这里不重复问
    return true;
  }
  const bg = cur.state.bg ?? defaultBackground(cur.route);
  if (!opts.force && !allowed(bg)) return false;
  return replace(bg, { force: true });
}

// ---------- popstate ----------

let listening = false;
let ignorePop = 0;

function onPop(): void {
  if (ignorePop > 0) { ignorePop--; return; }
  const next = readLoc();
  if (!allowed(next.path)) {
    // 拦住：走回去。popstate 已经发生了，要反向走 delta 步回到原来的位置
    const delta = next.state.idx - lastIdx;
    if (delta !== 0) { ignorePop++; history.go(-delta); }
    return;
  }
  loc.value = next;
  lastIdx = next.state.idx;
}

export function startRouter(): void {
  if (listening) return;
  listening = true;
  stamp();
  commit();
  window.addEventListener("popstate", onPop);
}

export function stopRouter(): void {
  listening = false;
  window.removeEventListener("popstate", onPop);
}
