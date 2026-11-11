import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replace, startRouter, stopRouter } from "../router";
import { me } from "./auth";
import {
  dirPath, entries, filesRoute, fromUrlPath, kbRelOf, resetFiles, sel, startFilesSync, toUrlPath,
} from "./files";

const entry = (name: string, path: string, dir = false) => ({ name, dir, size: 3, mtime: 1, path, abs: "/r/" + path });
const reply = (path: string, ents: ReturnType<typeof entry>[], select: string | null = null) => ({
  path, abs: "/r/" + path, crumbs: [{ label: "文件库", path: "" }], select, entries: ents, office: false, writable: true, roots: ["/r", "/w"],
});
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("文件库网址", () => {
  it("公共文件库根目录（空串）在网址里写成 /，来回转换", () => {
    expect(toUrlPath("")).toBe("/");
    expect(fromUrlPath("/")).toBe("");
    expect(fromUrlPath("ws:周报")).toBe("ws:周报");
    expect(filesRoute(null)).toEqual({ name: "files" });
    expect(filesRoute("")).toEqual({ name: "files", path: "/" });
  });
  it("知识库笔记判断", () => {
    expect(kbRelOf("/kb", "/kb/经验/a.md")).toBe("经验/a.md");
    expect(kbRelOf("C:\\kb\\", "c:\\KB\\x.md")).toBe("x.md");
    expect(kbRelOf("/kb", "/kb/a.txt")).toBeNull();
    expect(kbRelOf("/kb", "/other/a.md")).toBeNull();
    expect(kbRelOf(undefined, "/kb/a.md")).toBeNull();
  });
});

describe("文件库跟着网址走", () => {
  let stop: () => void;
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
    resetFiles();
    history.replaceState(null, "", "/");
    stopRouter(); startRouter();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(decodeURIComponent(url));
      const u = decodeURIComponent(url);
      let body: unknown = {};
      if (u.startsWith("/api/files?path=ws:周报/a.md")) body = reply("ws:周报", [entry("a.md", "ws:周报/a.md"), entry("b.md", "ws:周报/b.md")], "ws:周报/a.md");
      else if (u.startsWith("/api/files?path=ws:周报")) body = reply("ws:周报", [entry("a.md", "ws:周报/a.md"), entry("b.md", "ws:周报/b.md")]);
      else if (u.startsWith("/api/files/text")) body = { text: "# 你好", truncated: false };
      else if (u.startsWith("/api/files?path=")) body = reply("ws:", [entry("周报", "ws:周报", true)]);
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    stop = startFilesSync();
  });
  afterEach(() => { stop(); stopRouter(); vi.unstubAllGlobals(); });

  it("/files 默认读“我的文件”，并把网址补成规范的 ?path=", async () => {
    replace("/files", { force: true });
    await wait();
    expect(dirPath.value).toBe("ws:");
    expect(location.search).toBe("?path=ws%3A");
  });
  it("网址上是文件：列出所在目录并预览它；换成目录再收起预览；列表里已有的文件不重读目录", async () => {
    replace("/files?path=ws%3A%E5%91%A8%E6%8A%A5%2Fa.md", { force: true });
    await wait();
    expect(dirPath.value).toBe("ws:周报");
    expect(sel.value?.name).toBe("a.md");
    const n = calls.filter((c) => c.startsWith("/api/files?")).length;
    replace("/files?path=ws%3A%E5%91%A8%E6%8A%A5", { force: true });
    await wait();
    expect(sel.value).toBeNull();
    replace("/files?path=ws%3A%E5%91%A8%E6%8A%A5%2Fb.md", { force: true });
    await wait();
    expect(sel.value?.name).toBe("b.md");
    expect(calls.filter((c) => c.startsWith("/api/files?")).length).toBe(n);
    expect(entries.value.length).toBe(2);
  });
  it("离开文件库后再进来，一律重新读", async () => {
    replace("/files?path=ws%3A%E5%91%A8%E6%8A%A5", { force: true });
    await wait();
    replace("/", { force: true });
    await wait();
    const n = calls.length;
    replace("/files?path=ws%3A%E5%91%A8%E6%8A%A5", { force: true });
    await wait();
    expect(calls.length).toBeGreaterThan(n);
  });
});
