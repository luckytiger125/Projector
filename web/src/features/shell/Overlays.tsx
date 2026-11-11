// 盖在最上面的几层：通用对话框、提示条、命令面板。
import { useEffect, useRef, useState } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { rel } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { navigate } from "../../router";
import { isAdmin } from "../../stores/auth";
import { current, currentSess, isMine } from "../../stores/chat";
import { resetComposer, skillPopRequest } from "../../stores/composer";
import { sessions } from "../../stores/sessions";
import {
  cycleTheme, dialog, dismissDialog, closeDialog, paletteOpen, theme, toast, toasts, THEMES,
} from "../../stores/ui";
import type { DialogButton } from "../../stores/ui";

declare const window: Window & { legacy: any; kbDistill: () => void };

// ---------- 通用对话框 ----------
function DialogButtonEl({ b, value, busy, setBusy }: { b: DialogButton; value: () => string; busy: boolean; setBusy: (v: boolean) => void }) {
  const click = async () => {
    setBusy(true);
    try {
      if ((await b.onClick?.(value())) !== false) closeDialog();
    } catch (e) {
      const err = document.getElementById("dlgBody")?.querySelector(".err");
      if (err) err.textContent = (e as Error).message; else toast((e as Error).message, "err");
    } finally { setBusy(false); }
  };
  return (
    <button class={"btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : "")} disabled={busy} onClick={click} data-primary={b.primary || b.danger ? "1" : undefined}>
      {b.icon ? <Icon name={b.icon} size={15} /> : null}{b.label}
    </button>
  );
}

export function DialogHost() {
  const d = dialog.value;
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!d) return;
    // 和老代码一致：弹出后把焦点给第一个输入框
    const t = setTimeout(() => {
      const el = document.getElementById("dlgBody")?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea") || input.current;
      el?.focus();
      input.current?.select();
    }, 60);
    return () => clearTimeout(t);
  }, [d]);
  if (!d) return null;
  const html = typeof d.body === "object" && d.body !== null && "html" in (d.body as object) ? (d.body as { html: string }).html : null;
  const value = () => input.current?.value ?? "";
  const primaryClick = () => foot.current?.querySelector<HTMLButtonElement>("button[data-primary]:last-of-type")?.click();
  return (
    <div class="veil" onMouseDown={(e) => { if (e.target === e.currentTarget) dismissDialog(); }}>
      <div class={"dlg" + (d.danger ? " danger" : "") + (d.wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={d.title}>
        <header class="dlg-head">
          <h4>{d.title}</h4>
          <button class="icon-btn" title="关闭" aria-label="关闭" onClick={dismissDialog}><Icon name="x" size={18} /></button>
        </header>
        {html !== null
          ? <div class="dlg-body content" id="dlgBody" key={html} dangerouslySetInnerHTML={{ __html: html }} />
          : (
            <div class="dlg-body" id="dlgBody">
              {typeof d.body === "string" ? (d.body ? <p>{d.body}</p> : null) : (d.body as any)}
              {d.input && (
                <input class="input" ref={input} value={d.input.value} placeholder={d.input.placeholder}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); primaryClick(); } }} />
              )}
            </div>
          )}
        {d.buttons.length > 0 && (
          <div class="acts" ref={foot}>
            {d.buttons.map((b, i) => <DialogButtonEl key={i} b={b} value={value} busy={busy} setBusy={setBusy} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 提示条 ----------
export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <span key={t.id} class={`toast ${t.kind === "info" ? "" : t.kind} ${t.phase}`}>
          <Icon name={t.kind === "ok" ? "check" : t.kind === "err" ? "alert" : "sparkle"} size={16} />
          <span>{t.text}</span>
        </span>
      ))}
    </div>
  );
}

// ---------- 命令面板 ----------
interface PalItem { kind: "act" | "sess"; ic: string; label: string; hint: string; run: () => void; dot?: string }

