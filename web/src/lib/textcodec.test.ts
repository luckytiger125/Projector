import { describe, expect, it } from "vitest";
import { cleanSnippet, decodeText, looksBinary } from "./textcodec";

describe("decodeText", () => {
  it("UTF-8 原样解，去掉 BOM", () => {
    const b = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("姓名,金额")]);
    expect(decodeText(b.buffer)).toBe("姓名,金额");
  });
  it("不是 UTF-8 的按 GBK 解", () => {
    const gbk = new Uint8Array([0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0x31]);   // “姓名,1”
    expect(decodeText(gbk.buffer)).toBe("姓名,1");
  });
});

describe("looksBinary", () => {
  it("正常文字不算", () => { expect(looksBinary("第一行\n\t第二行\r\n")).toBe(false); expect(looksBinary("")).toBe(false); });
  it("满是控制字符的算", () => { expect(looksBinary("\u0000\u0001\u0002ab\ufffd\ufffd")).toBe(true); });
});

describe("cleanSnippet", () => {
  it("去掉表格分隔行和竖线", () => {
    expect(cleanSnippet("| 科室 | 金额 | |---|---| | 办公室 | 12 |")).toBe("科室 金额 办公室 12");
  });
  it("普通文字不动", () => { expect(cleanSnippet("先核对名单，再合并")).toBe("先核对名单，再合并"); expect(cleanSnippet(undefined)).toBe(""); });
});
