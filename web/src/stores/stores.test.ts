import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Question, Session } from "../lib/types";
import { me } from "./auth";
import * as chat from "./chat";
import { addRef, refs, removeRef, resetComposer, skill } from "./composer";
import { currentSection, filtered, groupSessions, groups, query, sectionMatch, sectionName, sections, sessionSectionName, sessions, upsertInList } from "./sessions";
import { cycleTheme, theme, toast, toasts } from "./ui";

const s = (id: string, updated: number, over: Partial<Session> = {}): Session => ({ id, title: "会话" + id, user_id: 1, created: 1, updated, ...over }) as Session;

describe("会话分组", () => {
  const now = new Date(2026, 10, 11, 15, 0);
  const day = new Date(2026, 10, 11).getTime() / 1000;
  it("今天 / 昨天 / 7 天内 / 更早，一个会话只出现一次，空组不出现", () => {
    const list = [s("a", day + 100), s("b", day - 100), s("c", day - 3 * 86400), s("d", day - 6 * 86400), s("e", day - 7 * 86400)];
    const g = groupSessions(list, now);
    expect(g.map((x) => x.name)).toEqual(["今天", "昨天", "7 天内", "更早"]);
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([["a"], ["b"], ["c", "d"], ["e"]]);
    expect(groupSessions([s("a", day + 5)], now).map((x) => x.name)).toEqual(["今天"]);
    expect(groupSessions([], now)).toEqual([]);
  });
});

describe("会话列表 store", () => {
  beforeEach(() => {
    me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
    sessions.value = []; sections.value = []; currentSection.value = null; query.value = "";
  });
  it("upsertInList：置顶并按 updated 倒序，替换同 id，忽略别人的", () => {
    upsertInList(s("a", 100)); upsertInList(s("b", 200)); upsertInList(s("a", 300, { title: "改了" }));
    upsertInList(s("x", 999, { user_id: 2 }));
    expect(sessions.value.map((x) => x.id)).toEqual(["a", "b"]);
    expect(sessions.value[0].title).toBe("改了");
  });
  it("分区匹配：null 全部，0 未分类，其他按 id", () => {
    expect(sectionMatch(5, null)).toBe(true);
    expect(sectionMatch(null, 0)).toBe(true);
    expect(sectionMatch(0, 0)).toBe(true);
    expect(sectionMatch(5, 0)).toBe(false);
    expect(sectionMatch("5", 5)).toBe(true);
    expect(sectionMatch(6, 5)).toBe(false);
  });
  it("分区名", () => {
    sections.value = [{ id: 3, name: "财务" }];
    expect(sectionName(null)).toBe("全部");
    expect(sectionName(0)).toBe("未分类");
    expect(sectionName(3)).toBe("财务");
    expect(sectionName(9)).toBe("未分类");
    expect(sessionSectionName(null)).toBe("未分类");
    expect(sessionSectionName(3)).toBe("财务");
  });
  it("filtered / groups：按分区和搜索词过滤，搜索不分大小写", () => {
    sessions.value = [s("a", 100, { title: "Alpha", section_id: 3 }), s("b", 90, { title: "beta" })];
    expect(filtered.value.length).toBe(2);
    currentSection.value = 3;
    expect(filtered.value.map((x) => x.id)).toEqual(["a"]);
    currentSection.value = null;
    query.value = " ALP ";
    expect(filtered.value.map((x) => x.id)).toEqual(["a"]);
    expect(groups.value.length).toBe(1);
  });
});

describe("输入区 store", () => {
  it("addRef 按 abs 去重；removeRef；resetComposer 清引用和技能", () => {
    addRef({ abs: "/a", name: "a" }); addRef({ abs: "/a", name: "a" }); addRef({ abs: "/b", name: "b", dir: true });
    expect(refs.value.map((r) => r.abs)).toEqual(["/a", "/b"]);
    expect(refs.value[1].dir).toBe(true);
    removeRef(0);
    expect(refs.value.map((r) => r.abs)).toEqual(["/b"]);
    skill.value = "周报";
    resetComposer();
    expect(refs.value).toEqual([]);
    expect(skill.value).toBe("");
  });
});

