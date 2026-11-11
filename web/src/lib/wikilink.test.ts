import { describe, expect, it } from "vitest";
import { findNote, linkify, relOfKbPath, stripTitleHeading, wikiQueryAt } from "./wikilink";

const notes = [
  { path: "经验/周报汇总.md", title: "周报汇总的固定做法" },
  { path: "主题/客户A.md", title: "客户A" },
  { path: "文件卡片/合同.md", title: "采购合同" },
];

describe("双链 linkify（规则和老代码 kbLinkify 一致）", () => {
  it("服务端给了 links：有的是普通链接，null 是“还没写”，没给的当不知道", () => {
    const html = linkify("见 [[客户A]]、[[不存在]]、[[没问过]]", { 客户A: "主题/客户A.md", 不存在: null });
    expect(html).toContain('<a class="wl" data-kb="客户A" title="打开笔记">客户A</a>');
    expect(html).toContain('<a class="wl ghost" data-kb="不存在" title="还没有这条笔记，点击新建">不存在</a>');
    expect(html).toContain('<a class="wl" data-kb="没问过" title="打开笔记">没问过</a>');
  });
  it("没有 links 时用 find 现查；知识库还没加载（undefined）不算 ghost", () => {
    const find = (n: string) => findNote(notes, n)?.path ?? null;
    expect(linkify("[[客户A]] [[nope]]", undefined, find)).toContain('class="wl ghost" data-kb="nope"');
    expect(linkify("[[客户A]] [[nope]]", undefined, find)).not.toContain('ghost" data-kb="客户A"');
    expect(linkify("[[x]]", undefined, () => undefined)).not.toContain("ghost");
    expect(linkify("[[x]]")).not.toContain("ghost");
  });
  it("别名和小节：显示别名；没有别名显示“目标#小节”；目标只取方括号里第一段", () => {
    expect(linkify("[[客户A|甲方]]", {})).toContain(">甲方</a>");
    expect(linkify("[[客户A#报价]]", {})).toContain('data-kb="客户A"');
    expect(linkify("[[客户A#报价]]", {})).toContain(">客户A#报价</a>");
    expect(linkify("![[客户A]]", {})).toContain('data-kb="客户A"');
  });
  it("代码块和行内代码里的不处理", () => {
    expect(linkify("`[[a]]` 和\n```\n[[b]]\n```\n[[c]]", {})).toBe("`[[a]]` 和\n```\n[[b]]\n```\n" + linkify("[[c]]", {}));
    expect(linkify("`[[a]]`", {})).toBe("`[[a]]`");
  });
  it("目标和别名里的特殊字符会转义（不能把标签带进页面）", () => {
    const html = linkify('[[<img src=x onerror=alert(1)>|"a"]]', {});
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;a&quot;");
  });
  it("不合规的写法不处理：空目标、跨行、嵌套", () => {
    expect(linkify("[[]]", {})).toBe("[[]]");
    expect(linkify("[[a\nb]]", {})).toBe("[[a\nb]]");
    expect(linkify("[[a[b]]", {})).toBe("[[a[b]]");
  });
});

describe("findNote", () => {
  it("标题优先，不分大小写，忽略 .md 和反斜杠，路径最后一段也能认", () => {
    expect(findNote(notes, " 客户a ")?.path).toBe("主题/客户A.md");
    expect(findNote(notes, "主题\\客户A.md")?.path).toBe("主题/客户A.md");
    expect(findNote(notes, "文件卡片/合同")?.title).toBe("采购合同");
    expect(findNote(notes, "某目录/采购合同")?.path).toBe("文件卡片/合同.md");
    expect(findNote(notes, "没有")).toBeNull();
    expect(findNote(null, "x")).toBeNull();
  });
});

describe("relOfKbPath", () => {
  it("知识库里的 .md 变成相对路径，其余是 null", () => {
    expect(relOfKbPath("/kb", "/kb/经验/a.md")).toBe("经验/a.md");
    expect(relOfKbPath("C:\\kb\\", "c:\\KB\\x.md")).toBe("x.md");
    expect(relOfKbPath("/kb", "/kb/a.txt")).toBeNull();
    expect(relOfKbPath("/kb", "/kbx/a.md")).toBeNull();
    expect(relOfKbPath(undefined, "/kb/a.md")).toBeNull();
  });
});

describe("stripTitleHeading / wikiQueryAt", () => {
  it("开头和标题相同的一级标题去掉；标题里有正则符号也行", () => {
    expect(stripTitleHeading("# a.b (c)\n正文", "a.b (c)")).toBe("正文");
    expect(stripTitleHeading("# 别的\n正文", "标题")).toBe("# 别的\n正文");
  });
  it("光标前在写 [[ 时给出查询词和起点", () => {
    expect(wikiQueryAt("见 [[客")).toEqual({ query: "客", from: 4 });
    expect(wikiQueryAt("见 [[客]]")).toBeNull();
    expect(wikiQueryAt("[[a|b")).toBeNull();
  });
});
