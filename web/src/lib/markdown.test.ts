import { afterEach, describe, expect, it } from "vitest";
import { escapeHtml, md, sanitizeHtml, setMarkdownLinkify } from "./markdown";

const dom = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
};

afterEach(() => setMarkdownLinkify(null));

describe("md 净化", () => {
  it("普通 Markdown 正常渲染", () => {
    const d = dom(md("# 标题\n\n- a\n- b\n\n**粗** `code`"));
    expect(d.querySelector("h1")?.textContent).toBe("标题");
    expect(d.querySelectorAll("li").length).toBe(2);
    expect(d.querySelector("strong")?.textContent).toBe("粗");
    expect(d.querySelector("code")?.textContent).toBe("code");
  });
  it("去掉 <script>", () => {
    const html = md("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("hello");
  });
  it("去掉 onerror 等事件属性", () => {
    const d = dom(md('<img src="x" onerror="alert(1)">'));
    const img = d.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("onerror")).toBeNull();
    expect(md('<a href="#" onclick="alert(1)">x</a>')).not.toContain("onclick");
  });
  it("去掉 javascript: 链接（行内写法和 Markdown 链接写法）", () => {
    for (const src of ['<a href="javascript:alert(1)">x</a>', "[x](javascript:alert(1))", '<a href="JaVaScRiPt:alert(1)">x</a>']) {
      const a = dom(md(src)).querySelector("a");
      expect(a?.getAttribute("href") ?? "").not.toMatch(/javascript/i);
    }
  });
  it("去掉 <iframe>、<object>、<embed> 和 svg 里的脚本", () => {
    const html = md('<iframe src="//evil"></iframe><object data="x"></object><embed src="y"><svg onload="alert(1)"><script>1</script></svg>');
    expect(html).not.toMatch(/<iframe|<object|<embed|<script|onload/i);
  });
  it("去掉 <style>（防止回复里的 Markdown 注入全局样式）", () => {
    expect(md("<p>a</p><style>p{color:red}</style>")).not.toContain("<style");
    expect(md("<style>p{color:red}</style><p>a</p>")).not.toContain("<style");
    expect(sanitizeHtml("<p>a</p><style>p{color:red}</style>")).toBe("<p>a</p>");
  });
  it("保留普通的 http 链接和 class、data- 属性（知识库链接要用）", () => {
    const d = dom(md('[a](https://example.com) <a class="wl" data-kb="笔记">笔记</a>'));
    const links = d.querySelectorAll("a");
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[1].className).toBe("wl");
    expect(links[1].getAttribute("data-kb")).toBe("笔记");
  });
  it("空值得到空串", () => {
    expect(md("")).toBe("");
    expect(md(null)).toBe("");
    expect(md(undefined)).toBe("");
  });
});

describe("linkify 预处理", () => {
  it("先 linkify 再渲染，结果仍然要净化", () => {
    setMarkdownLinkify((t) => t.replace("[[x]]", '<a class="wl" data-kb="x" onclick="alert(1)">x</a>'));
    const html = md("see [[x]]");
    expect(html).toContain('data-kb="x"');
    expect(html).not.toContain("onclick");
  });
});

describe("sanitizeHtml / escapeHtml", () => {
  it("sanitizeHtml 去掉脚本", () => {
    expect(sanitizeHtml("<p>a</p><script>alert(1)</script>")).toBe("<p>a</p>");
  });
  it("escapeHtml 转义尖括号、与号和双引号", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});
