// 路由 → 当前会话的同步：主界面路由变了，就让 chat store 跟着变。
// /s/{id}：current 已经是它就什么都不做（新建会话后 ensureSession 已经设好了 current 并 replace 了网址，不能再取一次）。
import { effect, untracked } from "@preact/signals";
import type { Route } from "../router";
import { mainRoute, replace } from "../router";
import { me } from "./auth";
import { current, openSession, resetChat } from "./chat";
import { resetComposer } from "./composer";
import { toast } from "./ui";

export async function syncRoute(r: Route): Promise<void> {
  switch (r.name) {
    case "session":
      if (current.peek() === r.id) return;
      try { await openSession(r.id); }
      catch (e) {
        // 会话不存在或无权：提示并回到首页（取的过程中已经换了别的会话就不管）
        if (current.peek() !== r.id) return;
        toast((e as Error).message, "err");
        resetChat();
        replace("/", { force: true });
      }
      return;
    case "new":
      if (current.peek() !== null) { resetComposer(); await openSession(null); }
      return;
    case "notfound":
      replace("/", { force: true });
      resetChat();
      return;
    default:   // home / board
      if (current.peek() !== null) resetChat();
  }
}

/** 开始同步（登录后才同步）。返回停止函数 */
export function startRouteSync(): () => void {
  return effect(() => {
    const r = mainRoute.value;
    if (!me.value) return;
    untracked(() => { void syncRoute(r); });
  });
}
