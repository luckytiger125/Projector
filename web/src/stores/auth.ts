// 登录状态：令牌、当前用户、登录层。
// 令牌存 localStorage，只通过 Authorization 头发出，不进网址；HttpOnly cookie 给 EventSource、图片、下载这些带不了头的 GET 用。
import { computed, signal } from "@preact/signals";
import { api, configureApi, post } from "../lib/api";
import type { User } from "../lib/types";

// ---------- localStorage（读写都可能抛错，吞掉） ----------
export const store = {
  get(k: string): string { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  del(k: string): void { try { localStorage.removeItem(k); } catch { /* 忽略 */ } },
};

export const token = signal<string>(store.get("token"));
export const me = signal<User | null>(null);
export const isAdmin = computed(() => me.value?.role === "admin");

/** 登录层是否显示（盖在上面，不改网址） */
export const loginVisible = signal(false);
/** 首次创建管理员模式 */
export const setupMode = signal(false);
/** 创建管理员时的提示（比如不是本机打开时不让创建）；登录失败文案也放这里 */
export const loginError = signal("");
export const lastUsername = (): string => store.get("username");

// ---------- 登录失效时通知别的 store（比如断开 SSE） ----------
const lostHandlers = new Set<() => void>();
export function onLoginRequired(fn: () => void): () => void {
  lostHandlers.add(fn);
  return () => lostHandlers.delete(fn);
}

configureApi({ getToken: () => token.value, onUnauthorized: () => { void showLogin(); } });

/** 显示登录页：先断开事件流，再问服务端是不是还没有管理员 */
export async function showLogin(): Promise<void> {
  for (const fn of lostHandlers) fn();
  loginVisible.value = true;
  loginError.value = "";
  try {
    const s = await fetch("/api/setup").then((r) => r.json());
    setupMode.value = !!s.needed;
    if (s.needed && !s.local) loginError.value = "还没有管理员。请在台式机本机打开 http://localhost:" + location.port + " 创建";
  } catch { setupMode.value = false; }
}

export interface LoginInput { username: string; password: string; password2?: string; displayName?: string }

/** 登录或创建管理员。成功返回用户（已存好令牌、撤掉登录层，调用方接着调 enterApp），失败抛出带文案的 Error */
export async function submitLogin(input: LoginInput): Promise<User> {
  const username = input.username.trim();
  if (setupMode.value && input.password !== input.password2) throw new Error("两次密码不一样");
  const r = await fetch(setupMode.value ? "/api/setup" : "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: input.password, display_name: (input.displayName || "").trim() }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || "登录失败");
  token.value = data.token;
  store.set("token", data.token);
  store.set("username", username);
  loginVisible.value = false;
  return data.user as User;   // me 由 enterApp 在重置各个 store 之后再设置
}

/** 退出登录（确认框由调用方负责）。出错也照样清掉本地状态 */
export async function logout(): Promise<void> {
  try { await post("/api/logout"); } catch { /* 忽略 */ }
  token.value = "";
  store.del("token");
  me.value = null;
  await showLogin();
}

/** 启动：有令牌就补种 cookie（升级前登录的人没有）再取 /api/me；没有令牌直接显示登录页。返回当前用户或 null */
export async function bootstrapAuth(): Promise<User | null> {
  if (!token.value) { await showLogin(); return null; }
  // 补种失败不拦着：401 时 api() 已经弹出登录页，其他错误（比如网络）继续往下走，/api/me 自己会处理
  await api("/api/session-cookie", { method: "POST" }).catch(() => {});
  try {
    return await api<User>("/api/me");   // me 由 enterApp 在重置各个 store 之后再设置
  } catch { return null; }
}

/** 把 /api/me 的最新内容合并进当前用户（SSE 出错时探测登录是否失效用） */
export function refreshMe(): Promise<void> {
  return api<User>("/api/me").then((u) => { me.value = { ...(me.value as User), ...u }; }).catch(() => {});
}
