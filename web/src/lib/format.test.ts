import { describe, expect, it } from "vitest";
import {
  baseName, fdate, fmtCost, fmtDuration, fmtTok, fsize, ftime, greeting, hm, rel, sessStatus, shortPath, toolMeta,
} from "./format";

// 本地时间 → 秒级时间戳
const ts = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;

describe("fsize", () => {
  it("按量级换单位", () => {
    expect(fsize(0)).toBe("0 B");
    expect(fsize(1023)).toBe("1023 B");
    expect(fsize(1024)).toBe("1 KB");
    expect(fsize(1536)).toBe("2 KB");
    expect(fsize(1048576)).toBe("1.0 MB");
    expect(fsize(5.5 * 1048576)).toBe("5.5 MB");
    expect(fsize(2 * 1073741824)).toBe("2.0 GB");
  });
});

describe("时间", () => {
  it("fdate / ftime / hm", () => {
    const t = ts(2026, 3, 5, 9, 7);
    expect(fdate(t)).toBe("2026-03-05");
    expect(ftime(t)).toBe("2026-03-05 09:07");
    expect(hm(t)).toBe("09:07");
  });
  it("rel：今天显示时分，昨天，N 天前，更早显示月/日", () => {
    const now = new Date(2026, 10, 11, 15, 0);
    expect(rel(ts(2026, 11, 11, 8, 5), now)).toBe("08:05");
    expect(rel(ts(2026, 11, 10, 23, 59), now)).toBe("昨天");
    expect(rel(ts(2026, 11, 8, 12, 0), now)).toBe("3 天前");
    expect(rel(ts(2026, 11, 5, 12, 0), now)).toBe("6 天前");
    expect(rel(ts(2026, 11, 4, 12, 0), now)).toBe("11/4");
    expect(rel(ts(2025, 1, 2, 12, 0), now)).toBe("1/2");
  });
  it("greeting 按小时", () => {
    const at = (h: number) => greeting(new Date(2026, 0, 1, h));
    expect([at(3), at(5), at(10), at(11), at(12), at(13), at(17), at(18), at(23)])
      .toEqual(["夜深了", "早上好", "早上好", "中午好", "中午好", "下午好", "下午好", "晚上好", "晚上好"]);
  });
});

describe("路径", () => {
  it("baseName 兼容两种分隔符，空路径返回原值", () => {
    expect(baseName("D:\\a\\b\\c.txt")).toBe("c.txt");
    expect(baseName("/a/b/c/")).toBe("c");
    expect(baseName("")).toBe("");
  });
  it("shortPath：文件库、工作区缩写，工作区去掉用户和会话两层", () => {
    const roots = ["D:\\Lib", "D:\\Lib\\ws"];
    expect(shortPath("D:\\Lib\\报告\\a.md", roots)).toBe("文件库/报告/a.md");
    expect(shortPath("d:\\lib\\ws\\u1\\s1\\out\\a.md", roots)).toBe("工作区/out/a.md");
    expect(shortPath("E:\\other\\a.md", roots)).toBe("E:\\other\\a.md");
    expect(shortPath(undefined, roots)).toBeUndefined();
    expect(shortPath("/a/b", [])).toBe("/a/b");
  });
});

describe("其他格式化", () => {
  it("fmtDuration", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(undefined)).toBe("—");
    expect(fmtDuration("x")).toBe("—");
    expect(fmtDuration(-5)).toBe("0s");
    expect(fmtDuration(42)).toBe("42s");
    expect(fmtDuration(90)).toBe("2m");
    expect(fmtDuration(3600)).toBe("1h");
    expect(fmtDuration(3600 + 15 * 60)).toBe("1h 15m");
  });
  it("fmtCost / fmtTok", () => {
    expect(fmtCost(null)).toBe("未采集费用");
    expect(fmtCost(0)).toBe("0（估算）");
    expect(fmtCost(0.12345)).toBe("$0.1235（估算）");
    expect(fmtTok(null)).toBe("—");
    expect(fmtTok(1234567)).toBe("1,234,567");
  });
  it("toolMeta：已知工具、未知工具去掉 mcp 前缀", () => {
    expect(toolMeta("Bash")).toEqual(["运行命令", "terminal"]);
    expect(toolMeta("mcp__center__foo")).toEqual(["foo", "bolt"]);
    expect(toolMeta("Weird")).toEqual(["Weird", "bolt"]);
  });
  it("sessStatus", () => {
    expect(sessStatus({ status: "running" })).toEqual(["进行中", "run"]);
    expect(sessStatus({ status: "idle" })).toEqual(["未开始", "off"]);   // idle 不在映射里，走后面的兜底
    expect(sessStatus({ pending: 1 })).toEqual(["待确认", "wait"]);
    expect(sessStatus({ running: true })).toEqual(["进行中", "run"]);
    expect(sessStatus({ claude_session: "x", message_count: 2 })).toEqual(["已完成", "done"]);
    expect(sessStatus(null)).toEqual(["已完成", "done"]);   // 老代码：没有会话对象时落到最后的兜底
  });
});
