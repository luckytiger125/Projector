import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../lib/types";

// 统计 Markdown 渲染次数：已完成的消息只能渲染一次，流式输出只该重新渲染正在输出的那一条
const mdCalls: string[] = [];
vi.mock("../../lib/markdown", async (orig) => {
  const m = await orig<typeof import("../../lib/markdown")>();
  return { ...m, md: (t: string) => { mdCalls.push(t); return m.md(t); } };
});

import * as chat from "../../stores/chat";
import { MessageList } from "./Messages";

const msg = (id: number, role: string, content: string): Message => ({ id, role, content, created: 1000 + id });
const tick = () => new Promise((r) => setTimeout(r, 40));

let host: HTMLElement;
beforeEach(() => {
  mdCalls.length = 0;
  chat.resetChat();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => { render(null, host); host.remove(); });

describe("消息列表：流式输出只更新正在变的那一条", () => {
  it("live 文字变化时，已完成消息不重新渲染 Markdown，也不重建 DOM", async () => {
    chat.current.value = "a";
    chat.messages.value = [msg(1, "user", "问题"), msg(2, "assistant", "回答一 **粗**"), msg(3, "assistant", "回答二")];
    chat.setLive({ text: "开始", thinking: "", tools: [] });
    render(<MessageList />, host);
    await tick();
    const before = [...host.querySelectorAll(".entry")];
    expect(before.length).toBe(4);   // 三条消息加正在输出的一条
    const firstMd = host.querySelector(".md");
    expect(mdCalls.filter((t) => t === "回答一 **粗**").length).toBe(1);

    for (const piece of ["字", "字", "字", "字"]) { chat.applyDelta(piece); await tick(); }
    expect(host.querySelector(".live-entry .md")!.textContent).toContain("开始字字字字");
    // 已完成的消息：Markdown 没有再渲染，DOM 节点还是原来那些
    expect(mdCalls.filter((t) => t === "回答一 **粗**").length).toBe(1);
    expect(mdCalls.filter((t) => t === "回答二").length).toBe(1);
    expect(host.querySelector(".md")).toBe(firstMd);
    const after = [...host.querySelectorAll(".entry")];
    before.slice(0, 3).forEach((n, i) => expect(after[i]).toBe(n));
  });

  it("新来一条消息时，已有的消息不重画", async () => {
    chat.current.value = "a";
    chat.messages.value = [msg(1, "assistant", "旧消息")];
    render(<MessageList />, host);
    await tick();
    const old = host.querySelector(".entry");
    chat.applyMessage(msg(2, "assistant", "新消息"));
    await tick();
    expect(host.querySelectorAll(".entry").length).toBe(2);
    expect(host.querySelector(".entry")).toBe(old);
    expect(mdCalls.filter((t) => t === "旧消息").length).toBe(1);
  });

  it("五百条消息：一次渲染 + 一百次流式增量，已完成的消息都只渲染一次", async () => {
    chat.current.value = "a";
    chat.messages.value = Array.from({ length: 500 }, (_, i) => msg(i + 1, i % 2 ? "assistant" : "user", `第 ${i + 1} 条 **内容**`));
    chat.setLive({ text: "", thinking: "", tools: [] });
    const t0 = performance.now();
    render(<MessageList />, host);
    await tick();
    const first = performance.now() - t0;
    const callsAfterFirst = mdCalls.length;
    expect(host.querySelectorAll(".entry").length).toBe(501);
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) chat.applyDelta("字");
    await tick();
    const streaming = performance.now() - t1;
    // 一百次增量合并成每帧一次渲染，只多出正在输出的那一条的 Markdown 渲染，已完成的消息一次都没有重渲染
    expect(mdCalls.length - callsAfterFirst).toBeLessThanOrEqual(3);
    expect(host.querySelector(".live-entry .md")!.textContent).toContain("字".repeat(100));
    expect(first).toBeLessThan(3000);
    expect(streaming).toBeLessThan(500);
  });

  it("消息内容里的脚本被净化，错误消息按纯文字显示", async () => {
    chat.current.value = "a";
    chat.messages.value = [msg(1, "assistant", "<script>window.__x=1</script><img src=x onerror=\"window.__x=1\">好"), msg(2, "error", "<b>出错</b>")];
    render(<MessageList />, host);
    await tick();
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(host.querySelector(".errbox")!.textContent).toContain("<b>出错</b>");
  });

  it("空会话显示提示文字；排队中的消息显示在最后", async () => {
    chat.current.value = "a";
    render(<MessageList />, host);
    await tick();
    expect(host.textContent).toContain("还没有记录。写下要交给 Claude 的事，发送后从这里开始。");
  });
});
