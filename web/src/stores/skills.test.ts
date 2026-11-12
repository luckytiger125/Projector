import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replace, startRouter, stopRouter } from "../router";
import { me } from "./auth";
import { mySkills } from "./composer";
import {
  detail, detailName, openDetail, openList, resetSkills, rollback, startSkillsSync, submissions, submitSkill, uploadDir, uploadZip,
} from "./skills";
import { toasts } from "./ui";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const DETAIL = { skill: { name: "weekly", description: "周报", version: 3 }, versions: [{ version: 3, created: 1 }], pending: [] };

describe("技能跟着网址走", () => {
  let stop: () => void;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  beforeEach(() => {
    calls.length = 0; toasts.value = [];
    me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
    resetSkills(); mySkills.value = [];
    history.replaceState(null, "", "/");
    stopRouter(); startRouter();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = decodeURIComponent(url);
      calls.push({ url: u, method: init?.method || "GET", body: init?.body });
      let status = 200; let body: unknown = {};
      if (u === "/api/skills/mine") body = [{ name: "weekly", description: "周报", version: 3 }];
      else if (u === "/api/skills/submissions" && (init?.method || "GET") === "GET") body = [{ id: "s1", name: "x", status: "pending", submitted_by: 1, created: 1 }];
      else if (u === "/api/skills/submissions") body = { id: "sub9" };
      else if (u === "/api/skills/weekly") body = DETAIL;
      else if (u.startsWith("/api/skills/nope")) { status = 404; body = { detail: "技能库里没有这个技能，或者没分配给你" }; }
      else if (u.endsWith("/rollback")) body = { ok: true, version: 4 };
      else if (u.endsWith("/submit")) body = { name: "weekly" };
      return new Response(JSON.stringify(body), { status });
    }));
    stop = startSkillsSync();
  });
  afterEach(() => { stop(); stopRouter(); vi.unstubAllGlobals(); });

  it("进入 /skills：取我能用的技能和我的提交", async () => {
    replace("/skills", { force: true });
    await wait();
    expect(mySkills.value.map((s) => s.name)).toEqual(["weekly"]);
    expect(submissions.value?.length).toBe(1);
    expect(detail.value).toBeNull();
  });

  it("进入 /skills/weekly：取详情；从列表点进详情用 replace，不堆历史；回列表同样", async () => {
    replace("/skills", { force: true });
    await wait();
    const len = history.length;
    openDetail("weekly");
    await wait();
    expect(location.pathname).toBe("/skills/weekly");
    expect(detailName.value).toBe("weekly");
    expect(detail.value?.skill.version).toBe(3);
    expect(history.length).toBe(len);
    openList();
    await wait();
    expect(location.pathname).toBe("/skills");
    expect(detail.value).toBeNull();
    expect(history.length).toBe(len);
  });

  it("详情取不到（没权限或没有这个技能）：提示错误并回到列表", async () => {
    replace("/skills/nope", { force: true });
    await wait();
    expect(toasts.value.some((t) => t.kind === "err" && t.text.includes("没分配给你"))).toBe(true);
    expect(location.pathname).toBe("/skills");
  });

  it("离开技能弹层后清掉详情；没登录不取", async () => {
    replace("/skills/weekly", { force: true });
    await wait();
    expect(detail.value).not.toBeNull();
    replace("/", { force: true });
    await wait();
    expect(detail.value).toBeNull();
    me.value = null;
    calls.length = 0;
    replace("/skills", { force: true });
    await wait();
    expect(calls.length).toBe(0);
  });

  it("提交：先建草稿、再上传、最后带更新说明提交", async () => {
    const f = new File(["zipdata"], "a.zip");
    const r = await submitSkill(uploadZip(f), "加了说明");
    expect(r.name).toBe("weekly");
    expect(calls.map((c) => c.method + " " + c.url)).toEqual([
      "POST /api/skills/submissions", "PUT /api/skills/submissions/sub9/zip", "POST /api/skills/submissions/sub9/submit",
    ]);
    expect(JSON.parse(calls[2].body as string)).toEqual({ changelog: "加了说明" });
  });

  it("上传文件夹：去掉最外层文件夹名，逐个文件上传", async () => {
    const mk = (rel: string) => Object.assign(new File(["x"], rel.split("/").pop()!), { webkitRelativePath: rel });
    await submitSkill(uploadDir([mk("my/SKILL.md"), mk("my/scripts/a.py")]), "");
    const puts = calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(puts).toEqual(["/api/skills/submissions/sub9/file?path=SKILL.md", "/api/skills/submissions/sub9/file?path=scripts/a.py"]);
  });

  it("回滚：提示新版本号并重新取详情", async () => {
    replace("/skills/weekly", { force: true });
    await wait();
    const v = await rollback("weekly", 1);
    await wait();
    expect(v).toBe(4);
    expect(toasts.value.some((t) => t.text === "已回滚，现在是 v4")).toBe(true);
    expect(calls.some((c) => c.url === "/api/admin/library/weekly/rollback" && JSON.parse(c.body as string).version === 1)).toBe(true);
    expect(calls.filter((c) => c.url === "/api/skills/weekly").length).toBe(2);
  });
});
