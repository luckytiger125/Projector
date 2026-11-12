// 技能库页签：台式机本机的 skill（导入技能库）、库里的技能（分配给谁、版本记录、查看文件、删除）。
import { Icon } from "../../lib/icons";
import { ftime } from "../../lib/format";
import { orb } from "../../lib/avatars";
import { navigate } from "../../router";
import { importLocal, library, loadLibraryFiles, localSkills, removeFromLibrary, saveAccess, users } from "../../stores/admin";
import type { LibrarySkill } from "../../stores/admin";
import { confirmBox, toast } from "../../stores/ui";
import { openSkillFiles } from "../skills/SkillFiles";
import { Ava } from "./parts";

async function viewFiles(name: string): Promise<void> {
  try { const d = await loadLibraryFiles(name); openSkillFiles(`技能 ${name} 的文件`, d.files); }
  catch (e) { toast((e as Error).message, "err"); }
}

async function remove(name: string): Promise<void> {
  if (!(await confirmBox({ title: "从库里删除", message: `从技能库删除 ${name}？所有人都不能再用它。`, ok: "从库里删除", danger: true }))) return;
  try { await removeFromLibrary(name); } catch (e) { toast((e as Error).message, "err"); }
}

function Card({ s }: { s: LibrarySkill }) {
  const people = users.value.filter((u) => u.role !== "admin");
  const setEveryone = (on: boolean) => void saveAccess(s.name, on, s.users);
  const setUser = (id: number, on: boolean) => void saveAccess(s.name, s.everyone, on ? [...new Set([...s.users, id])] : s.users.filter((x) => x !== id));
  return (
    <div class="ad-card">
      <h4 class="ad-h">
        <Icon name="puzzle" size={16} />{s.name} <span class="vtag">v{s.version || 1}</span>
        {s.pending ? <span class="tag warn">{s.pending} 个新版本待审核</span> : null}
      </h4>
      <div class="ad-desc">{s.description}</div>
      <div class="ad-meta">提交人：{s.submitter || "—"} · 更新：{ftime(s.updated)}</div>
      <div class="ad-pick">
        <label class="ad-upick all"><input type="checkbox" checked={!!s.everyone} onChange={(e) => setEveryone((e.target as HTMLInputElement).checked)} />所有人可用</label>
        {people.map((u) => (
          <label key={u.id} class="ad-upick">
            <input type="checkbox" checked={s.users.includes(u.id)} disabled={!!s.everyone} onChange={(e) => setUser(u.id, (e.target as HTMLInputElement).checked)} />
            <Ava id={u.avatar} size={22} />{u.display_name}
          </label>
        ))}
      </div>
      <div class="ad-acts">
        <button class="btn sm" type="button" onClick={() => navigate("/skills/" + encodeURIComponent(s.name))}><Icon name="history" size={14} />版本记录</button>
        <button class="btn sm" type="button" onClick={() => void viewFiles(s.name)}><Icon name="eye" size={14} />查看文件</button>
        <button class="btn ghost sm ad-danger" type="button" onClick={() => void remove(s.name)}><Icon name="trash" size={14} />从库里删除</button>
        <span class="ad-aside">管理员默认都能用</span>
      </div>
    </div>
  );
}

export function LibraryTab() {
  const lib = library.value;
  const local = localSkills.value;
  const localNew = local.skills.filter((s) => !s.in_library);
  return (
    <>
      {local.skills.length > 0 && (
        <div class="ad-card warn">
          <h4 class="ad-h"><Icon name="alert" size={16} />台式机本机还有 {local.skills.length} 个 skill</h4>
          <div class="ad-desc">位置：<code>{local.dir}</code>。这里的 skill 对<b>所有人</b>都生效，不受分配控制。建议导入技能库后，把这个文件夹里的移走。</div>
          <details class="ad-det">
            <summary>展开查看</summary>
            {local.skills.map((s) => (
              <div key={s.name} class="ad-local" title={s.description}>
                <b>{s.name}</b> {s.in_library ? <span class="tag ok">已在库里</span> : null} <span class="ad-un">{s.description}</span>
              </div>
            ))}
          </details>
          {localNew.length > 0 && (
            <button class="btn sm ad-imp" type="button" onClick={() => void importLocal(localNew.map((s) => s.name)).catch((e) => toast(e.message, "err"))}>
              <Icon name="download" size={14} />把 {localNew.length} 个导入技能库
            </button>
          )}
        </div>
      )}
      {lib.length === 0 && (
        <div class="ad-none"><span dangerouslySetInnerHTML={{ __html: orb(56) }} /><p>技能库是空的。同事提交的 skill 审核通过后会出现在这里。</p></div>
      )}
      {lib.map((s) => <Card key={s.name} s={s} />)}
    </>
  );
}
