// 分区页签：新建、一键建常用分区、改名、下架 / 恢复。分区是分类，不是权限。
import { useState } from "preact/hooks";
import { Icon } from "../../lib/icons";
import { reloadSections, sectionCreate, sectionPatch, sections } from "../../stores/admin";
import type { AdminSection } from "../../stores/admin";
import { confirmBox, promptBox, toast } from "../../stores/ui";

const COMMON = ["合同", "采购", "报表", "人事", "综合事务", "其他"];

async function rename(s: AdminSection): Promise<void> {
  const name = await promptBox({ title: "新的分区名", value: s.name });
  if (!name || name === s.name) return;
  await new Promise((r) => setTimeout(r, 0));   // 输入框对话框关闭之后再开确认框，不然会被一起关掉
  if (!(await confirmBox({ title: "改名", message: `改名会同步更新 ${s.note_count ?? 0} 条笔记的 section 属性，确定吗？`, ok: "改名" }))) return;
  try { await sectionPatch(s.id, { name: name.trim() }); toast("已改名", "ok"); } catch (e) { toast((e as Error).message, "err"); }
}
async function archive(s: AdminSection): Promise<void> {
  if (!(await confirmBox({ title: "下架", message: `下架“${s.name}”？老会话和老笔记仍显示原名，但新建时选不到。`, ok: "下架", danger: true }))) return;
  try { await sectionPatch(s.id, { archived: 1 }); toast("已下架", "ok"); } catch (e) { toast((e as Error).message, "err"); }
}
async function restore(s: AdminSection): Promise<void> {
  try { await sectionPatch(s.id, { archived: 0 }); toast("已恢复", "ok"); } catch (e) { toast((e as Error).message, "err"); }
}

export function SectionsTab() {
  const [name, setName] = useState("");
  const add = async () => {
    const n = name.trim();
    if (!n) { toast("请写分区名", "err"); return; }
    try { await sectionCreate(n); toast("已新建分区", "ok"); setName(""); void reloadSections(); }
    catch (e) { toast((e as Error).message, "err"); }
  };
  const seed = async () => {
    let ok = 0, skip = 0, need = 0;
    for (const n of COMMON) {
      try { await sectionCreate(n); ok++; }
      catch (e) {
        const m = (e as Error).message;
        if (/已归档|恢复/.test(m)) need++;
        else if (/已经|存在|重名/.test(m)) skip++;
        else toast(`${n}：${m}`, "err");
      }
    }
    toast(`建成 ${ok} 个，跳过 ${skip} 个，${need} 个需先恢复`, "ok", 4000);
    void reloadSections();
  };
  const list = sections.value;
  return (
    <>
      <div class="ad-box">
        <h4 class="ad-h"><Icon name="plus" size={16} />新建分区</h4>
        <div class="ad-form">
          <input class="input" placeholder="分区名，例如：合同" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.isComposing) void add(); }} />
          <button class="btn primary" type="button" onClick={() => void add()}>新建</button>
          <button class="btn" type="button" onClick={() => void seed()}>一键建常用分区</button>
        </div>
        <p class="note-hint ad-tight">分区是分类，不是权限；归档后同名分区需要先恢复。</p>
      </div>
      <table class="ledger ad-secs">
        <thead><tr><th>分区</th><th>会话</th><th>笔记</th><th>状态</th><th /></tr></thead>
        <tbody>
          {list.length ? list.map((s) => (
            <tr key={s.id}>
              <td class="nmc"><div class="nm"><span>{s.name}</span></div></td>
              <td class="num" data-l="会话">{s.session_count ?? "—"}</td>
              <td class="num" data-l="笔记">{s.note_count ?? "—"}</td>
              <td data-l="状态">{s.archived ? "已下架" : "使用中"}</td>
              <td class="r">
                <button class="btn ghost sm" type="button" onClick={() => void rename(s)}>改名</button>
                {s.archived
                  ? <button class="btn ghost sm" type="button" onClick={() => void restore(s)}>恢复</button>
                  : <button class="btn ghost sm" type="button" onClick={() => void archive(s)}>下架</button>}
              </td>
            </tr>
          )) : <tr><td colSpan={5} class="ctr">还没有分区</td></tr>}
        </tbody>
      </table>
    </>
  );
}
