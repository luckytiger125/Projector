// 外壳：竖栏、手机页签、值班目录（新会话、搜索、分区、入口、会话列表、用户卡片和菜单）。
import { useRef, useState } from "preact/hooks";
import { changePassword, pickAvatar } from "../account/dialogs";
import { avatarEl } from "../../lib/avatars";
import { isMac } from "../../lib/desktop";
import { hm, pad, sessStatus } from "../../lib/format";
import { useOutsideClick } from "../../lib/hooks";
import { Icon } from "../../lib/icons";
import type { Session } from "../../lib/types";
import { back, mainRoute, navigate, route } from "../../router";
import { isAdmin, logout, me } from "../../stores/auth";
import { current, deleteSession } from "../../stores/chat";
import { resetComposer } from "../../stores/composer";
import { lastKbPath, kbCount } from "../../stores/kb";
import {
  currentSection, groups, query, sections, selectSection, sectionName, todayCount,
} from "../../stores/sessions";
import { THEMES, confirmBox, cycleTheme, paletteOpen, theme, toast } from "../../stores/ui";
import { loc } from "../../router";


// ---------- 竖栏（手机上是顶栏） ----------
export function Rail({ level2 }: { level2: boolean }) {
  const goBack = () => {
    const st = loc.value.state;
    if (st.app && st.idx > 0) back(); else navigate("/");
  };
  return (
    <aside class="rail">
      {level2 && <button class="icon-btn m-only" title="返回" aria-label="返回" onClick={goBack}><Icon name="chevL" size={20} /></button>}
      <span class="seal">值</span>
      <span class="vert">综合部工作台</span>
      <span class="yr">PROJECTOR · {new Date().getFullYear()}</span>
      <button class="icon-btn m-only" title="搜索" aria-label="搜索" onClick={() => { paletteOpen.value = true; }}><Icon name="search" size={20} /></button>
    </aside>
  );
}

/** 手机第一级：值班目录 / 值班板 */
export function MobileTabs() {
  const board = route.value.name === "board";
  return (
    <nav class="m-tabs">
      <a class={board ? "" : "on"} onClick={() => navigate("/", { force: true })}>值班目录</a>
      <a class={board ? "on" : ""} onClick={() => navigate("/board", { force: true })}>值班板</a>
    </nav>
  );
}

// ---------- 分区选择 ----------
function SectionBar() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(open, (t) => !!ref.current?.contains(t), () => setOpen(false));
  const cur = currentSection.value;
  const item = (value: number | null, name: string, count?: unknown) => (
    <button type="button" class={String(cur ?? "") === String(value ?? "") ? "on" : ""}
      onClick={() => { setOpen(false); void selectSection(value).catch((e) => toast(e.message, "err")); }}>
      <span>{name}</span>{count != null && count !== "" ? <small>{String(count)}</small> : null}
    </button>
  );
  return (
    <div class="sec-bar" ref={ref}>
      <button class="sec-btn" type="button" onClick={() => setOpen(!open)}>分区 · <b>{sectionName(cur)}</b></button>
      {open && (
        <div class="sec-pop">
          {item(null, "全部")}
          {item(0, "未分类")}
          {sections.value.filter((s) => !s.archived).map((s) => item(s.id, s.name, s.session_count))}
        </div>
      )}
    </div>
  );
}

// ---------- 会话行 ----------
function dotOf(s: Session): string {
  const [, cls] = sessStatus(s);
  if (cls === "run") return "run";
  if (cls === "wait") return "wait";
  if (s.status === "queued") return "queue";
  return "";
}

function SessRow({ s }: { s: Session }) {
  const [label] = sessStatus(s);
  const del = async (e: Event) => {
    e.stopPropagation();
    if (!(await confirmBox({ title: "删除", message: "删除这个会话、聊天记录和上传到工作区的文件？", ok: "删除", danger: true }))) return;
    deleteSession(s.id).catch((err) => toast(err.message, "err"));
  };
  return (
    <div class={"row" + (s.id === current.value ? " on" : "") + (s.pending ? " unread" : "")} title={`${s.title}（${label}）`}
      onClick={() => navigate("/s/" + s.id)}>
      <span class={"dot " + dotOf(s)} aria-label={label} />
      <span class="t">{s.title}</span>
      <span class="tm">{hm(s.updated)}</span>
      <span class="acts"><button class="icon-btn" title="删除" aria-label="删除" onClick={del}><Icon name="trash" size={14} /></button></span>
    </div>
  );
}

