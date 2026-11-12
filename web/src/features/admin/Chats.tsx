// 聊天记录页签：按用户分组折叠的所有会话；点开一个会话，右边（手机上是下一级）看完整的消息和过程。
// 别人的会话只能看，不能接着聊；待确认的操作可以代为处理，Claude 提问也可以代为回答（和老代码里打开别人会话的行为一致）。
import { Icon } from "../../lib/icons";
import { ftime, sessStatus } from "../../lib/format";
import { allSessions, closeChat, openChat, openGroups, toggleGroup, users } from "../../stores/admin";
import { currentSess } from "../../stores/chat";
import { roleName } from "./roles";
import { AskPanel } from "../chat/Composer";
import { MessageList } from "../chat/Messages";
import { questions } from "../../stores/chat";
import { Ava } from "./parts";

function Row({ s, on }: { s: { id: string; title: string; updated: number; status?: string; pending?: unknown; running?: unknown; claude_session?: unknown; message_count?: unknown }; on: boolean }) {
  const [label, cls] = sessStatus(s);
  return (
    <button class={"ad-sess" + (on ? " on" : "")} type="button" title={s.title} onClick={() => openChat(s.id)}>
      <span class="tm">{ftime(s.updated)}</span>
      <span class="ti">{s.title}</span>
      <span class="st"><span class={"dot " + cls} />{label}</span>
    </button>
  );
}

export function ChatsList({ sid }: { sid?: string }) {
  const all = allSessions.value;
  const groups = users.value.map((u) => ({ u, list: all.filter((s) => s.user_id === u.id) })).sort((a, b) => b.list.length - a.list.length);
  const open = openGroups.value;
  return (
    <>
      <p class="note-hint">点开会话可以查看完整聊天记录和过程；别人的会话只能看，不能接着聊。</p>
      {groups.map((g) => {
        const on = open.includes(g.u.id);
        return (
          <div key={g.u.id} class={"ad-grp" + (on ? " open" : "")}>
            <button class="ad-grp-h" type="button" aria-expanded={on} onClick={() => toggleGroup(g.u.id)}>
              <Ava id={g.u.avatar} size={34} />
              <span class="ad-grp-t">
                <b>{g.u.display_name}</b>
                <span class="ad-un">
                  {roleName[g.u.role] || g.u.role} · {g.list.length} 个会话
                  {g.list.some((s) => s.running) ? <> · <span class="ad-run">有任务在进行</span></> : null}
                  {g.list.some((s) => s.pending) ? <> · <span class="ad-wait">有待确认</span></> : null}
                </span>
              </span>
              <Icon name="chevD" size={18} />
            </button>
            {on && (
              <div class="ad-grp-b">
                {g.list.length ? g.list.map((s) => <Row key={s.id} s={s} on={s.id === sid} />) : <div class="empty ad-nosess">没有会话</div>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** 右边：这个会话的完整消息。数据在 chat store（和对话页同一套），事件实时更新 */
export function ChatView({ sid }: { sid: string }) {
  const s = currentSess.value;
  const ready = s && s.id === sid;
  return (
    <>
      <div class="ad-chat-h">
        <button class="icon-btn ad-chat-x" type="button" title="关闭" aria-label="关闭" onClick={closeChat}><Icon name="x" size={16} /></button>
        <div class="ad-chat-t">
          <b>{ready ? s.title : ""}</b>
          {ready && <span class="ad-un"><Ava id={s.owner_avatar || "orange"} size={18} />{s.owner} · {sessStatus(s)[0]}</span>}
        </div>
      </div>
      {ready && <div class="banner view"><Icon name="eye" size={16} />你在查看 <b>{s.owner}</b> 的会话，只能看。待确认的操作可以代为处理。</div>}
      <MessageList />
      {questions.value.length > 0 && <div class="composer"><div class="col"><AskPanel /></div></div>}
    </>
  );
}
