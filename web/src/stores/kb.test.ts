import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate, replace, startRouter, stopRouter } from "../router";
import { me } from "./auth";
import {
  kbCount, kbData, kbDirty, kbEditing, kbGo, kbNote, kbResults, kbSection, kbSel, kbTab, kbToday, onSearchInput, resetKb, saveNote, sectionMatch, startEdit,
} from "./kb";
import { installKbClicks, kbLeaveGuard, syncKbRoute } from "./kbsync";
import { addLeaveGuard } from "../router";
import { effect } from "@preact/signals";
import { toasts } from "./ui";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const brief = (path: string, extra: Record<string, unknown> = {}) => ({
  path, title: path.replace(/\.md$/, "").split("/").pop(), type: "经验", tags: [], summary: "", status: "有效", source: "", mtime: 1,
  section: "", source_state: "", links: 0, backlinks: 0, words: 1, ...extra,
});
const HOME = {
  root: "/kb", notes: [brief("经验/a.md", { section: "周报" }), brief("经验/b.md")], tags: [], hubs: [], ghosts: [], recent: [], today_new: [],
};
const NOTE = (path: string) => ({
  note: { ...brief(path), body: "正文", contributors: [], aliases: [], abs: "/kb/" + path, source_abs: "" }, backlinks: [], links: {}, session: null, history: 1,
});

describe("知识库的纯状态", () => {
  beforeEach(() => { resetKb(); });
  it("分区匹配：空 = 全部，未分类 = 没有分区，其他按名字", () => {
    expect(sectionMatch({ section: "" }, "")).toBe(true);
    expect(sectionMatch({ section: "" }, "__uncategorized__")).toBe(true);
    expect(sectionMatch({ section: "周报" }, "__uncategorized__")).toBe(false);
    expect(sectionMatch({ section: "周报" }, "周报")).toBe(true);
    expect(sectionMatch({ section: "采购" }, "周报")).toBe(false);
  });
  it("左栏条数：当前分区里超过 1 条才显示", () => {
    kbData.value = HOME as any;
    expect(kbCount.value).toBe(2);
    kbSection.value = "周报";
    expect(kbCount.value).toBe(0);
  });
  it("今日知识库：优先用 today_new，没有就从 recent 里挑今天新建的", () => {
    kbData.value = { ...HOME, today_new: [{ path: "x.md" }] } as any;
    expect(kbToday.value.map((r) => r.path)).toEqual(["x.md"]);
    const now = Date.now() / 1000;
    kbData.value = { ...HOME, today_new: undefined, recent: [{ path: "n.md", created: now, note: "新建", exists: true }, { path: "o.md", created: now, note: "修改", exists: true }] } as any;
    expect(kbToday.value.map((r) => r.path)).toEqual(["n.md"]);
  });
});

