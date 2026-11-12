// 账户和会话上的几个小对话框：更换头像、修改密码、设置会话分区。它们是一步操作，不进网址，用通用对话框（DialogHost）显示。
import { signal } from "@preact/signals";
import { post } from "../../lib/api";
import { AVATAR_LIST, AVATAR_NAMES, avatarEl } from "../../lib/avatars";
import { dropLogin, me } from "../../stores/auth";
import { current, currentSess, isMine, upsertSession } from "../../stores/chat";
import { sections, sessionSectionName } from "../../stores/sessions";
import { closeDialog, openDialog, toast } from "../../stores/ui";

// ---------- 更换头像 ----------
const avaOn = signal("");

function AvatarPick() {
  const pick = async (id: string) => {
    avaOn.value = id;
    try {
      me.value = { ...me.value!, ...(await post("/api/me", { avatar: id }, "PATCH")) };
      setTimeout(closeDialog, 250);
      toast("头像换成了" + AVATAR_NAMES[id], "ok");
    } catch (err) { toast((err as Error).message, "err"); }
  };
  return (
    <div class="ac-ava-grid">
      {AVATAR_LIST.map(([id, n], i) => (
        <button key={id} type="button" class={"ac-ava" + (id === avaOn.value ? " on" : "")} style={`animation-delay:${i * 25}ms`} onClick={() => void pick(id)}>
          <span dangerouslySetInnerHTML={{ __html: avatarEl(id, 56) }} />{n}
        </button>
      ))}
    </div>
  );
}

export function pickAvatar(): void {
  avaOn.value = me.value?.avatar || "";
  openDialog("选一个头像", <AvatarPick />);
}

// ---------- 修改密码 ----------
const pw = { old: signal(""), n1: signal(""), n2: signal("") };

function PasswordForm() {
  return (
    <div class="ac-form">
      <input class="input" type="password" placeholder="原密码" autocomplete="current-password" value={pw.old.value} onInput={(e) => { pw.old.value = (e.target as HTMLInputElement).value; }} />
      <input class="input" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" value={pw.n1.value} onInput={(e) => { pw.n1.value = (e.target as HTMLInputElement).value; }} />
      <input class="input" type="password" placeholder="再输一次新密码" autocomplete="new-password" value={pw.n2.value} onInput={(e) => { pw.n2.value = (e.target as HTMLInputElement).value; }} />
      <div class="err" />
    </div>
  );
}

export function changePassword(): void {
  pw.old.value = pw.n1.value = pw.n2.value = "";
  openDialog("修改密码", <PasswordForm />, [{
    label: "保存", primary: true, onClick: async () => {
      if (pw.n1.value !== pw.n2.value) throw new Error("两次新密码不一样");
      await post("/api/me/password", { old: pw.old.value, new: pw.n1.value });
      // 服务端改密码后会让所有登录失效（含 cookie），这里直接回到登录页
      pw.old.value = pw.n1.value = pw.n2.value = "";
      await dropLogin();
      toast("密码已修改，请用新密码重新登录", "ok");
    },
  }]);
}

// ---------- 会话的分区 ----------
const secSel = signal("0");

function SectionPick() {
  const selected = Number(currentSess.value?.section_id || 0);
  const active = sections.value.filter((s) => !s.archived);
  return (
    <div class="ac-form">
      <select class="input" value={secSel.value} onChange={(e) => { secSel.value = (e.target as HTMLSelectElement).value; }}>
        <option value="0">未分类</option>
        {selected && !active.some((s) => Number(s.id) === selected)
          ? <option value={String(selected)}>{sessionSectionName(selected)}（已下架）</option> : null}
        {active.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
      </select>
      <p class="ac-hint">只影响这个会话的筛选，不改变下次新建的默认分区。</p>
    </div>
  );
}

export function pickSessionSection(): void {
  const s = currentSess.value;
  if (!s || !isMine.value) return;
  secSel.value = String(s.section_id || 0);
  openDialog("设置会话分区", <SectionPick />, [{ label: "取消" }, {
    label: "保存", primary: true, onClick: async () => {
      const r = await post(`/api/sessions/${current.value}`, { section_id: Number(secSel.value || 0) }, "PATCH");
      currentSess.value = r;
      upsertSession(r);
    },
  }]);
}
