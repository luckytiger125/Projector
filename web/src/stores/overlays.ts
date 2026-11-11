// 路由 ↔ 还由老代码渲染的弹层（只剩管理后台）。文件库、知识库、技能、用量、手机二维码已经是组件，自己跟着网址走
// （stores/files.ts、kb.ts + kbsync.ts、skills.ts、usage.ts、mobile.ts）。
// 网址变成 /admin/{tab} 时打开后台；后台被关掉（关闭按钮、Esc、点遮罩）时，把网址退回背景页。
// 老代码自己打开的后台也会把网址更新成对应的路径。弹层内部的切换（后台切页签）暂时不写进网址。
import { effect } from "@preact/signals";
import type { Route } from "../router";
import { closeOverlay, navigate, overlayRoute, replace } from "../router";
import { me } from "./auth";
import { dialog, dismissDialog } from "./ui";

declare const window: Window & { openAdmin: (t?: string) => void };

const el = (id: string) => document.getElementById(id);
const shown = (id: string) => !!el(id)?.classList.contains("show");

let lastKey: string | null = null;

/** 打开 r 对应的老弹层；不是后台就把后台收起 */
function apply(r: Route | null): void {
  const key = r ? JSON.stringify(r) : null;
  if (key === lastKey) return;
  lastKey = key;
  if ((!r || r.name !== "admin") && shown("adminBox")) el("adminBox")?.classList.remove("show");
  if (r === null && dialog.peek()) dismissDialog();   // 用户式关闭：对话框上挂着的 Promise（确认、同名处理）要能收到“取消”
  if (r && r.name === "admin") {
    if (me.peek() && me.peek()!.role !== "admin") { replace("/", { force: true }); return; }
    window.openAdmin(r.tab);
  }
}

export function startOverlaySync(): () => void {
  const stops: Array<() => void> = [];
  // 路由 → 老弹层（登录以后才开）
  stops.push(effect(() => {
    const r = overlayRoute.value;
    if (!me.value) return;
    // 推迟一拍：启动时这个 effect 会在登录状态刚设好、组件还没渲染完的时候触发，dialog() 要等渲染完才能拿到内容元素
    void r;
    setTimeout(() => {
      // 用触发时的最新路由，不用排队时的（中间可能已经变了）
      const cur = overlayRoute.peek();
      apply(cur && cur.name !== "steps" ? cur : null);
    }, 0);
  }));

  // 老弹层 → 路由
  const obs = new MutationObserver((list) => {
    for (const mu of list) {
      if ((mu.target as HTMLElement).id !== "adminBox") continue;
      const open = shown("adminBox");
      const cur = overlayRoute.peek();
      if (open && cur?.name !== "admin") {
        lastKey = "admin";   // 老代码自己打开的：网址跟上，不要再触发一次打开
        navigate("/admin/users");
        lastKey = JSON.stringify(overlayRoute.peek());
      } else if (!open && cur?.name === "admin") closeOverlay({ force: true });
    }
  });
  const box = el("adminBox");
  if (box) obs.observe(box, { attributes: true, attributeFilter: ["class"] });
  stops.push(() => obs.disconnect());
  return () => stops.forEach((f) => f());
}
