// 请求封装：带 Authorization 头，401 时通知登录层，错误文案沿用老代码。
// 令牌放在 stores/auth.ts 里；这里只通过 configureApi 拿到，避免模块互相引用。

export interface ApiOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  /** 不加 Content-Type（上传文件、FormData 用） */
  raw?: boolean;
  /** 读出响应头 X-Event-Seq（会话列表快照的事件序号）；在检查响应状态之前就会调用 */
  onSeq?: (seq: number) => void;
  /** 读出响应头 X-Next-Before（列表下一页的游标，没有下一页时是空串）；在检查响应状态之前就会调用 */
  onNext?: (before: string) => void;
}

interface ApiHooks {
  getToken: () => string;
  /** 收到 401（登录接口除外）时调用 */
  onUnauthorized: () => void;
}

let hooks: ApiHooks = { getToken: () => "", onUnauthorized: () => {} };

export function configureApi(h: Partial<ApiHooks>): void {
  hooks = { ...hooks, ...h };
}

export function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { onSeq, onNext, raw, headers: extra, ...fetchOpts } = opts;
  const headers: Record<string, string> = { Authorization: "Bearer " + hooks.getToken(), ...(extra || {}) };
  if (!raw) headers["Content-Type"] = "application/json";
  return fetch(path, { ...fetchOpts, headers }).then(async (r) => {
    if (onSeq) {
      const n = parseInt(r.headers.get("X-Event-Seq") ?? "", 10);
      if (n >= 0) onSeq(n);
    }
    if (onNext) onNext(r.headers.get("X-Next-Before") ?? "");
    if (r.status === 401 && !path.startsWith("/api/login")) {
      hooks.onUnauthorized();
      throw new Error("请先登录");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data && data.detail) || "出错了：" + r.status);
    return data as T;
  });
}

export const post = <T = any>(path: string, body?: unknown, method = "POST"): Promise<T> =>
  api<T>(path, { method, body: JSON.stringify(body || {}) });

/** 一页一页取完整个列表（服务端用 X-Next-Before 给下一页的游标）。onPage 每到一页调用一次，返回 false 就不再往下取。
 *  老版本服务端不认 limit，会一次全给、也没有游标，这里照样能用。 */
export async function apiPages<T>(path: string, pageSize: number, onPage: (rows: T[], first: boolean) => boolean | void,
  opts: ApiOptions = {}): Promise<void> {
  const sep = path.includes("?") ? "&" : "?";
  let before = "", first = true;
  do {
    let next = "";
    const url = `${path}${sep}limit=${pageSize}` + (before ? `&before=${encodeURIComponent(before)}` : "");
    const rows = await api<T[]>(url, { ...opts, onSeq: first ? opts.onSeq : undefined, onNext: (b) => { next = b; } });
    if (onPage(rows, first) === false) return;
    before = next; first = false;
  } while (before);
}

/** 取二进制内容（文件预览：docx、xlsx）。带 Authorization 头；失败抛“读取失败” */
export async function apiBlob(path: string): Promise<Blob> {
  const r = await fetch(path, { headers: { Authorization: "Bearer " + hooks.getToken() } });
  if (r.status === 401) { hooks.onUnauthorized(); throw new Error("请先登录"); }
  if (!r.ok) throw new Error("读取失败");
  return r.blob();
}
