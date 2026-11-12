import { describe, expect, it } from "vitest";
import { eventSessionId, isCoveredBySnapshot, sessionEventSkips } from "./seq";
import type { ServerEvent } from "./types";

const delta = (seq: number | undefined, sid = "a"): ServerEvent => ({ type: "delta", session_id: sid, text: "x", seq });

describe("eventSessionId", () => {
  it("按 session_id、approval、question、session 的顺序取", () => {
    expect(eventSessionId({ type: "delta", session_id: "s1" })).toBe("s1");
    expect(eventSessionId({ type: "approval", approval: { id: "1", session_id: "s2", summary: "" } })).toBe("s2");
    expect(eventSessionId({ type: "question", question: { id: "1", session_id: "s3", questions: [] } })).toBe("s3");
    expect(eventSessionId({ type: "session", session: { id: "s4" } as any })).toBe("s4");
    expect(eventSessionId({ type: "approval_done", id: "1" })).toBeUndefined();
  });
});

describe("isCoveredBySnapshot（非 session 事件的去重）", () => {
  it("seq 小于等于快照序号：丢掉", () => {
    expect(isCoveredBySnapshot(delta(10), "a", 10)).toBe(true);
    expect(isCoveredBySnapshot(delta(9), "a", 10)).toBe(true);
  });
  it("seq 比快照新：保留", () => {
    expect(isCoveredBySnapshot(delta(11), "a", 10)).toBe(false);
  });
  it("不是当前会话的事件不在这里判断", () => {
    expect(isCoveredBySnapshot(delta(5, "b"), "a", 10)).toBe(false);
  });
  it("快照序号为 0（还没取到快照）时什么都不丢", () => {
    expect(isCoveredBySnapshot(delta(1), "a", 0)).toBe(false);
  });
  it("没有 seq 的事件不丢", () => {
    expect(isCoveredBySnapshot(delta(undefined), "a", 10)).toBe(false);
  });
  it("没有当前会话（新会话、值班板）时不丢", () => {
    expect(isCoveredBySnapshot(delta(1), null, 10)).toBe(false);
  });
  it("session 事件永远不在这里丢（走 upsertSession 的 stale 判断）", () => {
    const ev: ServerEvent = { type: "session", session: { id: "a" } as any, seq: 3 };
    expect(isCoveredBySnapshot(ev, "a", 10)).toBe(false);
  });
  it("approval / question 事件也按各自的会话 id 判断", () => {
    const ap: ServerEvent = { type: "approval", approval: { id: "1", session_id: "a", summary: "" }, seq: 4 };
    expect(isCoveredBySnapshot(ap, "a", 10)).toBe(true);
    const q: ServerEvent = { type: "question", question: { id: "1", session_id: "a", questions: [] }, seq: 12 };
    expect(isCoveredBySnapshot(q, "a", 10)).toBe(false);
  });
});

describe("sessionEventSkips", () => {
  const ev = (seq: number | undefined, sid = "a"): ServerEvent => ({ type: "session", session: { id: sid } as any, seq });
  it("列表快照比事件新：不覆盖列表项", () => {
    expect(sessionEventSkips(ev(5), "x", 0, 5).skipList).toBe(true);
    expect(sessionEventSkips(ev(6), "x", 0, 5).skipList).toBe(false);
  });
  it("当前会话且详情快照比事件新：不覆盖当前会话对象", () => {
    expect(sessionEventSkips(ev(5), "a", 7, 0).skipCurrent).toBe(true);
    expect(sessionEventSkips(ev(8), "a", 7, 0).skipCurrent).toBe(false);
    expect(sessionEventSkips(ev(5, "b"), "a", 7, 0).skipCurrent).toBe(false);
  });
  it("没有 seq 时两个都不跳过", () => {
    expect(sessionEventSkips(ev(undefined), "a", 7, 5)).toEqual({ skipList: false, skipCurrent: false });
  });
});
