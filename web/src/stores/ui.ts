// 界面层状态：提示条、通用对话框、主题、命令面板、手机上的左栏抽屉。
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
  /** 返回 false 则不关闭；抛错会把错误文案显示在对话框里（.err 元素）或提示条里 */
  onClick?: () => unknown | Promise<unknown>;
}
export interface DialogSpec {
  title: string;
  /** 内容：组件，或（过渡期老代码）一段 HTML 字符串 */
  body: ComponentChildren | { html: string };
  buttons: DialogButton[];
  wide: boolean;
}
export const dialog = signal<DialogSpec | null>(null);

export function openDialog(title: string, body: DialogSpec["body"], buttons: DialogButton[] = [], wide = false): void {
  dialog.value = { title, body, buttons, wide };
}
export function closeDialog(): void {
  dialog.value = null;
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

// ---------- 命令面板、手机抽屉 ----------
export const paletteOpen = signal(false);
export const drawerOpen = signal(false);
