import { describe, expect, it } from "vitest";
import { linkifyPaths } from "./linkify";

describe("路径变小标签", () => {
  const roots = ["/data/files", "/data/ws"];
  it("文件库路径变成可点的小标签，标点不算进路径，文件名走 textContent", () => {
    const d = document.createElement("div");
    d.textContent = "见 /data/files/周报/a.md，和 /data/files/资料。";
    linkifyPaths(d, roots);
    const a = [...d.querySelectorAll("a.fchip")] as HTMLElement[];
    expect(a.map((x) => x.dataset.fpath)).toEqual(["/data/files/周报/a.md", "/data/files/资料"]);
    expect(a[0].textContent).toBe("a.md");
    expect(d.textContent).toContain("，和 ");
  });
  it("已经在链接或代码标签里的不处理；没有根目录什么都不做", () => {
    const d = document.createElement("div");
    d.innerHTML = '<a href="#">/data/files/x.md</a>';
    linkifyPaths(d, roots);
    expect(d.querySelectorAll("a.fchip").length).toBe(0);
    d.textContent = "/data/files/x.md";
    linkifyPaths(d, []);
    expect(d.querySelectorAll("a.fchip").length).toBe(0);
  });
});
