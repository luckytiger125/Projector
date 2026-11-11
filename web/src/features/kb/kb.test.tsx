import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replace, startRouter, stopRouter } from "../../router";
import { me } from "../../stores/auth";
import { kbData, kbNote, resetKb } from "../../stores/kb";
import { KbSheet } from "./Kb";

const tick = () => new Promise((r) => setTimeout(r, 30));
let host: HTMLElement;
const brief = (path: string, title: string, extra: Record<string, unknown> = {}) => ({
  path, title, type: "经验", tags: [], summary: "", status: "有效", source: "", mtime: 1, section: "", source_state: "", links: 0, backlinks: 0, words: 1, ...extra,
});
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};   // jsdom 没有
  host = document.createElement("div");
  document.body.appendChild(host);
  me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
  resetKb();
  history.replaceState(null, "", "/");
  stopRouter(); startRouter();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => { render(null, host); host.remove(); stopRouter(); vi.unstubAllGlobals(); });

describe("知识库界面", () => {
  it("三个页签，当前页签来自网址", async () => {
    kbData.value = { root: "/kb", notes: [brief("经验/a.md", "甲")], tags: [], hubs: [], ghosts: [], recent: [] } as any;
    replace("/kb/notes", { force: true });
    render(<KbSheet />, host);
    await tick();
    const tabs = [...host.querySelectorAll(".sheet-bar .tabs button")];
    expect(tabs.map((t) => t.textContent)).toEqual(["首页", "笔记", "关系图谱"]);
    expect(host.querySelector(".tabs .on")!.textContent).toBe("笔记");
  });

  it("笔记正文先净化再进页面：脚本和事件属性不会留下，[[链接]] 变成可点的标签（已有 / 还没写）", async () => {
    kbData.value = { root: "/kb", notes: [brief("经验/a.md", "甲")], tags: [], hubs: [], ghosts: [], recent: [] } as any;
    kbNote.value = {
      note: { ...brief("经验/a.md", "甲"), body: '正文 <img src=x onerror="window.__pwn=1"> <script>window.__pwn=2</script> [[乙]] [[没有的]]', contributors: [], aliases: [], abs: "/kb/经验/a.md", source_abs: "" },
      backlinks: [], links: { 乙: "经验/b.md", 没有的: null }, session: null, history: 0,
    };
    replace("/kb/notes?note=经验/a.md", { force: true });
    render(<KbSheet />, host);
    await tick();
    const body = host.querySelector(".kv-body")!;
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("img")?.getAttribute("onerror") ?? null).toBeNull();
    const wl = [...body.querySelectorAll("a.wl")];
    expect(wl.map((a) => a.className)).toEqual(["wl", "wl ghost"]);
    expect(wl[1].getAttribute("data-kb")).toBe("没有的");
    expect(host.querySelector(".backlinks")!.textContent).toContain("还没有别的笔记链接到这里");
    expect((window as any).__pwn).toBeUndefined();
  });
});
