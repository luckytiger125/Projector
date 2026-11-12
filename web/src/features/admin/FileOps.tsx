// 文件记录页签：谁在什么时候上传、改名、删除了什么（最近 300 条），回收站入口。
import { Icon } from "../../lib/icons";
import { ftime, shortPath } from "../../lib/format";
import { orb } from "../../lib/avatars";
import { fileOps, userOf } from "../../stores/admin";
import { openTrash } from "../../stores/files";
import { roots } from "../../stores/roots";
import { Ava } from "./parts";

const KIND: Record<string, string> = {
  上传: "ok", 覆盖上传: "warn", 新建文件夹: "ok", 改名: "warn", 删除: "red", 恢复: "ok", 彻底删除: "red",
  知识库新建: "ok", 知识库修改: "warn", 知识库改名: "warn", 知识库删除: "red",
};

export function FileOpsTab() {
  const ops = fileOps.value;
  return (
    <>
      <div class="ad-top">
        <p class="note-hint">在文件库里上传、新建、改名、删除、恢复的操作都会记在这里（最近 300 条）。删除的文件在回收站里保留 30 天。</p>
        <button class="btn sm" type="button" onClick={() => openTrash()}><Icon name="trash" size={14} />打开回收站</button>
      </div>
      {ops.length ? (
        <table class="ledger ad-ops">
          <thead><tr><th>时间</th><th>谁</th><th>操作</th><th>文件</th></tr></thead>
          <tbody>
            {ops.map((o, i) => (
              <tr key={i}>
                <td class="num" data-l="时间">{ftime(o.created)}</td>
                <td class="nmc"><div class="nm"><Ava id={userOf(o.user_id).avatar} size={24} /><span>{o.who || "—"}</span></div></td>
                <td data-l="操作"><span class={"tag " + (KIND[o.action] || "")}>{o.action}</span></td>
                <td class="ad-path" data-l="文件" title={o.path}>{shortPath(o.path, roots.value)}{o.detail ? <> <span class="ad-un">{o.detail}</span></> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div class="ad-none"><span dangerouslySetInnerHTML={{ __html: orb(48) }} /><p>还没有文件操作记录。</p></div>}
    </>
  );
}
