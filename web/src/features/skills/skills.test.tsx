import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replace, startRouter, stopRouter } from "../../router";
import { me } from "../../stores/auth";
import { mySkills } from "../../stores/composer";
import { detail, detailName, resetSkills, submissions } from "../../stores/skills";
import { SkillFiles } from "./SkillFiles";
import { SkillsSheet } from "./Skills";

const tick = () => new Promise((r) => setTimeout(r, 30));
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
  resetSkills();
  history.replaceState(null, "", "/");
  stopRouter(); startRouter();
});
afterEach(() => { render(null, host); host.remove(); stopRouter(); });

const files = [
  { path: "README.txt", size: 12, text: "说明" },
  { path: "SKILL.md", size: 30, text: "# 技能" },
  { path: "scripts/clean.py", size: 40, text: "print(1)" },
  { path: "logo.png", size: 5000, text: null },
];

describe("技能文件查看器", () => {
  it("默认选 SKILL.md；脚本文件有“脚本”标记；二进制文件说明不能显示", async () => {
    render(<SkillFiles files={files} />, host);
    await tick();
    expect(host.querySelector(".skf-list li.on .p")!.textContent).toBe("SKILL.md");
    expect(host.querySelector(".skf-pre")!.textContent).toBe("# 技能");
    const rows = [...host.querySelectorAll(".skf-list li")];
    expect(rows[2].textContent).toContain("脚本");
    expect(rows[1].textContent).not.toContain("脚本");
    (rows[3].querySelector("button") as HTMLButtonElement).click();
    await tick();
    expect(host.querySelector(".skf-pre")!.textContent).toBe("（二进制文件，5 KB，不能显示）");
  });
  it("有改动记录：标出新增和修改，默认选第一个有改动的文件，列出被删除的文件", async () => {
    render(<SkillFiles files={files} changes={{ added: ["scripts/clean.py"], modified: ["README.txt"], removed: ["old.md", "b.md"] }} />, host);
    await tick();
    expect(host.querySelector(".skf-list li.on .p")!.textContent).toBe("README.txt");
    const rows = [...host.querySelectorAll(".skf-list li")];
    expect(rows[0].textContent).toContain("修改");
    expect(rows[2].textContent).toContain("新增");
    expect(host.querySelector(".skf-removed")!.textContent).toBe("删除了：old.md、b.md");
  });
  it("太长被截断的文件有提示", async () => {
    render(<SkillFiles files={[{ path: "SKILL.md", size: 9, text: "abc", truncated: true }]} />, host);
    await tick();
    expect(host.querySelector(".skf-pre")!.textContent).toBe("abc\n……（太长，已截断）");
  });
});

describe("技能弹层", () => {
  it("列表：我能用的技能、我的提交（只显示自己的，状态用中文）；点一行进详情，网址更新", async () => {
    mySkills.value = [{ name: "weekly", description: "周报", version: 3 }];
    submissions.value = [
      { id: "1", name: "a", description: "", status: "pending", submitted_by: 1, created: 1700000000, changelog: "第一版" },
      { id: "2", name: "b", description: "", status: "rejected", submitted_by: 1, created: 1700000000, note: "改名" },
      { id: "3", name: "别人的", description: "", status: "approved", submitted_by: 2, created: 1700000000 },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    replace("/skills", { force: true });
    render(<SkillsSheet />, host);
    await tick();
    expect(host.querySelector("h3")!.textContent).toBe("技能");
    expect(host.querySelectorAll(".sk-ledger")[0].querySelectorAll("tbody tr").length).toBe(1);
    const subs = [...host.querySelectorAll(".sk-subs tbody tr")].map((r) => r.textContent);
    expect(subs.length).toBe(2);
    expect(subs[0]).toContain("待审核");
    expect(subs[1]).toContain("未通过");
    expect(host.textContent).not.toContain("别人的");
    (host.querySelector(".sk-ledger tbody tr") as HTMLElement).click();
    expect(location.pathname).toBe("/skills/weekly");
    vi.unstubAllGlobals();
  });
  it("列表没有技能、没有提交：显示老文案", async () => {
    mySkills.value = []; submissions.value = [];
    replace("/skills", { force: true });
    render(<SkillsSheet />, host);
    await tick();
    expect(host.textContent).toContain("还没有，管理员分配后会出现在这里。");
    expect(host.textContent).toContain("还没有提交过。");
  });
  it("详情：版本记录里当前版本有“当前”标记；管理员才有“回滚到这个版本”", async () => {
    const d = {
      skill: { name: "weekly", description: "周报", version: 2 },
      versions: [{ version: 2, created: 1700000000, changelog: "改了", submitter: "小王", approver: "管理员" }, { version: 1, created: 1700000000 }],
      pending: [{ id: "p", changelog: "", created: 1, submitter: "小李" }],
    };
    detail.value = d; detailName.value = "weekly";
    replace("/skills/weekly", { force: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(d), { status: 200 })));
    render(<SkillsSheet />, host);
    await tick();
    const rows = [...host.querySelectorAll(".sk-vers tbody tr")];
    expect(rows[0].textContent).toContain("当前");
    expect(rows[1].textContent).toContain("没写更新说明");
    expect(host.textContent).toContain("有 1 个新版本在等管理员审核：小李「没写说明」");
    expect(host.textContent).not.toContain("回滚到这个版本");
    me.value = { id: 1, username: "u", display_name: "U", role: "admin", avatar: "orange" };
    await tick();
    expect(host.querySelectorAll('[title="回滚到这个版本"]').length).toBe(1);   // 只有不是当前的那一版
    vi.unstubAllGlobals();
  });
});
