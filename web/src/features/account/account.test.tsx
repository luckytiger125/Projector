import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { me, token } from "../../stores/auth";
import { current, currentSess } from "../../stores/chat";
import { sections } from "../../stores/sessions";
import { closeDialog, toasts } from "../../stores/ui";
import { DialogHost } from "../shell/Overlays";
import { changePassword, pickAvatar, pickSessionSection } from "./dialogs";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const calls: Array<{ url: string; method: string; body: any }> = [];
let host: HTMLElement;
let failPw = false;

beforeEach(() => {
  calls.length = 0; failPw = false; toasts.value = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  render(<DialogHost />, host);
  me.value = { id: 1, username: "u", display_name: "U", role: "user", avatar: "orange" };
  token.value = "tk";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method || "GET", body });
    if (url === "/api/me/password") return failPw ? new Response(JSON.stringify({ detail: "原密码不对" }), { status: 400 }) : new Response("{}", { status: 200 });
    if (url === "/api/me") return new Response(JSON.stringify({ avatar: body.avatar }), { status: 200 });
    if (url.startsWith("/api/sessions/")) return new Response(JSON.stringify({ id: "s1", title: "t", user_id: 1, created: 1, updated: 1, section_id: body.section_id }), { status: 200 });
    if (url === "/api/setup") return new Response(JSON.stringify({ needed: false }), { status: 200 });
    return new Response("{}", { status: 200 });
  }));
});
afterEach(() => { closeDialog(); render(null, host); host.remove(); vi.unstubAllGlobals(); });

const click = (el: Element | null) => (el as HTMLElement).click();
const input = (el: Element, v: string) => { (el as HTMLInputElement).value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };

describe("更换头像", () => {
  it("显示 16 个头像，当前的高亮；点一个就保存、提示、稍后关闭", async () => {
    pickAvatar();
    await tick();
    expect(host.querySelectorAll(".ac-ava").length).toBe(16);
    expect(host.querySelector(".ac-ava.on")!.textContent!.trim()).toBe("橙子");
    click(host.querySelectorAll(".ac-ava")[5]);   // 樱桃
    await tick();
    expect(calls[0]).toMatchObject({ url: "/api/me", method: "PATCH", body: { avatar: "cherry" } });
    expect(me.value?.avatar).toBe("cherry");
    expect(toasts.value.some((t) => t.text === "头像换成了樱桃" && t.kind === "ok")).toBe(true);
    await tick(300);
    expect(host.querySelector(".dlg")).toBeNull();
  });
});

describe("修改密码", () => {
  const open = async () => {
    changePassword();
    await tick();
    return [...host.querySelectorAll("input[type=password]")];
  };
  it("两次新密码不一样：不发请求，错误文案显示在对话框里", async () => {
    const [o, n1, n2] = await open();
    input(o, "old"); input(n1, "abcdef"); input(n2, "abcdeg");
    click(host.querySelector(".acts .btn.primary"));
    await tick();
    expect(host.querySelector(".err")!.textContent).toBe("两次新密码不一样");
    expect(calls.length).toBe(0);
  });
  it("服务端拒绝（原密码不对）：文案显示在对话框里，对话框不关", async () => {
    failPw = true;
    const [o, n1, n2] = await open();
    input(o, "x"); input(n1, "abcdef"); input(n2, "abcdef");
    click(host.querySelector(".acts .btn.primary"));
    await tick();
    expect(host.querySelector(".err")!.textContent).toBe("原密码不对");
    expect(host.querySelector(".dlg")).not.toBeNull();
    expect(token.value).toBe("tk");
  });
  it("成功：发出原密码和新密码，清掉令牌回到登录页，提示重新登录", async () => {
    const [o, n1, n2] = await open();
    input(o, "old"); input(n1, "abcdef"); input(n2, "abcdef");
    click(host.querySelector(".acts .btn.primary"));
    await tick(60);
    expect(calls[0]).toMatchObject({ url: "/api/me/password", method: "POST", body: { old: "old", new: "abcdef" } });
    expect(token.value).toBe("");
    expect(me.value).toBeNull();
    expect(toasts.value.some((t) => t.text === "密码已修改，请用新密码重新登录")).toBe(true);
    expect(host.querySelector(".dlg")).toBeNull();
  });
});

describe("会话分区", () => {
  const sess = (section_id: number) => ({ id: "s1", title: "t", user_id: 1, created: 1, updated: 1, section_id });
  beforeEach(() => {
    sections.value = [{ id: 1, name: "周报" }, { id: 2, name: "旧的", archived: true }];
    current.value = "s1";
  });
  it("选项：未分类、没下架的分区；当前分区已下架时多一项“（已下架）”；保存后更新会话", async () => {
    currentSess.value = sess(2) as any;
    pickSessionSection();
    await tick();
    const opts = [...host.querySelectorAll("option")].map((o) => o.textContent);
    expect(opts).toEqual(["未分类", "旧的（已下架）", "周报"]);
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("2");
    const sel = host.querySelector("select") as HTMLSelectElement;
    sel.value = "1"; sel.dispatchEvent(new Event("change", { bubbles: true }));
    click([...host.querySelectorAll(".acts .btn")].find((b) => b.textContent === "保存")!);
    await tick();
    expect(calls[0]).toMatchObject({ url: "/api/sessions/s1", method: "PATCH", body: { section_id: 1 } });
    expect(currentSess.value?.section_id).toBe(1);
  });
  it("别人的会话或没有会话：不打开", async () => {
    currentSess.value = { ...sess(0), user_id: 2 } as any;
    pickSessionSection();
    await tick();
    expect(host.querySelector(".dlg")).toBeNull();
  });
});
