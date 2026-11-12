import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replace, startRouter, stopRouter } from "../router";
import { me } from "./auth";
import { picked, pick, qrSvg, ready, renderQr, startMobileSync, urls } from "./mobile";
import { toasts } from "./ui";

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// 假的二维码库：21x21，对角线是深色，中间一块也是深色
const fakeQr = (n = 21) => ({
  getModuleCount: () => n,
  isDark: (y: number, x: number) => x === y || (y === Math.floor(n / 2) && x === Math.floor(n / 2)) || (x < 7 && y < 7),
  addData: vi.fn(), make: vi.fn(),
});

vi.mock("../lib/vendor", () => ({ loadQrcode: async () => () => fakeQr() }));

describe("二维码 SVG", () => {
  it("中间留给橙光球不画点；三个定位角用橙色，其余深色圆点", () => {
    const svg = renderQr(fakeQr());
    expect(svg.startsWith('<svg viewBox="0 0 21 21"')).toBe(true);
    expect(svg).toContain('fill="#c24f1c"');
    expect(svg).toContain('fill="#201b15"');
    // 中心 (10,10) 在留空区里：没有 x=10.06 y=10.06 的方块
    expect(svg).not.toContain('x="10.06" y="10.06"');
    // 左上角 (0,0) 是定位角：圆角 .2
    expect(svg).toContain('x="0.06" y="0.06" width=".88" height=".88" rx="0.2" fill="#c24f1c"');
  });
});

describe("在手机上打开", () => {
  let stop: () => void;
  let lan: { status: number; body: unknown };
  beforeEach(() => {
    toasts.value = []; ready.value = false; urls.value = []; picked.value = ""; qrSvg.value = "";
    lan = { status: 200, body: { urls: ["http://10.0.0.2:8080", "http://10.0.0.3:8080"] } };
    me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
    history.replaceState(null, "", "/s/abc");
    stopRouter(); startRouter();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(lan.body), { status: lan.status })));
    stop = startMobileSync();
  });
  afterEach(() => { stop(); stopRouter(); vi.unstubAllGlobals(); });

  it("进入 /mobile：取地址、默认选第一个、画出二维码；可以换地址", async () => {
    replace("/mobile", { force: true });
    await wait();
    expect(ready.value).toBe(true);
    expect(urls.value.length).toBe(2);
    expect(picked.value).toBe("http://10.0.0.2:8080");
    expect(qrSvg.value).toContain("<svg");
    pick("http://10.0.0.3:8080");
    expect(picked.value).toBe("http://10.0.0.3:8080");
  });
  it("没有局域网地址：用当前地址", async () => {
    lan.body = { urls: [] };
    replace("/mobile", { force: true });
    await wait();
    expect(urls.value).toEqual([location.origin]);
  });
  it("取地址失败：提示错误并关掉（和老代码一样不打开）", async () => {
    lan = { status: 500, body: { detail: "没有网络" } };
    replace("/mobile", { force: true });
    await wait();
    expect(toasts.value.some((t) => t.kind === "err" && t.text === "没有网络")).toBe(true);
    expect(location.pathname).toBe("/s/abc");
    expect(ready.value).toBe(false);
  });
});
