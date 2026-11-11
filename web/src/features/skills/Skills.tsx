// 技能：我的技能（列表、提交新技能、我的提交）和技能详情（版本记录、上传新版本、回滚）。
// 盖在主界面上的一张册页，网址 /skills、/skills/{name}，数据在 stores/skills.ts。
import { useRef, useState } from "preact/hooks";
import { Sheet } from "../../components/Sheet";
import { avatarEl } from "../../lib/avatars";
import { ftime } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { closeOverlay, overlayRoute, replace } from "../../router";
import { me } from "../../stores/auth";
import { current } from "../../stores/chat";
import { composerInput, mySkills, resetComposer, skill } from "../../stores/composer";
import {
  detail, detailName, loadDetail, loadList, loadVersionFiles, openDetail, openList, rollback, submissions, submitSkill, uploadDir, uploadZip,
} from "../../stores/skills";
import type { Submission } from "../../stores/skills";
import { confirmBox, toast } from "../../stores/ui";
import { openSkillFiles } from "./SkillFiles";

const STATUS: Record<string, [string, string]> = { pending: ["待审核", "warn"], approved: ["已入库", "ok"], rejected: ["未通过", "red"] };

// ---------- 上传（zip 或文件夹）并提交审核 ----------
function SkillUpload({ needLog, onDone }: { needLog: boolean; onDone: (r: { name: string }) => void }) {
  const [log, setLog] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const logEl = useRef<HTMLInputElement>(null);
  const zipIn = useRef<HTMLInputElement>(null);
  const dirIn = useRef<HTMLInputElement>(null);
  const go = async (upload: (id: string) => Promise<unknown>) => {
    const l = log.trim();
    if (needLog && !l) { setMsg("请先写更新说明"); logEl.current?.focus(); return; }
    setMsg("正在提交…"); setBusy(true);
    try { const r = await submitSkill(upload, l); setLog(""); setMsg(""); onDone(r); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div class="sk-up">
      <input class="input" ref={logEl} value={log} placeholder="更新说明：这次改了什么（更新已有技能时必填）" onInput={(e) => setLog((e.target as HTMLInputElement).value)} />
      <div class="sk-up-btns">
        <button class="btn sm" type="button" disabled={busy} onClick={() => zipIn.current?.click()}><Icon name="upload" size={14} />上传 zip 压缩包</button>
        <button class="btn sm" type="button" disabled={busy} onClick={() => dirIn.current?.click()}><Icon name="folder" size={14} />选择技能文件夹</button>
      </div>
      <input type="file" accept=".zip" hidden ref={zipIn} onChange={(e) => {
        const el = e.target as HTMLInputElement; const f = el.files?.[0]; el.value = ""; if (f) void go(uploadZip(f));
      }} />
      <input type="file" hidden {...{ webkitdirectory: true }} ref={dirIn} onChange={(e) => {
        const el = e.target as HTMLInputElement; const fs = [...(el.files || [])]; el.value = ""; if (fs.length) void go(uploadDir(fs));
      }} />
      <div class={"sk-msg" + (busy ? " busy" : "")}>{msg}</div>
    </div>
  );
}

// ---------- 列表 ----------
function SkillRow({ s }: { s: { name: string; description?: string; version?: number } }) {
  const open = () => openDetail(s.name);
  return (
    <tr onClick={open}>
      <td class="nmc">
        <button class="nm" type="button" onClick={(ev) => { ev.stopPropagation(); open(); }}>
          <Icon name="puzzle" size={16} /><span>{s.name}</span><span class="vtag">v{s.version || 1}</span>
        </button>
      </td>
      <td class="sub sk-desc">{s.description}</td>
    </tr>
  );
}

function SubRow({ s }: { s: Submission }) {
  const [label, kind] = STATUS[s.status] || [s.status, ""];
  return (
    <tr>
      <td class="nmc"><div class="nm"><span>{s.name}</span></div></td>
      <td class="sub"><span class={"tag " + kind}>{label}</span></td>
      <td class="sub sk-desc">{s.changelog || ""}</td>
      <td class="num" data-l="提交时间">{ftime(s.created)}</td>
      <td class="sub sk-desc" data-l="管理员备注">{s.note || ""}</td>
    </tr>
  );
}

function List() {
  const skills = mySkills.value;
  const subs = submissions.value;
  const mine = (subs || []).filter((s) => s.submitted_by === me.value?.id);
  return (
    <Sheet class="sk" kicker="Projector · 综合部工作台" title="技能" onClose={() => closeOverlay()}>
      <div class="pane">
        <h4 class="sk-h">我能用的技能 <span class="sk-hint">点开看版本记录、修改</span></h4>
        {skills.length ? (
          <table class="ledger sk-ledger">
            <thead><tr><th>名称</th><th>说明</th></tr></thead>
            <tbody>{skills.map((s) => <SkillRow key={s.name} s={s} />)}</tbody>
          </table>
        ) : <p class="empty">还没有，管理员分配后会出现在这里。</p>}

        <h4 class="sk-h">提交新技能</h4>
        <p class="note-hint">技能是一个文件夹，里面必须有 SKILL.md（开头写 name 和 description）。也可以直接在对话里说“帮我做一个××技能”，让 Claude 写好提交。提交后由管理员审核。</p>
        <SkillUpload needLog={false} onDone={(r) => { toast(`已提交技能 ${r.name}，等管理员审核`, "ok"); void loadList(); }} />

        <h4 class="sk-h">我的提交</h4>
        {subs === null ? <p class="empty">读取中…</p> : mine.length ? (
          <table class="ledger sk-ledger sk-subs">
            <thead><tr><th>名称</th><th>状态</th><th>更新说明</th><th>提交时间</th><th>管理员备注</th></tr></thead>
            <tbody>{mine.map((s) => <SubRow key={s.id} s={s} />)}</tbody>
          </table>
        ) : <p class="empty">还没有提交过。</p>}
      </div>
    </Sheet>
  );
}

// ---------- 详情 ----------
async function viewFiles(name: string, v: number): Promise<void> {
  try {
    const f = await loadVersionFiles(name, v);
    openSkillFiles(`${name} v${v} 的文件`, f.files, [{ label: "返回" }],
      f.changes ? <p class="note-hint">标出了相对上一个版本的改动</p> : undefined, f.changes);
  } catch (e) { toast((e as Error).message, "err"); }
}

async function askRollback(name: string, v: number): Promise<void> {
  const ok = await confirmBox({ title: "回滚", message: `回滚到 v${v}？会生成一个内容和 v${v} 一样的新版本，所有能用这个技能的人马上生效。`, ok: "回滚" });
  if (!ok) return;
  try { await rollback(name, v); } catch (e) { toast((e as Error).message, "err"); }
}

/** 关掉技能详情回到对话：当前有会话就回到它，没有就新开一个（和老代码一样） */
function leaveToChat(): void {
  if (!current.value) replace("/s/new", { force: true }); else closeOverlay();
}

function Detail({ name }: { name: string }) {
  const d = detail.value;
  const [upOpen, setUpOpen] = useState(false);
  const isAdmin = me.value?.role === "admin";
  const ready = d && detailName.value === name;
  if (!ready) {
    return (
      <Sheet class="sk" kicker="技能" title="技能详情" onClose={() => closeOverlay()} onBack={openList}>
        <div class="pane"><div class="empty">读取中…</div></div>
      </Sheet>
    );
  }
  const sk = d.skill;
  const editInChat = () => {
    resetComposer();
    replace("/s/new", { force: true });
    composerInput.set(`我想修改技能「${sk.name}」：`);
    toast("说清楚要改什么，Claude 会取出技能、改好后提交新版本给管理员审核", "info", 5000);
  };
  const useIt = () => {
    skill.value = sk.name;
    leaveToChat();
    setTimeout(() => composerInput.focus(), 150);   // 新开会话时输入区还没挂载，等一下
  };
  return (
    <Sheet class="sk" kicker="技能" title="技能详情" onClose={() => closeOverlay()} onBack={openList}>
      <div class="pane">
        <div class="crumbs">
          <a class="link" role="button" tabIndex={0} onClick={openList} onKeyDown={(e) => { if (e.key === "Enter") openList(); }}>技能</a>
          <Icon name="chevR" size={13} class="sk-sep" /><b>{sk.name}</b>
        </div>
        <div class="sk-head">
          <span class="big"><Icon name="puzzle" size={26} /></span>
          <div>
            <h3>{sk.name} <span class="vtag">v{sk.version}</span></h3>
            <p>{sk.description}</p>
          </div>
        </div>
        <div class="sk-acts">
          <button class="btn primary sm" type="button" onClick={editInChat}><Icon name="chat" size={14} />在对话里修改</button>
          <button class="btn sm" type="button" onClick={useIt}><Icon name="sparkle" size={14} />用它开始一个任务</button>
          <button class="btn sm" type="button" aria-expanded={upOpen} onClick={() => setUpOpen(!upOpen)}><Icon name="upload" size={14} />上传新版本</button>
        </div>
        {upOpen && (
          <div class="sk-box">
            <SkillUpload needLog onDone={(r) => { toast(`已提交 ${r.name} 的新版本，等管理员审核`, "ok"); setUpOpen(false); void loadDetail(name); }} />
            <p class="note-hint">SKILL.md 里的 name 要保持 <code>{sk.name}</code>，否则会变成一个新技能。</p>
          </div>
        )}
        {d.pending.length > 0 && (
          <div class="sk-warn">
            <Icon name="clock" size={14} /> 有 {d.pending.length} 个新版本在等管理员审核：{d.pending.map((p) => (p.submitter || "") + "「" + (p.changelog || "没写说明") + "」").join("；")}
          </div>
        )}
        <h4 class="sk-h"><Icon name="history" size={15} /> 版本记录</h4>
        <table class="ledger sk-ledger sk-vers">
          <thead><tr><th>版本</th><th>更新说明</th><th>提交人</th><th>时间</th><th>审核</th><th /></tr></thead>
          <tbody>
            {d.versions.map((v, i) => {
              const cur = v.version === sk.version;
              return (
                <tr key={v.version} class={cur ? "on" : ""} style={`animation-delay:${i * 30}ms`}>
                  <td class="nmc"><div class="nm"><span class="vtag">v{v.version}</span>{cur ? <span class="tag ok">当前</span> : null}</div></td>
                  <td class="sk-log">{v.changelog || "没写更新说明"}</td>
                  <td class="sub"><span class="sk-who"><span dangerouslySetInnerHTML={{ __html: avatarEl(v.submitter_avatar || "", 18) }} />{v.submitter || "—"}</span></td>
                  <td class="num" data-l="时间">{ftime(v.created)}</td>
                  <td class="sub">{v.approver ? v.approver + " 审核" : ""}</td>
                  <td class="r">
                    <button class="btn ghost sm" type="button" title="查看文件" aria-label="查看文件" onClick={() => void viewFiles(name, v.version)}><Icon name="eye" size={14} /><span class="lb">查看文件</span></button>
                    {isAdmin && !cur && <button class="btn ghost sm" type="button" title="回滚到这个版本" aria-label="回滚到这个版本" onClick={() => void askRollback(name, v.version)}><Icon name="history" size={14} /><span class="lb">回滚到这个版本</span></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}

export function SkillsSheet() {
  const r = overlayRoute.value;
  if (!r || r.name !== "skills" || !me.value) return null;
  return r.skill ? <Detail name={r.skill} /> : <List />;
}