describe("提问面板的作答状态", () => {
  const q: Question = {
    id: "q1", session_id: "a",
    questions: [
      { question: "单选", options: [{ label: "甲（推荐）" }, { label: "乙" }] },
      { question: "多选", multi_select: true, options: [{ label: "丙" }, { label: "丁" }] },
    ],
  };
  beforeEach(() => {
    chat.resetChat();
    chat.askState.value = {};
    chat.questions.value = [q];
    vi.useFakeTimers();
  });

  it("单选：选中清掉“其他”，非最后一题 260ms 后自动下一题", () => {
    chat.askSetOther("自己写");
    expect(chat.askOf(q).ans[0].other).toBe("自己写");
    chat.askPick(1);
    expect(chat.askOf(q).ans[0]).toMatchObject({ selected: ["乙"], other: "" });
    expect(chat.askOf(q).step).toBe(0);
    vi.advanceTimersByTime(259);
    expect(chat.askOf(q).step).toBe(0);
    vi.advanceTimersByTime(1);
    expect(chat.askOf(q).step).toBe(1);
  });

  it("单选：写“其他”会清掉已选的选项", () => {
    chat.askPick(0);
    chat.askSetOther("别的");
    expect(chat.askOf(q).ans[0].selected).toEqual([]);
  });

  it("多选：切换选项；写“其他”不清掉已选；最后一题不自动前进", () => {
    chat.askSetStep(1);
    chat.askPick(0); chat.askPick(1); chat.askPick(0);
    expect(chat.askOf(q).ans[1].selected).toEqual(["丁"]);
    chat.askSetOther("补充");
    expect(chat.askOf(q).ans[1].selected).toEqual(["丁"]);
    vi.advanceTimersByTime(1000);
    expect(chat.askOf(q).step).toBe(1);
  });

  it("超出范围的选项编号忽略；自动下一题前问题已经没了就不动", () => {
    chat.askPick(9);
    expect(chat.askOf(q).ans[0].selected).toEqual([]);
    chat.askPick(0);
    chat.questions.value = [];
    vi.advanceTimersByTime(300);
    expect(chat.askOf(q).step).toBe(0);
  });

  it("isAnswered", () => {
    expect(chat.isAnswered({ selected: [], other: "  " })).toBe(false);
    expect(chat.isAnswered({ selected: [], other: "x" })).toBe(true);
    expect(chat.isAnswered({ selected: ["a"], other: "" })).toBe(true);
  });

  it("提交：带上整理后的答案，成功后移除问题和作答状态", async () => {
    vi.useRealTimers();
    chat.askSetNote(" 注意 ");
    chat.askPick(0);
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response("{}", { status: 200 }); }));
    expect(await chat.askSubmit(false)).toBe(true);
    expect(body.skipped).toBe(false);
    expect(body.answers[0]).toEqual({ selected: ["甲（推荐）"], other: "", note: "注意" });
    expect(chat.questions.value).toEqual([]);
    expect(chat.askState.value).toEqual({});
    vi.unstubAllGlobals();
  });

  it("提交失败：弹错误提示，问题保留", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "已被处理" }), { status: 400 })));
    expect(await chat.askSubmit(true)).toBe(false);
    expect(chat.questions.value.length).toBe(1);
    expect(toasts.value.at(-1)).toMatchObject({ text: "已被处理", kind: "err" });
    vi.unstubAllGlobals();
  });
});

describe("加载更早的消息", () => {
  const m = (id: number) => ({ id, role: "assistant", content: "", created: 1 });
  beforeEach(() => { chat.resetChat(); chat.current.value = "a"; chat.messages.value = [m(5), m(6)]; chat.hasMore.value = true; });

  it("并入前面，按 id 去掉重复，beforeApply 在替换前调用", async () => {
    let seenLen = -1;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("/api/sessions/a/messages?before=5&limit=100");
      return new Response(JSON.stringify({ messages: [m(3), m(4), m(5)], has_more: false }), { status: 200 });
    }));
    expect(await chat.loadOlder(() => { seenLen = chat.messages.value.length; })).toBe(true);
    expect(seenLen).toBe(2);
    expect(chat.messages.value.map((x) => x.id)).toEqual([3, 4, 5, 6]);
    expect(chat.hasMore.value).toBe(false);
    expect(chat.olderState.value).toBe("");
    vi.unstubAllGlobals();
  });

  it("失败：状态变 failed，不抛错；再次点击可重试", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    expect(await chat.loadOlder()).toBe(false);
    expect(chat.olderState.value).toBe("failed");
    vi.unstubAllGlobals();
  });

  it("期间切了会话：这一页作废", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      chat.current.value = "b";
      return new Response(JSON.stringify({ messages: [m(3)], has_more: false }), { status: 200 });
    }));
    expect(await chat.loadOlder()).toBe(false);
    expect(chat.messages.value.map((x) => x.id)).toEqual([5, 6]);
    vi.unstubAllGlobals();
  });

  it("没有更多或正在加载时不发请求", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    chat.hasMore.value = false;
    expect(await chat.loadOlder()).toBe(false);
    chat.hasMore.value = true; chat.olderState.value = "loading";
    expect(await chat.loadOlder()).toBe(false);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("提示条和主题", () => {
  it("toast：显示、淡出、移除", () => {
    vi.useFakeTimers();
    toasts.value = [];
    toast("hi", "ok", 1000);
    expect(toasts.value).toMatchObject([{ text: "hi", kind: "ok", phase: "in" }]);
    vi.advanceTimersByTime(1000);
    expect(toasts.value[0].phase).toBe("out");
    vi.advanceTimersByTime(400);
    expect(toasts.value).toEqual([]);
    vi.useRealTimers();
  });
  it("cycleTheme：自动 → 浅色 → 深色 → 自动，写 localStorage 和 <html data-theme>", () => {
    localStorage.removeItem("theme");
    expect(cycleTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(cycleTheme()).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(cycleTheme()).toBe("auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(theme.value).toBe("auto");
  });
});
