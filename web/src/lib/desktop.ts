// 桌面壳（Tauri）探测和调用的封装。浏览器里这些都是空操作或返回 false。

type TauriWindow = Window & { __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } };
const tauri = (): TauriWindow["__TAURI__"] => (window as TauriWindow).__TAURI__;

export const isDesktop = (): boolean => !!(tauri() && tauri()!.core);
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);

export function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  const t = tauri();
  if (!t || !t.core) return Promise.reject(new Error("不在桌面软件里"));
  return t.core.invoke(cmd, args) as Promise<T>;
}

/** 页面没有焦点时弹系统通知（桌面壳走 Tauri 通知插件，浏览器走 Notification，没授权就不弹） */
export function systemNotify(text: string): void {
  if (document.hasFocus()) return;
  if (isDesktop()) {
    invoke("plugin:notification|notify", { options: { title: "Claude 工作台", body: text } }).catch(() => {});
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification("Claude 工作台", { body: text }); } catch { /* 忽略 */ }
}

/** 第一次发送时请求浏览器通知权限（桌面壳不需要） */
export function requestNotifyPermission(): void {
  if (!isDesktop() && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
}
