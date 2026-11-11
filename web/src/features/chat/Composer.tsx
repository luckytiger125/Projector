// 输入区：提问面板、引用和技能的小标签、输入框、工具栏、技能选择、排队和停止。
import { useEffect, useRef, useState } from "preact/hooks";
import { orb } from "../../lib/avatars";
import { Icon } from "../../lib/icons";
import { useOutsideClick } from "../../lib/hooks";
import { navigate } from "../../router";
import {
  askOf, askPick, askSetNote, askSetOther, askSetStep, askSubmit, currentSess, isAnswered, isMine, questions,
  sendMessage, sending, stopSession,
} from "../../stores/chat";
import { mySkills, refs, registerInput, removeRef, skill, skillPopRequest } from "../../stores/composer";
import { dialog, confirmBox, paletteOpen } from "../../stores/ui";

declare const window: Window & { legacy: any };

// ---------- 提问面板 ----------
const REC = /（推荐）$|\(推荐\)$/;

function AskPanel() {
  const q = questions.value[0];
  const dock = useRef<HTMLDivElement>(null);
  // 键盘：数字键选项，回车下一题或提交（输入框里只有“其他”和“补充说明”两个吃回车）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!questions.value.length) return;
      if (document.querySelector(".overlay.show") || dialog.value || paletteOpen.value) return;
      const t = e.target as Element | null;
      const typing = t && t.closest && t.closest("input, textarea");
      if (!typing && /^[1-9]$/.test(e.key)) { e.preventDefault(); askPick(+e.key - 1); return; }
      const id = (t as HTMLElement | null)?.id;
      if (e.key === "Enter" && !e.isComposing && (!typing || id === "askOther" || id === "askNote")) {
        const btn = dock.current?.querySelector<HTMLButtonElement>("[data-submit]:not(:disabled),[data-next]:not(:disabled)");
        if (btn) { e.preventDefault(); btn.click(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // 面板出现、换题时把焦点放到面板上（没有别的弹层时），好让数字键和回车生效
  useEffect(() => { if (q && !document.querySelector(".overlay.show") && !dialog.value) dock.current?.focus(); }, [q?.id]);
  if (!q) return null;
  const qq = q;
  const st = askOf(qq), qi = st.step, item = qq.questions[qi], a = st.ans[qi];
  const multi = !!item.multi_select, last = qi === qq.questions.length - 1;
  const submit = async (skipped: boolean) => {
    if (skipped && !(await confirmBox({ title: "跳过", message: "跳过这些问题？Claude 会按它认为最合理的方式继续。", ok: "跳过" }))) return;
    await askSubmit(skipped);
  };
  return (
    <div class="ask" ref={dock} tabIndex={-1}>
      <div class="hd">
        <span class="ttl" dangerouslySetInnerHTML={{ __html: orb(22, "wait") }} />
        <span class="tt">Claude 想问你</span>
        {qq.questions.length > 1 && <b>{qi + 1} / {qq.questions.length}</b>}
        {qq.questions.length > 1 && (
          <span class="steps-nav">
            {qq.questions.map((x, i) => (
              <button key={i} class={(i === qi ? "on " : "") + (isAnswered(st.ans[i]) ? "done" : "")} onClick={() => askSetStep(i)}>
                {isAnswered(st.ans[i]) && i !== qi ? <Icon name="check" size={11} /> : null}{x.header || "问题 " + (i + 1)}
              </button>
            ))}
          </span>
        )}
      </div>
      <div class="q">{item.question}{multi ? <small>可以多选</small> : null}</div>
      {item.options.map((o, i) => {
        const on = a.selected.includes(o.label);
        return (
          <button key={qi + ":" + i} class={"opt" + (on ? " on" : "") + (REC.test(o.label) ? " rec" : "")} onClick={() => askPick(i)}>
            <kbd>{on && multi ? <Icon name="check" size={11} /> : i + 1}</kbd>
            <span><span class="l">{o.label.replace(REC, "")}</span>{o.description ? <span class="d">{o.description}</span> : null}</span>
          </button>
        );
      })}
      <label class={"opt other" + (a.other.trim() ? " on" : "")}>
        <kbd><Icon name="edit" size={11} /></kbd>
        <input id="askOther" placeholder="其他：自己写一个答案…" value={a.other} onInput={(e) => askSetOther((e.target as HTMLInputElement).value)} />
      </label>
      <div class="note"><input id="askNote" placeholder="补充说明（可选），比如具体要求、注意事项" value={a.note} onInput={(e) => askSetNote((e.target as HTMLInputElement).value)} /></div>
      <div class="ft">
        <button class="btn ghost sm" onClick={() => submit(true)}>跳过，让 Claude 自己决定</button>
        <span class="hint">按 1~{item.options.length} 选择 · 回车{last ? "提交" : "下一题"}</span>
        {qi > 0 && <button class="btn sm" onClick={() => askSetStep(qi - 1)}><Icon name="chevL" size={14} />上一题</button>}
        {last
          ? <button class="btn primary sm" data-submit disabled={!st.ans.every(isAnswered)} onClick={() => submit(false)}><Icon name="check" size={15} />提交</button>
          : <button class="btn primary sm" data-next disabled={!isAnswered(a)} onClick={() => askSetStep(qi + 1)}>下一题<Icon name="chevR" size={14} /></button>}
      </div>
    </div>
  );
}

// ---------- 技能选择 ----------
function SkillPop({ close }: { close: () => void }) {
  const skills = mySkills.value;
  return (
    <div class="skill-pop" onClick={(e) => e.stopPropagation()}>
      {skills.length ? skills.map((s) => (
        <div key={s.name} class="it" onClick={() => { skill.value = s.name; close(); document.getElementById("input")?.focus(); }}>
          <span class="ii"><Icon name="puzzle" size={15} /></span>
          <div style="flex:1;min-width:0"><b>{s.name} <span class="vtag">v{s.version || 1}</span></b><small>{s.description}</small></div>
          <button class="icon-btn" title="详情和版本记录" onClick={(e) => { e.stopPropagation(); close(); navigate("/skills/" + encodeURIComponent(s.name)); }}><Icon name="history" size={15} /></button>
        </div>
      )) : <div class="empty" style="padding:10px 12px">管理员还没给你分配技能。</div>}
      <div class="sep" />
      <div class="it" onClick={() => { close(); navigate("/skills"); }}>
        <span class="ii"><Icon name="upload" size={15} /></span>
        <div><b>提交新技能</b><small>查看我的提交和审核状态</small></div>
      </div>
    </div>
  );
}

// ---------- 输入区 ----------
export function Composer() {
  const s = currentSess.value;
  const mine = isMine.value;
  const asking = questions.value.length > 0;
  const running = !!(s && s.running);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [pop, setPop] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  useOutsideClick(pop, (t) => !!anchor.current?.contains(t), () => setPop(false));
  useEffect(() => { registerInput(ta.current); return () => registerInput(null); }, [mine, asking]);
  useEffect(() => { if (skillPopRequest.value) setPop(true); }, [skillPopRequest.value]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  const autosize = () => { const t = ta.current; if (!t) return; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 260) + "px"; };
  const send = async () => {
    const t = ta.current; if (!t) return;
    if (await sendMessage(t.value)) { t.value = ""; autosize(); }
  };
  const onInput = (e: Event) => {
    autosize();
    if ((e as InputEvent).data === "@") {   // 打 @ 打开文件选择
      const t = ta.current!;
      t.value = t.value.slice(0, t.selectionStart - 1) + t.value.slice(t.selectionStart);
      window.legacy.showFiles();
    }
  };

  if (!mine && !asking) return <div class="composer" />;
  return (
    <div class="composer">
      <div class="col">
        {asking && <AskPanel />}
        {!asking && mine && (
          <div class={"cbox" + (running ? " running" : "")}>
            {(skill.value || refs.value.length > 0) && (
              <div class="chips">
                {skill.value && (
                  <span class="chip skill"><Icon name="puzzle" size={12} /><span>{skill.value}</span>
                    <button title="不用这个技能" aria-label="不用这个技能" onClick={() => { skill.value = ""; }}><Icon name="x" size={12} /></button></span>
                )}
                {refs.value.map((r, i) => (
                  <span key={r.abs} class="chip ref" title={r.abs} onClick={() => window.legacy.showFiles(r.path)}>
                    <Icon name={r.dir ? "folder" : "clip"} size={12} /><span>{r.name}</span>
                    <button title="移除" aria-label="移除" onClick={(e) => { e.stopPropagation(); removeRef(i); }}><Icon name="x" size={12} /></button>
                  </span>
                ))}
              </div>
            )}
            <textarea id="input" ref={ta} rows={1} placeholder="写下要交给 Claude 的事" onInput={onInput}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }} />
            <div class="cbar">
              <button class="tbtn" title="从文件库选文件或文件夹（也可以打 @）" onClick={() => window.legacy.showFiles()}><Icon name="clip" size={16} /><span>引用文件</span></button>
              <button class="tbtn" title="把这台电脑上的文件交给 Claude" onClick={() => window.legacy.openLocalDialog()}><Icon name="laptop" size={16} /><span>本机文件</span></button>
              <span class="anchor" ref={anchor}>
                <button class={"tbtn" + (skill.value ? " on" : "")} onClick={(e) => { e.stopPropagation(); setPop(!pop); }}><Icon name="puzzle" size={16} /><span>技能</span></button>
                {pop && <SkillPop close={() => setPop(false)} />}
              </span>
              <span class="sp" />
              <span class="hint">Enter 发送 · Shift+Enter 换行</span>
              {running && <button class="send stop" title="停止" aria-label="停止" onClick={() => { void stopSession(); }}><Icon name="stop" size={14} /></button>}
              <button class="send" title={running ? "加入排队（前面的完成后自动开始）" : "发送"} aria-label="发送" disabled={sending.value} onClick={() => void send()}><Icon name="send" size={18} /></button>
            </div>
          </div>
        )}
        {!asking && mine && <div class="foot-note">{s && s.bypass ? "完全放行已打开：所有操作都会直接执行，不再询问" : "Claude 在台式机上干活，重要的改动请再核对一遍"}</div>}
      </div>
    </div>
  );
}
