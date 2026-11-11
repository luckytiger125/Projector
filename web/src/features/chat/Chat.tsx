// 对话页：头部（标题、元信息、完全放行、步骤记录、命令）、横幅、消息列表、输入区。
import { pickSessionSection } from "../account/dialogs";
import { avatarEl } from "../../lib/avatars";
import { baseName, sessStatus } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { navigate } from "../../router";
import { me } from "../../stores/auth";
import { current, currentSess, isMine, links, messages, questions, renameSession, setBypass } from "../../stores/chat";
import { workDir } from "../../stores/composer";
import { conn } from "../../stores/events";
import { showFiles } from "../../stores/files";
import { syncBack } from "../files/local";
import { sessionSectionName } from "../../stores/sessions";
import { confirmBox, paletteOpen, promptBox, toast } from "../../stores/ui";
import { isMac } from "../../lib/desktop";
import { Composer } from "./Composer";
import { MessageList } from "./Messages";

function ChatHead() {
  const s = currentSess.value;
  const mine = isMine.value;
  const u = me.value;
  const id = current.value;
  const [stLabel] = s ? sessStatus(s) : ["未开始", ""];
  const wd = s ? s.work_dir : workDir.value;
  const bypass = !!(s && s.bypass);
  const c = conn.value;
  const rename = async () => {
    if (!id || !mine) return;
    const t = await promptBox({ title: "会话名称", message: "改成什么名字？", value: s ? s.title : "" });
    if (t && t.trim()) renameSession(t)?.catch((e) => toast(e.message, "err"));
  };
  const toggleBypass = async (on: boolean, box: HTMLInputElement) => {
    if (on && !(await confirmBox({
      title: "完全放行", message: "打开后，本会话里 Claude 的所有操作（包括删除文件、运行命令）都不再询问，直接执行。确定吗？", ok: "确定", danger: true,
    }))) { box.checked = false; return; }
    try { await setBypass(on); } catch (e) { toast((e as Error).message, "err"); box.checked = bypass; }
  };
  return (
    <header class="chat-head">
      <div class="in">
        <div class="ttl">
          <div class="kicker"><span>记录</span></div>
          <h2 title="双击重命名" onDblClick={rename}>{s ? s.title : "新会话"}</h2>
        </div>
        <div class="tools">
          <button class="btn ghost sm" disabled={!id} onClick={() => id && navigate(`/s/${id}/steps`)}><Icon name="steps" size={14} />步骤记录</button>
          <button class="btn ghost sm" onClick={() => { paletteOpen.value = true; }}><Icon name="command" size={14} />命令 <kbd>{isMac() ? "⌘K" : "Ctrl K"}</kbd></button>
        </div>
      </div>
      <div class="chat-meta">
        <span>工作目录
          <b><button class="meta-link" type="button" disabled={!mine || !!(s && s.claude_session)} title={`${wd || "默认工作目录"}\n工作文件夹：Claude 在这个文件夹里干活。只能在会话开始前选`}
            onClick={() => showFiles(s ? (s.work_dir ?? "") : (workDir.value || ""), "workdir")}>
            <Icon name="folder" size={13} />{wd ? baseName(wd) : "默认工作目录"}</button></b></span>
        <span>分区
          <b><button class="meta-link" type="button" disabled={!s || !mine} onClick={() => pickSessionSection()}>
            {s ? (s.section_name || sessionSectionName(s.section_id)) : "—"}</button></b></span>
        <span>会话状态<b>{stLabel}</b></span>
        <span>消息<b class="mono">{s ? String(s.message_count ?? messages.value.length) : "—"}</b></span>
        <span>权限<b>{bypass ? "完全放行" : "标准 · 需确认"}</b></span>
        <span class="right">
          {s && !mine && <span class="owner"><span dangerouslySetInnerHTML={{ __html: avatarEl(s.owner_avatar || "orange", 18) }} /> {s.owner}</span>}
          {u && u.can_bypass && mine && (
            <label class={"switch bypass" + (bypass ? " on" : "")} title="打开后本会话的所有操作（包括删除、运行命令）都不再询问">
              <input type="checkbox" checked={bypass} disabled={!s} onChange={(e) => toggleBypass((e.target as HTMLInputElement).checked, e.target as HTMLInputElement)} />
              <i /><span>完全放行</span>
            </label>
          )}
          {c !== "idle" && <span style="display:inline-flex;align-items:center;gap:6px"><span class={"dot " + (c === "open" ? "run" : "queue")} />{c === "open" ? "已连接" : "重新连接中"}</span>}
        </span>
      </div>
    </header>
  );
}

function Banners() {
  const s = currentSess.value;
  const mine = isMine.value;
  const ls = links.value;
  return (
    <>
      {!mine && s && <div class="banner view"><Icon name="eye" size={16} />你在查看 <b>{s.owner}</b> 的会话，只能看。待确认的操作可以代为处理。</div>}
      {ls.length > 0 && s && (
        <div class="banner links">
          <Icon name="laptop" size={15} /><span>本机文件</span>
          {ls.map((l: any) => (
            <span key={l.id} class="lk">
              <span class="chip ref" title={l.abs} onClick={() => showFiles(l.path as string)}><Icon name="folder" size={12} /><span>{l.name}</span></span>
              {mine && <button class="btn sm" onClick={() => void syncBack(l.id)}><Icon name="sync" size={13} />查看改动 / 同步回本机</button>}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

export function Chat() {
  const asking = questions.value.length > 0;
  void asking;
  return (
    <section class="chat">
      <ChatHead />
      <Banners />
      <MessageList />
      <Composer />
    </section>
  );
}