// ---------- 用户菜单 ----------
function UserMenu({ close }: { close: () => void }) {
  const u = me.value!;
  const th = THEMES[theme.value];
  const go = (fn: () => void) => () => { close(); fn(); };
  return (
    <div class="user-menu" onClick={(e) => e.stopPropagation()}>
      <button onClick={go(() => pickAvatar())}><Icon name="user" size={16} />更换头像</button>
      <button onClick={go(() => navigate("/skills"))}><Icon name="puzzle" size={16} />我的技能</button>
      <button onClick={go(() => navigate("/usage"))}><Icon name="steps" size={16} />我的用量</button>
      <button onClick={go(() => navigate("/mobile"))}><Icon name="phone" size={16} />在手机上打开</button>
      {u.role === "admin" && <button onClick={go(() => navigate("/admin/users"))}><Icon name="shield" size={16} />管理后台</button>}
      <hr />
      <button onClick={go(() => { cycleTheme(); })}><Icon name={th[1]} size={16} />主题：{th[0]}</button>
      <button onClick={go(() => changePassword())}><Icon name="key" size={16} />修改密码</button>
      <button onClick={go(async () => { if (await confirmBox({ title: "退出登录", message: "退出登录？", ok: "退出登录" })) await logout(); })}><Icon name="logout" size={16} />退出登录</button>
    </div>
  );
}

function UserCard() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(open, (t) => !!ref.current?.contains(t), () => setOpen(false));
  const u = me.value;
  if (!u) return null;
  return (
    <div class="side-foot" ref={ref} onClick={() => setOpen(!open)}>
      <span class="avatar" dangerouslySetInnerHTML={{ __html: avatarEl(u.avatar, 36) }} />
      <div style="flex:1;min-width:0">
        <div class="nm">{u.display_name}</div>
        <div class="rl">{u.role === "admin" ? <span class="tag">管理员</span> : "@" + u.username}</div>
      </div>
      <button class="icon-btn" title="账号菜单" aria-label="账号菜单" aria-expanded={open}><Icon name="chevD" size={16} /></button>
      {open && <UserMenu close={() => setOpen(false)} />}
    </div>
  );
}

// ---------- 值班目录 ----------
export function Sidebar() {
  const m = mainRoute.value;
  const q = query.value.trim();
  const list = groups.value;
  const home = m.name === "home" || m.name === "board";
  const r = route.value.name;
  const on = (n: string) => (r === n ? " on" : "");
  const kb = kbCount.value;
  const newSession = () => { resetComposer(); navigate("/s/new"); };
  return (
    <aside class="side" id="side">
      <div class="side-head">
        <div class="kicker"><span>今日会话</span><b>{pad(todayCount.value)}</b></div>
        <h2>值班目录</h2>
        <button class="btn primary block" onClick={newSession}><Icon name="plus" size={16} />新会话</button>
        <label class="searchbox">
          <Icon name="search" size={15} />
          <input placeholder="搜索会话" value={query.value} onInput={(e) => { query.value = (e.target as HTMLInputElement).value; }} />
          <kbd>{isMac() ? "⌘K" : "Ctrl K"}</kbd>
        </label>
        <SectionBar />
      </div>
      <nav class="nav">
        <a class={home && r !== "files" ? "on" : ""} onClick={() => navigate("/", { force: true })}><Icon name="chat" size={18} />值班板</a>
        <a class={on("files")} onClick={() => navigate("/files")}><Icon name="folder" size={18} />文件库</a>
        <a class={on("kb")} onClick={() => navigate(lastKbPath.value)}><Icon name="book" size={18} />知识库{kb ? <span class="cnt">{kb}</span> : null}</a>
        {isAdmin.value && <a class={on("admin")} onClick={() => navigate("/admin/users")}><Icon name="users" size={18} />管理后台</a>}
      </nav>
      <div class="side-list">
        {list.length === 0 && (
          <div class="empty">{q ? "没有匹配的会话" : currentSection.value === null ? "还没有会话" : "这个分区还没有会话，新建一个。"}</div>
        )}
        {list.map((g) => (
          <div key={g.name}>
            <div class="grp">{g.name}<span class="n">{g.items.length}</span></div>
            {g.items.map((s) => <SessRow key={s.id} s={s} />)}
          </div>
        ))}
      </div>
      <UserCard />
    </aside>
  );
}

