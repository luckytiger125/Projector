import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loc, replace, startRouter, stopRouter, navigate } from "../router";
import { me } from "./auth";
import { startOverlaySync } from "./overlays";
import { closeDialog } from "./ui";

// 假的老弹层：管理后台的盒子和老代码挂在 window 上的入口
function setup() {
  document.body.innerHTML = '<div id="adminBox" class="overlay"></div>';
  const w = window as any;
  w.openAdmin = vi.fn(() => document.getElementById("adminBox")!.classList.add("show"));
  return w;
}
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let stop: () => void;
beforeEach(() => {
  me.value = { id: 1, username: "u", display_name: "U", role: "admin", avatar: "orange" };
  closeDialog();
  history.replaceState(null, "", "/s/abc");
  stopRouter(); startRouter();
});
afterEach(() => { stop?.(); stopRouter(); });

describe("路由 ↔ 老弹层", () => {
  it("老代码自己打开的弹层，网址跟上而且只打开一次", async () => {
    const w = setup(); stop = startOverlaySync();
    document.getElementById("adminBox")!.classList.add("show");   // 比如后台自己打开
    await wait();
    expect(location.pathname).toBe("/admin/users");
    expect(w.openAdmin).not.toHaveBeenCalled();
    expect(loc.value.state.bg).toBe("/s/abc");
  });

  it("文件库、知识库是组件，不归老弹层同步管：/files /kb 不会去开老弹层", async () => {
    const w = setup(); stop = startOverlaySync();
    navigate("/files");
    await wait();
    expect(location.pathname).toBe("/files");
    navigate("/kb/graph");
    await wait();
    expect(location.pathname).toBe("/kb/graph");
    expect(w.openAdmin).not.toHaveBeenCalled();
  });

  it("技能、用量、手机二维码是组件，不归老弹层同步管：/skills /usage /mobile 不会去开老弹层", async () => {
    const w = setup(); stop = startOverlaySync();
    for (const p of ["/skills", "/skills/x", "/usage", "/mobile"]) {
      navigate(p);
      await wait();
      expect(location.pathname + "").toBe(p);
    }
    expect(w.openAdmin).not.toHaveBeenCalled();
  });

  it("从老弹层里打开技能详情（管理后台技能库的“版本记录”）：后台收起，后退回到后台", async () => {
    setup(); stop = startOverlaySync();
    navigate("/admin/library");
    await wait();
    expect(document.getElementById("adminBox")!.classList.contains("show")).toBe(true);
    navigate("/skills/x");
    await wait();
    expect(document.getElementById("adminBox")!.classList.contains("show")).toBe(false);
    expect(location.pathname).toBe("/skills/x");
    expect(loc.value.state.bg).toBe("/s/abc");
  });

  it("后退键关掉弹层：老弹层跟着关", async () => {
    setup(); stop = startOverlaySync();
    navigate("/admin/users");
    await wait();
    expect(document.getElementById("adminBox")!.classList.contains("show")).toBe(true);
    const popped = new Promise<void>((res) => window.addEventListener("popstate", () => res(), { once: true }));
    history.back();
    await popped; await wait();
    expect(document.getElementById("adminBox")!.classList.contains("show")).toBe(false);
    expect(location.pathname).toBe("/s/abc");
  });

  it("非管理员打开 /admin/*：回到首页", async () => {
    const w = setup(); stop = startOverlaySync();
    me.value = { id: 2, username: "v", display_name: "V", role: "user", avatar: "orange" };
    replace("/admin/users", { force: true });
    await wait();
    expect(w.openAdmin).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/");
  });
});