describe("知识库跟着网址走", () => {
  let stop: () => void;
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  beforeEach(() => {
    calls.length = 0; toasts.value = []; resetKb();
    me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
    history.replaceState(null, "", "/");
    stopRouter(); startRouter();
    vi.stubGlobal("confirm", vi.fn(() => false));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = decodeURIComponent(url);
      const method = init?.method || "GET";
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      let status = 200; let body: unknown = {};
      if (u.startsWith("/api/sections")) body = [{ id: 1, name: "周报" }];
      else if (u.startsWith("/api/kb/note?path=")) body = NOTE(u.split("path=")[1]);
      else if (u.startsWith("/api/kb/search")) body = { results: [{ ...brief("经验/a.md"), snippet: "…" }] };
      else if (u === "/api/kb/note" && method === "PUT") body = { path: "经验/新的.md" };
      else if (u.startsWith("/api/kb")) body = HOME;
      return new Response(JSON.stringify(body), { status });
    }));
    stop = effect(syncKbRoute);
  });
  afterEach(() => { stop(); stopRouter(); vi.unstubAllGlobals(); });

  it("打开 /kb/notes?note=…：取数据和笔记；页签和当前笔记来自网址", async () => {
    replace("/kb/notes?note=经验/a.md", { force: true });
    await wait();
    expect(kbTab.value).toBe("notes");
    expect(kbSel.value).toBe("经验/a.md");
    expect(kbData.value?.notes.length).toBe(2);
    expect(kbNote.value?.note.path).toBe("经验/a.md");
  });

  it("页签间、笔记间切换用 replace，不堆历史；换页签不再取笔记", async () => {
    navigate("/kb");
    await wait();
    const len = history.length;
    kbGo("notes", "经验/b.md");
    await wait();
    kbGo("graph");
    await wait();
    expect(history.length).toBe(len);
    expect(location.pathname).toBe("/kb/graph");
    expect(kbNote.value).toBeNull();
  });

  it("离开知识库：编辑状态和笔记清掉", async () => {
    replace("/kb/notes?note=经验/a.md", { force: true });
    await wait();
    startEdit(kbNote.value);
    replace("/", { force: true });
    await wait();
    expect(kbEditing.value).toBeNull();
    expect(kbNote.value).toBeNull();
  });

  it("有没保存的编辑：切页签、换笔记、关闭、后退都先问；选不离开就留在原地", async () => {
    replace("/kb/notes?note=经验/a.md", { force: true });
    await wait();
    const off = addLeaveGuard(kbLeaveGuard);
    startEdit(kbNote.value);
    expect(kbGo("graph")).toBe(true);   // 没改过：不问
    expect(confirm).not.toHaveBeenCalled();
    replace("/kb/notes?note=经验/a.md", { force: true });
    await wait();
    startEdit(kbNote.value);
    kbDirty.value = true;
    expect(kbGo("home")).toBe(false);
    expect(confirm).toHaveBeenLastCalledWith("编辑的内容还没保存，确定离开吗？");
    expect(location.pathname).toBe("/kb/notes");
    expect(navigate("/s/zzz")).toBe(false);
    expect(confirm).toHaveBeenLastCalledWith("编辑的内容还没保存，确定关闭吗？");
    (confirm as any).mockImplementation(() => true);
    expect(kbGo("graph")).toBe(true);
    await wait();
    expect(kbEditing.value).toBeNull();
    expect(kbDirty.value).toBe(false);
    off();
  });

  it("搜索：停一下再搜，带上分区；搜到后切到笔记页签；清空退出搜索", async () => {
    navigate("/kb");
    await wait();
    kbSection.value = "周报";
    onSearchInput("周报");
    await wait(320);
    expect(calls.some((c) => c.url === "/api/kb/search?q=周报&section=周报")).toBe(true);
    expect(kbResults.value?.length).toBe(1);
    expect(kbTab.value).toBe("notes");
    onSearchInput("");
    await wait(320);
    expect(kbResults.value).toBeNull();
  });

  it("保存新笔记：PUT 带分区和 base_mtime=null，成功后打开保存后的笔记", async () => {
    navigate("/kb/notes");
    await wait();
    startEdit(null);
    await saveNote(null, { title: "新的", type: "经验", tags: ["x"], summary: "", body: "b", section: "周报", source: "" });
    await wait();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ path: "", title: "新的", type: "经验", tags: ["x"], base_mtime: null, section: "周报" });
    expect("source" in put.body).toBe(false);   // 没填原文件就不带这个字段（和老代码一样）
    expect(kbEditing.value).toBeNull();
    expect(kbSel.value).toBe("经验/新的.md");
  });

  it("全局点击：[[链接]] 和指向知识库笔记的路径走知识库，别的路径不管", async () => {
    kbData.value = HOME as any;
    const byName = vi.fn(), byPath = vi.fn();
    const off = installKbClicks(byName, byPath);
    const mk = (attr: string, v: string) => { const a = document.createElement("a"); a.setAttribute(attr, v); document.body.append(a); return a; };
    mk("data-kb", "客户A").click();
    mk("data-fpath", "/kb/经验/a.md").click();
    mk("data-fpath", "/files/x.md").click();
    off();
    expect(byName).toHaveBeenCalledWith("客户A");
    expect(byPath).toHaveBeenCalledWith("经验/a.md");
    expect(byPath).toHaveBeenCalledTimes(1);
  });
});
