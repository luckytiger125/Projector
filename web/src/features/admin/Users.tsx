// 用户页签：统计、新建账号、用户表（改名、角色、完全放行、停用、重置密码、删除）、各人占用空间。
import { useState } from "preact/hooks";
import { fsize, ftime } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { me } from "../../stores/auth";
import { allSessions, createUser, deleteUser, patchUser, submissions, users, workspaceUsage } from "../../stores/admin";
import type { AdminUser } from "../../stores/admin";
import { confirmBox, promptBox } from "../../stores/ui";
import { Ava, Count } from "./parts";

function NewUser() {
  const [name, setName] = useState("");
  const [disp, setDisp] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const go = async () => {
    try { await createUser(name.trim(), disp.trim(), pwd); setErr(""); setName(""); setDisp(""); setPwd(""); }
    catch (e) { setErr((e as Error).message); }
  };
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.isComposing) void go(); };
  return (
    <div class="ad-box">
      <h4 class="ad-h"><Icon name="plus" size={16} />新建账号</h4>
      <div class="ad-form">
        <input class="input" placeholder="用户名（登录用）" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={key} />
        <input class="input" placeholder="显示的名字" value={disp} onInput={(e) => setDisp((e.target as HTMLInputElement).value)} onKeyDown={key} />
        <input class="input" placeholder="初始密码（至少 6 位）" value={pwd} onInput={(e) => setPwd((e.target as HTMLInputElement).value)} onKeyDown={key} />
        <button class="btn primary" type="button" onClick={() => void go()}>创建</button>
      </div>
      <div class="ad-err">{err}</div>
      <p class="note-hint ad-tight">同事只能登录、不能注册。把用户名和初始密码告诉他们，登录后可以自己改密码、换头像。</p>
    </div>
  );
}

async function rename(u: AdminUser): Promise<void> {
  const n = await promptBox({ title: "显示的名字", value: u.display_name });
  if (n) void patchUser(u.id, { display_name: n });
}
async function reset(u: AdminUser): Promise<void> {
  const p = await promptBox({ title: "重置密码", message: `给 ${u.display_name} 设一个新密码（至少 6 位），他会被要求重新登录：`, ok: "重置密码" });
  if (p) void patchUser(u.id, { password: p }, "密码已重置");
}
async function remove(u: AdminUser): Promise<void> {
  const ok = await confirmBox({
    title: "删除", message: `删除 ${u.display_name}？他的所有会话、聊天记录和工作区文件都会删除，不能恢复。\n只是不让他用的话，打开“停用”就行。`, ok: "删除", danger: true,
  });
  if (ok) void deleteUser(u.id);
}

function Row({ u, i }: { u: AdminUser; i: number }) {
  const self = u.id === me.value?.id;
  return (
    <tr style={`animation-delay:${i * 30}ms`}>
      <td class="nmc">
        <div class="nm">
          <Ava id={u.avatar} size={34} />
          <span class="ad-who">
            <button class="ad-link" type="button" onClick={() => void rename(u)}>{u.display_name}</button>
            <span class="ad-un">@{u.username}</span>
          </span>
        </div>
      </td>
      <td data-l="角色">
        <select class="sel" value={u.role} onChange={(e) => void patchUser(u.id, { role: (e.target as HTMLSelectElement).value })}>
          <option value="user">普通用户</option><option value="admin">管理员</option>
        </select>
      </td>
      <td data-l="完全放行">
        {u.role === "user"
          ? <label class="switch bypass"><input type="checkbox" checked={!!u.can_bypass}
              onChange={(e) => { const on = (e.target as HTMLInputElement).checked; void patchUser(u.id, { can_bypass: on }, on ? "已开通完全放行" : "已关闭完全放行"); }} /><i /></label>
          : u.role === "admin" ? <span class="ad-ok"><Icon name="check" size={16} /></span> : "—"}
      </td>
      <td class="num" data-l="会话">{u.sessions}</td>
      <td class="num" data-l="最近登录">{u.last_seen ? ftime(u.last_seen) : "—"}</td>
      <td data-l="状态">
        <label class="switch bypass"><input type="checkbox" checked={!!u.disabled}
          onChange={(e) => { const on = (e.target as HTMLInputElement).checked; void patchUser(u.id, { disabled: on }, on ? "已停用" : "已启用"); }} /><i />停用</label>
      </td>
      <td class="r">
        <button class="btn ghost sm" type="button" onClick={() => void reset(u)}><Icon name="key" size={14} />重置密码</button>
        {!self && <button class="btn ghost sm ad-danger" type="button" title="删除" aria-label="删除" onClick={() => void remove(u)}><Icon name="trash" size={14} /></button>}
      </td>
    </tr>
  );
}

export function UsersTab() {
  const list = users.value;
  const all = allSessions.value;
  const today = new Date(new Date().toDateString()).getTime() / 1000;
  const stats: Array<[string, string, number]> = [
    ["users", "账号", list.length],
    ["chat", "今天的会话", all.filter((s) => s.updated >= today).length],
    ["bolt", "正在干活", all.filter((s) => s.running).length],
    ["puzzle", "待审核技能", submissions.value.filter((s) => s.status === "pending").length],
  ];
  const wu = workspaceUsage.value;
  return (
    <>
      <div class="ad-stats">
        {stats.map(([ic, l, v]) => (
          <div key={l} class="ad-stat"><Icon name={ic} size={18} /><div class="v"><Count to={v} /></div><div class="l">{l}</div></div>
        ))}
      </div>
      <NewUser />
      <table class="ledger ad-users">
        <thead><tr><th>用户</th><th>角色</th><th title="允许打开“完全放行”">完全放行</th><th>会话</th><th>最近登录</th><th>状态</th><th /></tr></thead>
        <tbody>{list.map((u, i) => <Row key={u.id} u={u} i={i} />)}</tbody>
      </table>
      {wu && (
        <>
          <h4 class="sk-h"><Icon name="folder" size={16} />工作区占用空间</h4>
          <p class="note-hint">个人文件只有本人能看，这里只显示占用空间，不显示文件名和内容。</p>
          <table class="ledger ad-ws">
            <thead><tr><th>用户</th><th>占用空间</th><th>文件数</th></tr></thead>
            <tbody>
              {wu.users.map((x) => (
                <tr key={x.username}>
                  <td class="nmc"><div class="nm"><span>{x.display_name} <span class="ad-un">@{x.username}</span></span></div></td>
                  <td class="num" data-l="占用空间">{fsize(x.size)}</td>
                  <td class="num" data-l="文件数">{x.files}</td>
                </tr>
              ))}
              <tr>
                <td class="nmc"><div class="nm"><span class="ad-un">回收站（合计）</span></div></td>
                <td class="num" data-l="占用空间">{fsize(wu.trash.size)}</td>
                <td class="num" data-l="文件数">{wu.trash.files}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
