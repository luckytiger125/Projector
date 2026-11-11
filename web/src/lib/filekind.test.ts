import { describe, expect, it } from "vitest";
import { kindOf } from "./filekind";

describe("文件类型", () => {
  it("按扩展名归类，不区分大小写", () => {
    expect(kindOf("a.PNG")).toBe("image");
    expect(kindOf("周报.md")).toBe("md");
    expect(kindOf("x.docx")).toBe("docx");
    expect(kindOf("老.xls")).toBe("sheet");
    expect(kindOf("a.csv")).toBe("sheet");
    expect(kindOf("a.pptx")).toBe("office");
    expect(kindOf("a.bin")).toBe("other");
    expect(kindOf("没有扩展名")).toBe("other");
  });
});
