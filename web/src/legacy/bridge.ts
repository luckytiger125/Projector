// 桥接：让还没迁移的老弹层代码（只剩管理后台 legacy/admin.js）继续工作。
// 它是按“经典脚本”写的，直接读写一批全局变量、调用一批全局函数；
// 外壳、对话、文件库、知识库、技能、用量等已经换成了组件和 store，所以在老代码加载之前，这里先把这些全局接到新的 store 和组件上。
// 本文件必须在 virtual:legacy 之前 import。阶段七迁完管理后台，这个文件整个删掉。
//
// ===== 管理后台依赖的全局（搜 legacy/admin.js 得到的清单；阶段六删掉知识库后重搜过，没人用的已经删了） =====
// 变量：
//   me            ← stores/auth.me                    当前用户（读）
// 函数：
//   api post                      ← lib/api              请求
//   toast                         ← stores/ui            提示条
//   dialog closeDialog            ← stores/ui + DialogHost   通用对话框：dialog() 同步返回 #dlgBody 元素
//   openSession(id|null)          ← 路由 navigate         /s/{id}、/s/new
//   esc icon orb avatarEl AVATAR_LIST                   ← lib/markdown、lib/icons、lib/avatars
//   fsize ftime shortPath sessStatus                    ← lib/format（shortPath 带上 stores/roots）
//   countUp                                             小零件
//   openTrash                                           ← stores/files   后台“文件记录”里的回收站入口
//   fileViewer(标题, 文件, 按钮, 说明html, 改动)           ← features/skills/SkillFiles   后台“审核技能”“技能库”查看文件；阶段七删
//   openSkillDetail(name)                                 ← 路由 /skills/{name}          后台技能库的“版本记录”；阶段七删
// 老代码主动挂出来、组件会调用的：
//   window.openAdmin window.adminOnSession      （admin.js）
// 老弹层的开关和网址同步见 stores/overlays.ts。
import { h, options } from "preact";
import { api, post } from "../lib/api";
import { AVATAR_LIST, avatarEl, orb } from "../lib/avatars";
import { fsize, ftime, sessStatus, shortPath } from "../lib/format";
import { iconSvg } from "../lib/icons";
import { escapeHtml } from "../lib/markdown";
import { me } from "../stores/auth";
import { onSessionUpdate } from "../stores/chat";
import { onReload } from "../stores/events";
import { openTrash } from "../stores/files";
import { loadRoots, roots } from "../stores/roots";
import { closeDialog, openDialog, toast } from "../stores/ui";
import type { DialogButton } from "../stores/ui";
import { navigate, replace, overlayRoute } from "../router";
import { openSkillFiles } from "../features/skills/SkillFiles";

const g = window as any;

// 让 dialog() 能同步渲染：接管 Preact 的“排队渲染”，默认走微任务（和自带的行为一样快），需要时可以立刻冲刷
let queued: (() => void) | null = null;
function flushRender(): void {
  const cb = queued;
  queued = null;
  cb?.();
}
options.debounceRendering = (cb: () => void) => {
  const first = !queued;
  queued = cb;
  if (first) queueMicrotask(flushRender);
};

Object.defineProperty(g, "me", { get: () => me.value, set: (v) => { me.value = v; }, configurable: true });

g.api = api;
g.post = post;
g.toast = toast;
g.esc = escapeHtml;
g.icon = iconSvg;
g.orb = orb;
g.avatarEl = avatarEl;
g.AVATAR_LIST = AVATAR_LIST;
g.fsize = fsize; g.ftime = ftime;
g.shortPath = (p: string) => shortPath(p, roots.value);
g.openTrash = openTrash;
g.sessStatus = sessStatus;

g.countUp = (el: HTMLElement, to: number, ms = 900): void => {
  const start = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / ms);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** 打开会话：网址是唯一入口。从弹层里点进会话时替换弹层这一条历史，免得后退又回到弹层 */
g.openSession = (id: string | null): void => {
  const to = id ? "/s/" + id : "/s/new";
  if (overlayRoute.peek()) replace(to, { force: true }); else navigate(to, { force: true });
};

// ---------- 通用对话框：dialog(标题, html, 按钮, 宽) 同步返回内容元素 ----------
g.dialog = (title: string, html: string, buttons: DialogButton[] = [], wide = false): HTMLElement | null => {
  openDialog(title, { html }, buttons, wide);
  flushRender();   // 同步渲染一次：老代码拿到返回的元素后马上要往里绑事件
  return document.getElementById("dlgBody");
};
g.closeDialog = closeDialog;

// ---------- 技能：后台（admin.js）还在用的两个入口 ----------
/** 文件查看器：后台“审核技能”“技能库”用。说明（extraHtml）是后台自己拼的、已转义的 HTML；同步渲染，返回内容元素 */
g.fileViewer = (title: string, files: any[], buttons: DialogButton[] = [], extraHtml = "", changes: any = null): HTMLElement | null => {
  openSkillFiles(title, files, buttons, extraHtml ? h("div", { dangerouslySetInnerHTML: { __html: extraHtml } }) : undefined, changes);
  flushRender();
  return document.getElementById("dlgBody");
};
/** 技能详情是组件，网址 /skills/{name}；从后台点进去，后台收起，后退回到后台 */
g.openSkillDetail = (name: string): void => { navigate("/skills/" + encodeURIComponent(name)); };

// ---------- 整体重载时老代码要做的事 ----------
onReload(() => { void loadRoots(); });
onSessionUpdate((s) => { g.adminOnSession?.(s); });
