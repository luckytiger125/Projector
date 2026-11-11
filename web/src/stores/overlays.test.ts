import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loc, replace, startRouter, stopRouter, navigate } from "../router";
import { me } from "./auth";
import { startOverlaySync } from "./overlays";
import { closeDialog, dialog, openDialog } from "./ui";

// 假的老弹层：三个盒子和老代码挂在 window 上的入口
function setup() {
  document.body.innerHTML = '<div id="filesBox" class="overlay"></div><div id="kbBox" class="overlay"></div><div id="adminBox" class="overlay"></div>';
  const w = window as any;
  w.legacy = {
    showFiles: vi.fn(() => document.getElementById("filesBox")!.classList.add("show")),
    openTrash: vi.fn(() => openDialog("回收站", "x")),
    openMySkills: vi.fn(() => openDialog("技能", "x")),
    openSkillDetail: vi.fn(), openUsage: vi.fn(() => openDialog("我的用量", "x")), showMobile: vi.fn(),
  };
  w.openKB = vi.fn(async () => { document.getElementById("kbBox")!.classList.add("show"); });
  w.openAdmin = vi.fn(() => document.getElementById("adminBox")!.classList.add("show"));
  w.kbBeforeClose = vi.fn(() => { document.getElementById("kbBox")!.classList.remove("show"); return true; });
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
  it("网址变成 /files：打开文件库；关掉文件库：网址退回背景", async () => {
    const w = setup(); stop = startOverlaySync();
    navigate("/files");
    await wait();
    expect(w.legacy.showFiles).toHaveBeenCalledTimes(1);
    expect(document.getElementById("filesBox")!.classList.contains("show")).toBe(true);
    // 老代码自己关掉（Esc、关闭按钮）
    document.getElementById("filesBox")!.classList.remove("show");
    await wait();
    await wait(50);
    expect(location.pathname).toBe("/s/abc");
  });

  it("老代码自己打开的弹层，网址跟上而且只打开一次", async () => {
    const w = setup(); stop = startOverlaySync();
    w.legacy.showFiles();   // 比如点了回复里的文件小标签
    await wait();
    expect(location.pathname).toBe("/files");
    expect(w.legacy.showFiles).toHaveBeenCalledTimes(1);
    expect(loc.value.state.bg).toBe("/s/abc");
  });

  it("对话框形式的弹层：/usage 打开，对话框被关掉后网址退回背景", async () => {
    const w = setup(); stop = startOverlaySync();
    navigate("/usage");
    await wait();
    expect(w.legacy.openUsage).toHaveBeenCalledTimes(1);
    expect(dialog.value?.title).toBe("我的用量");
    closeDialog();
    await wait(60);
    expect(location.pathname).toBe("/s/abc");
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

  it("知识库有未保存的编辑：离开前由老代码的确认框拦住", async () => {
    const w = setup(); stop = startOverlaySync();
    navigate("/kb");
    await wait();
    w.kbBeforeClose.mockImplementation(() => false);   // 用户在确认框里选了“不离开”
    expect(navigate("/s/zzz")).toBe(false);
    expect(location.pathname).toBe("/kb");
    w.kbBeforeClose.mockImplementation(() => { document.getElementById("kbBox")!.classList.remove("show"); return true; });
    expect(navigate("/s/zzz")).toBe(true);
    expect(location.pathname).toBe("/s/zzz");
  });
});
