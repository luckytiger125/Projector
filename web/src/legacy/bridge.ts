// 桥接：让还没迁移的老弹层代码（文件库、知识库、技能、用量、管理后台、设置、手机二维码、头像、改密码，
// 即 legacy/app.js、admin.js、kb.js）继续工作。它们是按“经典脚本”写的，直接读写一批全局变量、调用一批全局函数；
// 外壳、对话这些已经换成了组件和 store，所以在老代码加载之前，这里先把这些全局接到新的 store 和组件上。
// 本文件必须在 virtual:legacy 之前 import。迁完一块老弹层，就删掉它依赖的那几行；全部迁完这个文件整个删掉。
//
// ===== 老弹层依赖的全局（搜 legacy/*.js 得到的清单） =====
// 变量（读写都接到 store 上，老代码里 `me = {...}` 这样的赋值会写进 signal）：
//   me            ← stores/auth.me                    当前用户
//   token         ← stores/auth.token                 登录令牌（invoke 桌面壳命令时要带）
//   current       ← stores/chat.current               当前会话 id
//   currentSess   ← stores/chat.currentSess           当前会话对象
//   links         ← stores/chat.links                 当前会话的本机文件夹
//   sections      ← stores/sessions.sections          分区列表
//   mySkills      ← stores/composer.mySkills          我能用的技能
//   composer      ← stores/composer（refs / skill / workDir 三个属性）
//   fileRoots     ← stores/roots                      文件库、工作区根目录和 Office 预览能力（legacy F.roots / F.office 转发到它）
// 函数：
//   api post                      ← lib/api              请求
//   toast flash                   ← stores/ui            提示条
//   dialog closeDialog dialogOpen ← stores/ui + DialogHost   通用对话框：dialog() 同步返回 #dlgBody 元素
//   openSession(id|null)          ← 路由 navigate         /s/{id}、/s/new
//   ensureSession upsertSession   ← stores/chat
//   addRef resetComposer loadSkills composerInput        ← stores/composer
//   sessionSectionName sessStatus ← stores/sessions、lib/format
//   afterPasswordChange           清令牌、回登录页
//   isMine()                      ← stores/chat.isMine
//   md sanitizeHtml esc           ← lib/markdown
//   icon orb avatarEl AVATAR_LIST AVATAR_NAMES           ← lib/icons、lib/avatars
//   fsize fdate ftime rel baseName fmtTok fmtCost localYmd shortPath      ← lib/format（shortPath 带上 fileRoots）
//   countUp IS_DESKTOP IS_MAC invoke                     小零件和桌面壳
// 老代码主动挂出来、组件会调用的：
//   window.legacy.{showFiles openTrash openMySkills openSkillDetail openUsage showMobile pickAvatar changePassword
//                  pickSessionSection syncBack openLocalDialog}   （app.js 末尾）
//   window.openKB window.openAdmin window.kbOpenPath window.kbDistill window.kbBeforeClose window.kbInit window.kbLinkify
//   window.KBDATA window.onKbLoaded window.adminOnSession      （kb.js、admin.js）
// 老弹层的开关和网址同步见 stores/overlays.ts。
import { effect } from "@preact/signals";
import { options } from "preact";
import { api, post } from "../lib/api";
import { AVATAR_LIST, AVATAR_NAMES, avatarEl, orb } from "../lib/avatars";
import { invoke, isDesktop, isMac } from "../lib/desktop";
import {
  baseName, fdate, fmtCost, fmtTok, fsize, ftime, localYmd, rel, sessStatus, shortPath,
} from "../lib/format";
import { iconSvg } from "../lib/icons";
import { escapeHtml, md, sanitizeHtml, setMarkdownLinkify } from "../lib/markdown";
import { me, showLogin, store, token } from "../stores/auth";
import { onEnter } from "../stores/boot";
import {
  current, currentSess, ensureSession, isMine, links, onSessionUpdate, upsertSession,
} from "../stores/chat";
import {
  addRef, composerInput, loadSkills, mySkills, refs, resetComposer, skill, workDir,
} from "../stores/composer";
import { onReload } from "../stores/events";
import { kbCount, kbData } from "../stores/kb";
import { loadRoots, office, roots } from "../stores/roots";
import { sections, sessionSectionName } from "../stores/sessions";
import { closeDialog, dialog, flash, openDialog, toast } from "../stores/ui";
import type { DialogButton } from "../stores/ui";
import { navigate, replace, overlayRoute } from "../router";

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

