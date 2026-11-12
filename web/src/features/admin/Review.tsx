// 待审核页签：待审核的提交和历史；审核时在对话框里看每个文件，通过（入库或发新版本）或退回并写备注。
import { signal } from "@preact/signals";
import { Icon } from "../../lib/icons";
import { ftime } from "../../lib/format";
import { deleteSubmission, loadSubmissionFiles, reviewSubmission, submissions, userOf } from "../../stores/admin";
import type { AdminSubmission } from "../../stores/admin";
import { confirmBox, toast } from "../../stores/ui";
import { openSkillFiles } from "../skills/SkillFiles";
import { Ava } from "./parts";

const ST: Record<string, [string, string]> = { pending: ["待审核", "warn"], approved: ["已入库", "ok"], rejected: ["未通过", "red"] };

/** 审核对话框里的备注（对话框的按钮在组件外面，用信号传过去） */
const note = signal("");

async function review(id: string): Promise<void> {
  let d: any;
  try { d = await loadSubmissionFiles(id); } catch (e) { toast((e as Error).message, "err"); return; }
  const s = d.submission;
  const pending = s.status === "pending";
  const decide = (approve: boolean) => async () => { await reviewSubmission(id, s.name, approve, note.value.trim()); };
  const ch = d.changes;
  const summary = ch
    ? [["新增", ch.added.length], ["修改", ch.modified.length], ["删除", ch.removed.length]].filter((x) => x[1]).map((x) => x.join(" ")).join("，") || "文件没有变化"
    : "";
  note.value = "";
  const u = userOf(s.submitted_by);
  openSkillFiles(`审核技能：${s.name}`, d.files,
    pending ? [
      { label: "退回", icon: "x", danger: true, onClick: decide(false) },
      { label: d.updates_existing ? `通过，发布为 v${d.current_version + 1}` : "通过并入库", icon: "check", primary: true, onClick: decide(true) },
    ] : [],
    <>
      <div class="ad-rv-h">
        <Ava id={u.avatar} size={36} />
        <div>
          <div>
            <b>{s.submitter || u.display_name}</b> 提交 · {d.files.length} 个文件
            {d.updates_existing
              ? <> · <span class="tag warn">更新 v{d.current_version} → v{d.current_version + 1}：{summary}</span></>
              : <> · <span class="tag ok">新技能</span></>}
          </div>
          <div class="ad-desc">{s.description}</div>
        </div>
      </div>
      <div class="ad-changelog"><b>更新说明</b>{s.changelog || "（没写）"}</div>
      {pending && <input class="input ad-note" placeholder="给提交人的备注（可选）" onInput={(e) => { note.value = (e.target as HTMLInputElement).value; }} />}
    </>,
    ch);
}

async function del(id: string): Promise<void> {
  if (!(await confirmBox({ title: "删除", message: "删除这个提交记录？（已入库的技能不受影响）", ok: "删除", danger: true }))) return;
  try { await deleteSubmission(id); } catch (e) { toast((e as Error).message, "err"); }
}

function Card({ s }: { s: AdminSubmission }) {
  const [label, kind] = ST[s.status] || [s.status, ""];
  const pend = s.status === "pending";
  return (
    <div class="ad-card">
      <h4 class="ad-h">
        <Ava id={userOf(s.submitted_by).avatar} size={26} />{s.name} <span class={"tag " + kind}>{label}</span>
        {s.current_version && pend ? <span class="vtag">更新 v{s.current_version}</span> : null}
      </h4>
      {s.changelog ? <div class="ad-log">{s.changelog}</div> : null}
      <div class="ad-desc">{s.description}</div>
      <div class="ad-meta">提交人：{s.submitter || "—"} · {ftime(s.created)}{s.note ? " · 备注：" + s.note : ""}</div>
      <div class="ad-acts">
        <button class={"btn sm" + (pend ? " primary" : "")} type="button" onClick={() => void review(s.id)}>
          <Icon name={pend ? "shield" : "eye"} size={14} />{pend ? "审核" : "查看"}
        </button>
        <button class="btn ghost sm ad-danger" type="button" title="删除" aria-label="删除" onClick={() => void del(s.id)}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  );
}

export function ReviewTab() {
  const subs = submissions.value;
  const pending = subs.filter((s) => s.status === "pending"), done = subs.filter((s) => s.status !== "pending");
  return (
    <>
      <div class="ad-card warn ad-slim"><div class="ad-desc"><Icon name="alert" size={14} /> skill 里的脚本会在台式机上以完整权限运行，审核时请把标了“脚本”的文件都看一遍。</div></div>
      <h4 class="sk-h">待审核（{pending.length}）</h4>
      {pending.length ? pending.map((s) => <Card key={s.id} s={s} />) : <p class="empty">没有待审核的提交。</p>}
      <h4 class="sk-h">历史</h4>
      {done.length ? done.map((s) => <Card key={s.id} s={s} />) : <p class="empty">没有。</p>}
    </>
  );
}
