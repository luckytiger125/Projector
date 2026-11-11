// 技能文件查看器（版本文件、管理员审核技能、技能库里查看文件都用）：左边文件列表，右边内容；
// changes 用来标出相对上一版新增、修改、删除的文件。放在通用对话框里显示。
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { fsize } from "../../lib/format";
import type { SkillChanges, SkillFile } from "../../stores/skills";
import type { DialogButton } from "../../stores/ui";
import { openDialog } from "../../stores/ui";

const SCRIPT_RE = /\.(py|sh|bat|cmd|ps1|js|ts|exe|dll)$/i;

export function SkillFiles({ files, changes, extra }: { files: SkillFile[]; changes?: SkillChanges | null; extra?: ComponentChildren }) {
  const firstChanged = changes ? files.findIndex((f) => changes.modified.includes(f.path) || changes.added.includes(f.path)) : -1;
  const first = firstChanged >= 0 ? firstChanged : files.findIndex((f) => f.path === "SKILL.md");
  const [i, setI] = useState(files.length ? (first >= 0 ? first : 0) : -1);
  const f = i >= 0 ? files[i] : null;
  const badge = (p: string) => !changes ? null
    : changes.added.includes(p) ? <span class="tag ok">新增</span>
    : changes.modified.includes(p) ? <span class="tag warn">修改</span> : null;
  return (
    <div class="skf">
      {extra}
      {changes && changes.removed.length > 0 && <div class="skf-removed">删除了：{changes.removed.join("、")}</div>}
      <div class="skf-box">
        <ul class="skf-list">
          {files.map((x, j) => (
            <li key={x.path} class={j === i ? "on" : ""}>
              <button type="button" onClick={() => setI(j)}>
                {badge(x.path)}
                {SCRIPT_RE.test(x.path) ? <span class="tag warn">脚本</span> : null}
                <span class="p">{x.path}</span>
                <span class="sz">{fsize(x.size)}</span>
              </button>
            </li>
          ))}
        </ul>
        <pre class="skf-pre">{!f ? "选左边的文件查看内容" : f.text == null ? `（二进制文件，${fsize(f.size)}，不能显示）` : f.text + (f.truncated ? "\n……（太长，已截断）" : "")}</pre>
      </div>
    </div>
  );
}

let opened = 0;

/** 在宽对话框里打开文件查看器；extra 可以是组件，也可以是一段 HTML（管理后台还在用老代码拼的说明） */
export function openSkillFiles(title: string, files: SkillFile[], buttons: DialogButton[] = [], extra?: ComponentChildren, changes?: SkillChanges | null): void {
  openDialog(title, <SkillFiles key={++opened} files={files} changes={changes} extra={extra} />, buttons, true);
}