/** 全局名 ↔ signal */
function accessor(name: string, get: () => unknown, set: (v: any) => void): void {
  Object.defineProperty(g, name, { get, set, configurable: true });
}

accessor("me", () => me.value, (v) => { me.value = v; });
accessor("token", () => token.value, (v) => { token.value = v; });
accessor("current", () => current.value, (v) => { current.value = v; });
accessor("currentSess", () => currentSess.value, (v) => { currentSess.value = v; });
accessor("links", () => links.value, (v) => { links.value = v; });
accessor("sections", () => sections.value, (v) => { sections.value = v; });
accessor("mySkills", () => mySkills.value, (v) => { mySkills.value = v; });
g.composer = {
  get refs() { return refs.value; }, set refs(v) { refs.value = v; },
  get skill() { return skill.value; }, set skill(v) { skill.value = v; },
  get workDir() { return workDir.value; }, set workDir(v) { workDir.value = v; },
};
g.fileRoots = {
  get: () => ({ roots: roots.value, office: office.value }),
  set: (p: { roots?: string[]; office?: boolean }) => {
    if (p.roots) roots.value = p.roots;
    if (p.office !== undefined) office.value = p.office;
  },
};

g.api = api;
g.post = post;
g.toast = toast;
g.flash = flash;
g.esc = escapeHtml;
g.md = md;
g.sanitizeHtml = sanitizeHtml;
g.icon = iconSvg;
g.orb = orb;
g.avatarEl = avatarEl;
g.AVATAR_LIST = AVATAR_LIST;
g.AVATAR_NAMES = AVATAR_NAMES;
g.fsize = fsize; g.fdate = fdate; g.ftime = ftime; g.rel = rel; g.baseName = baseName;
g.fmtTok = fmtTok; g.fmtCost = fmtCost; g.localYmd = localYmd;
g.shortPath = (p: string) => shortPath(p, roots.value);
g.sessStatus = sessStatus;
g.sessionSectionName = sessionSectionName;
g.isMine = () => isMine.value;
g.IS_DESKTOP = isDesktop();
g.IS_MAC = isMac();
g.invoke = invoke;
g.ensureSession = ensureSession;
g.upsertSession = upsertSession;
g.addRef = addRef;
g.resetComposer = resetComposer;
g.loadSkills = loadSkills;
g.composerInput = composerInput;

g.countUp = (el: HTMLElement, to: number, ms = 900): void => {
  const start = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / ms);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** 打开会话：网址是唯一入口。从弹层里点进会话（比如知识库笔记里的“来源会话”）时替换弹层这一条历史，免得后退又回到弹层 */
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
g.dialogOpen = (): boolean => !!dialog.value;

g.afterPasswordChange = async (): Promise<void> => {
  token.value = "";
  store.del("token");
  me.value = null;
  await showLogin();
};

// ---------- 知识库露出的两块 ----------
g.setKbCount = (n: number): void => { kbCount.value = n; };
g.onKbLoaded = (): void => { kbData.value = g.KBDATA || null; };
setMarkdownLinkify((t) => (g.kbLinkify ? g.kbLinkify(t) : t));

// ---------- 进入应用、整体重载时老代码要做的事 ----------
onEnter(() => { g.kbInit?.(); });
onReload(() => { void loadRoots(); });
onSessionUpdate((s) => { g.adminOnSession?.(s); });
effect(() => { void me.value; });   // 保证 me 被订阅过（占位，无副作用）
