// 路由 ↔ 还由老代码渲染的弹层（知识库、管理后台，以及对话框形式的技能、用量、手机二维码）。文件库已经是组件，自己跟着网址走（stores/files.ts）。
// 网址变成 /kb、/skills、/usage、/mobile、/admin/{tab} 时打开对应的老弹层；老弹层被关掉（关闭按钮、Esc、点遮罩）时，
// 把网址退回背景页。老代码自己打开的弹层（比如点一个文件小标签打开文件库）也会把网址更新成对应的路径。
// 弹层内部的切换（知识库切页签和笔记、技能详情）暂时不写进网址。
import { effect, untracked } from "@preact/signals";
import type { Route } from "../router";
import { addLeaveGuard, closeOverlay, navigate, overlayRoute, replace } from "../router";
import { me } from "./auth";
import { loadSkills } from "./composer";
import { closeDialog, dialog, dismissDialog } from "./ui";

declare const window: Window & { legacy: any; openKB: (v?: string) => Promise<void>; openAdmin: (t?: string) => void; kbOpenPath?: (p: string) => void; kbBeforeClose?: () => boolean };

const BOXES: Array<[string, string]> = [["kbBox", "kb"], ["adminBox", "admin"]];
/** 用对话框显示的老弹层：技能、用量、手机二维码 */
const isDialogRoute = (r: Route): boolean => r.name === "skills" || r.name === "usage" || r.name === "mobile";
const el = (id: string) => document.getElementById(id);
const shown = (id: string) => !!el(id)?.classList.contains("show");

let lastKey: string | null = null;

/** 打开 r 对应的老弹层；别的老弹层先收起 */
function apply(r: Route | null): void {
  const key = r ? JSON.stringify(r) : null;
  if (key === lastKey) return;
  lastKey = key;
  const keep = r ? (r.name === "kb" ? "kbBox" : r.name === "admin" ? "adminBox" : "") : "";
  for (const [id] of BOXES) {
    if (id === keep || !shown(id)) continue;
    if (id === "kbBox") window.kbBeforeClose?.(); else el(id)?.classList.remove("show");
  }
  if (r === null && dialog.peek()) dismissDialog();   // 用户式关闭：对话框上挂着的 Promise（确认、同名处理）要能收到“取消”
  if (!r) return;
  const L = window.legacy;
  switch (r.name) {
    case "kb":
      if (!shown("kbBox")) void window.openKB(r.tab).then(() => { if (r.note) window.kbOpenPath?.(r.note); });
      break;
    case "admin":
      if (me.peek() && me.peek()!.role !== "admin") { replace("/", { force: true }); break; }
      window.openAdmin(r.tab);
      break;
    case "skills":
      if (r.skill) void L.openSkillDetail(r.skill);
      else void loadSkills().then(() => L.openMySkills());
      break;
    case "usage": L.openUsage(); break;
    case "mobile": void L.showMobile(); break;
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
      const id = (mu.target as HTMLElement).id;
      const name = BOXES.find((b) => b[0] === id)?.[1];
      if (!name) continue;
      const open = shown(id);
      const cur = overlayRoute.peek();
      if (open && cur?.name !== name) {
        lastKey = name;   // 老代码自己打开的：网址跟上，不要再触发一次打开
        navigate(name === "admin" ? "/admin/users" : "/" + name);
        lastKey = JSON.stringify(overlayRoute.peek());
      } else if (!open && cur?.name === name) closeOverlay({ force: true });
    }
  });
  for (const [id] of BOXES) { const e = el(id); if (e) obs.observe(e, { attributes: true, attributeFilter: ["class"] }); }
  stops.push(() => obs.disconnect());

  // 对话框形式的老弹层被关掉：网址退回背景页
  let prev = dialog.peek();
  stops.push(effect(() => {
    const d = dialog.value;
    const was = prev;
    prev = d;
    const cur = untracked(() => overlayRoute.peek());
    if (was && !d && cur && isDialogRoute(cur)) untracked(() => { lastKey = null; closeOverlay({ force: true }); });
  }));

  // 知识库有没保存的编辑：离开 /kb 前先问（后退键也走这里）
  stops.push(addLeaveGuard((to) => {
    if (!shown("kbBox") || to.startsWith("/kb")) return true;
    return window.kbBeforeClose ? window.kbBeforeClose() !== false : true;
  }));
  return () => stops.forEach((f) => f());
}
