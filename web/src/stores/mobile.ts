// 在手机上打开：局域网地址的二维码。网址 /mobile。二维码库（qrcode-generator）动态加载，不进首屏。
import { batch, effect, signal, untracked } from "@preact/signals";
import { api } from "../lib/api";
import { loadQrcode } from "../lib/vendor";
import { closeOverlay, route } from "../router";
import { me } from "./auth";
import { toast } from "./ui";

/** 能用的地址（没有局域网地址就用当前地址） */
export const urls = signal<string[]>([]);
export const picked = signal("");
export const qrSvg = signal("");
export const ready = signal(false);

let qrcode: any = null;

/** 把地址画成二维码的 SVG：中间留给橙光球，三个定位角用橙色，圆点风格。和老代码画法一致 */
export function renderQr(qr: any): string {
  const n = qr.getModuleCount(), c = Math.floor(n / 2), hole = Math.ceil(n * 0.13);
  let rects = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!qr.isDark(y, x) || (Math.abs(x - c) <= hole && Math.abs(y - c) <= hole)) continue;
    const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    rects += `<rect x="${x + .06}" y="${y + .06}" width=".88" height=".88" rx="${finder ? .2 : .42}" fill="${finder ? "#c24f1c" : "#201b15"}"/>`;
  }
  return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="geometricPrecision">${rects}</svg>`;
}

export function pick(url: string): void {
  if (!qrcode) return;
  const qr = qrcode(0, "H");
  qr.addData(url);
  qr.make();
  batch(() => { picked.value = url; qrSvg.value = renderQr(qr); });
}

let seq = 0;

async function load(): Promise<void> {
  const my = ++seq;
  try {
    const lan = await api<{ urls: string[] }>("/api/lan");
    const list = lan.urls.length ? lan.urls : [location.origin];
    qrcode = await loadQrcode();
    if (my !== seq) return;
    urls.value = list;
    pick(list[0]);
    ready.value = true;
  } catch (e) {
    // 和老代码一样：只提示错误，不打开
    if (my !== seq) return;
    toast((e as Error).message, "err");
    closeOverlay({ force: true });
  }
}

let was = false;

/** 进入 /mobile 就取地址。返回停止函数 */
export function startMobileSync(): () => void {
  return effect(() => {
    const on = !!me.value && route.value.name === "mobile";
    untracked(() => {
      if (on && !was) { ready.value = false; void load(); }
      if (!on && was) { seq++; ready.value = false; }
      was = on;
    });
  });
}