function paletteActions(): Array<[string, string, string, () => void]> {
  const L = window.legacy;
  const themeIcon = theme.value === "dark" ? "sun" : "moon";
  const acts: Array<[string, string, string, () => void]> = [
    ["plus", "新会话", "", () => { resetComposer(); navigate("/s/new"); }],
    ["folder", "打开文件库", "", () => navigate("/files")],
    ["book", "打开知识库", "", () => navigate("/kb")],
    ["clip", "引用文件到对话", "@", () => L.showFiles()],
    ["laptop", "把本机文件交给 Claude", "", () => L.openLocalDialog()],
    ["puzzle", "选择技能", "", () => { skillPopRequest.value++; }],
    ["upload", "提交新技能", "", () => navigate("/skills")],
    ["user", "更换头像", "", () => L.pickAvatar()],
    ["phone", "在手机上打开", "", () => navigate("/mobile")],
    ["trash", "回收站", "", () => navigate("/files/trash")],
    [themeIcon, "切换主题", "", () => { cycleTheme(); }],
    ["key", "修改密码", "", () => L.changePassword()],
  ];
  if (isAdmin.value) acts.push(["shield", "打开管理后台", "", () => navigate("/admin/users")]);
  const id = current.value;
  if (id) acts.splice(1, 0, ["steps", "查看完整过程", "", () => navigate(`/s/${id}/steps`)]);
  if (id && isMine.value && currentSess.value?.claude_session) acts.splice(2, 0, ["book", "沉淀经验：把这次对话存进知识库", "", () => window.kbDistill()]);
  return acts;
}

export function Palette() {
  const open = paletteOpen.value;
  const q = useSignal("");
  const sel = useSignal(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    q.value = ""; sel.value = 0;
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);
  const query = q.value.trim().toLowerCase();
  const items: PalItem[] = open ? [
    ...paletteActions().filter((a) => !query || a[1].toLowerCase().includes(query)).map(
      (a): PalItem => ({ kind: "act", ic: a[0], label: a[1], hint: a[2], run: a[3] })),
    ...sessions.value.filter((s) => !query || s.title.toLowerCase().includes(query)).slice(0, query ? 20 : 6).map(
      (s): PalItem => ({ kind: "sess", ic: "chat", label: s.title, hint: rel(s.updated), run: () => navigate("/s/" + s.id) })),
  ] : [];
  const cur = Math.min(sel.value, Math.max(0, items.length - 1));
  useEffect(() => { list.current?.querySelector(".it.on")?.scrollIntoView({ block: "nearest" }); });
  if (!open) return null;
  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    paletteOpen.value = false;
    setTimeout(it.run, 60);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel.value = Math.min(cur + 1, items.length - 1); }
    if (e.key === "ArrowUp") { e.preventDefault(); sel.value = Math.max(cur - 1, 0); }
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); run(cur); }
  };
  let last = "";
  return (
    <div class="veil top" onMouseDown={(e) => { if (e.target === e.currentTarget) paletteOpen.value = false; }}>
      <div class="palette" role="dialog" aria-label="命令面板">
        <div class="pq">
          <Icon name="search" size={18} />
          <input ref={input} placeholder="搜索会话，或输入命令…" value={q.value}
            onInput={(e) => { q.value = (e.target as HTMLInputElement).value; sel.value = 0; }} onKeyDown={key} />
          <kbd>Esc</kbd>
        </div>
        <div class="plist" ref={list}>
          {items.length === 0 && <div class="empty" style="padding:16px;text-align:center">没有匹配的结果</div>}
          {items.map((it, i) => {
            const head = it.kind !== last ? <div class="gh">{it.kind === "act" ? "操作" : "会话"}</div> : null;
            last = it.kind;
            return (
              <div key={it.kind + i}>
                {head}
                <div class={"it" + (i === cur ? " on" : "")} onClick={() => run(i)} onMouseMove={() => { if (sel.value !== i) sel.value = i; }}>
                  <Icon name={it.ic} size={16} /><span class="lb">{it.label}</span><span class="ph">{it.hint}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
