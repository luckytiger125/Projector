// 界面层状态：提示条、通用对话框、主题、命令面板。
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { store } from "./auth";

// ---------- 提示条 ----------
export type ToastKind = "info" | "ok" | "err";
export interface ToastItem { id: number; text: string; kind: ToastKind; /** in 显示中 / out 正在淡出 */ phase: "in" | "out" }

export const toasts = signal<ToastItem[]>([]);
let toastSeq = 0;

/** 和老代码一样：ms 毫秒后开始淡出，再过 400 毫秒移除 */
export function toast(text: string, kind: ToastKind = "info", ms = 3600): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, text, kind, phase: "in" }];
  setTimeout(() => {
    toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, phase: "out" } : t));
    setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, 400);
  }, ms);
}
export const flash = (text: string, ms?: number): void => toast(text, "info", ms);

// ---------- 通用对话框 ----------
export interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  icon?: string;
  /** 返回 false 则不关闭；抛错会把错误文案显示在对话框里（.err 元素）或提示条里。输入框模式下参数是输入框的内容 */
  onClick?: (value: string) => unknown | Promise<unknown>;
}
export interface DialogSpec {
  title: string;
  /** 内容：组件或纯文字 */
  body: ComponentChildren;
  buttons: DialogButton[];
  wide: boolean;
  /** 危险操作：顶边用朱砂色 */
  danger?: boolean;
  /** 带一个文字输入框（回车 = 最后一个主按钮） */
  input?: { value: string; placeholder?: string };
  /** 用户用 Esc、点遮罩或右上角关掉时调用（程序里 closeDialog() 关闭不调用） */
  onDismiss?: () => void;
}
export const dialog = signal<DialogSpec | null>(null);

export function openDialog(title: string, body: DialogSpec["body"], buttons: DialogButton[] = [], wide = false, extra: Partial<DialogSpec> = {}): void {
  dialog.peek()?.onDismiss?.();   // 被新对话框顶掉的，等于被取消
  dialog.value = { title, body, buttons, wide, ...extra };
}
/** 程序关闭 */
export function closeDialog(): void {
  dialog.value = null;
}
/** 用户关闭（Esc、遮罩、关闭按钮） */
export function dismissDialog(): void {
  const d = dialog.peek();
  dialog.value = null;
  d?.onDismiss?.();
}

/** 确认框：点确认返回 true，取消、Esc、点外面返回 false */
export function confirmBox(o: { title: string; message: string; ok?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    openDialog(o.title, o.message, [
      { label: o.cancel || "取消", onClick: () => resolve(false) },
      { label: o.ok || "确定", primary: !o.danger, danger: o.danger, onClick: () => resolve(true) },
    ], false, { danger: o.danger, onDismiss: () => resolve(false) });
  });
}

/** 输入框：点确认返回输入的内容，取消返回 null */
export function promptBox(o: { title: string; message?: string; value?: string; placeholder?: string; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    openDialog(o.title, o.message || "", [
      { label: "取消", onClick: () => resolve(null) },
      { label: o.ok || "保存", primary: true, onClick: (v) => resolve(v) },
    ], false, { input: { value: o.value || "", placeholder: o.placeholder }, onDismiss: () => resolve(null) });
  });
}

// ---------- 主题 ----------
export type Theme = "auto" | "light" | "dark";
export const THEMES: Record<Theme, [string, string]> = { auto: ["跟随系统", "sparkle"], light: ["浅色", "sun"], dark: ["深色", "moon"] };
const THEME_ORDER: Theme[] = ["auto", "light", "dark"];

function readTheme(): Theme {
  const t = store.get("theme");
  return t === "light" || t === "dark" ? t : "auto";
}
export const theme = signal<Theme>(readTheme());

/** 把主题写到 <html data-theme>；auto 时去掉属性，交给系统偏好 */
export function applyTheme(mode: Theme = theme.value): void {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode; else delete root.dataset.theme;
}

export function setTheme(mode: Theme): void {
  theme.value = mode;
  store.set("theme", mode);
  applyTheme(mode);
}

/** 自动 → 浅色 → 深色 循环，切完提示“主题：xx”（用户菜单和命令面板共用） */
export function cycleTheme(): Theme {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(readTheme()) + 1) % 3];
  setTheme(next);
  toast("主题：" + THEMES[next][0]);
  return next;
}

// ---------- 命令面板 ----------
export const paletteOpen = signal(false);
