// 消息列表。已完成的消息每条一个 memo 组件（按消息 id 做 key，Markdown 结果按消息缓存），
// 正在输出的那一条是独立组件，只订阅 live 信号；流式输出时历史消息的 DOM 不动。
import { memo } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../../lib/icons";
import { md } from "../../lib/markdown";
import { baseName, hm, pad, shortPath, toolMeta as toolMetaOf } from "../../lib/format";
import type { Approval, Message, Tool } from "../../lib/types";
import {
  approvals, cancelQueued, current, currentSess, decideApproval, hasMore, isMine, isWaiting, liveActive, liveSteps,
  liveText, liveThinking, liveTools, loadOlder, loading, messages, olderState, queued, seen, thinkOpen,
} from "../../stores/chat";
import { roots } from "../../stores/roots";
import { toast } from "../../stores/ui";

declare const window: Window & { legacy: any; kbDistill: () => void };

// ---------- 滚动：贴底跟随、加载更早时保持位置 ----------
let box: HTMLElement | null = null;
let stick = true;                                   // 滚动条离底部不到 120px 才自动跟随
let anchor: { h: number; top: number } | null = null;   // 加载更早的消息前记下的位置

const nearBottom = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 120;
/** 流式输出长高以后调用：贴底就跟着滚 */
export function followBottom(): void {
  if (box && stick) box.scrollTop = box.scrollHeight;
}

// ---------- 小零件 ----------
function Who({ t, who }: { t: number | null | undefined; who: string }) {
  return <div class="mg"><span class="who">{who}</span><span class="at">{t ? hm(t) : ""}</span></div>;
}

function Step({ t, i, cls = "" }: { t: Tool; i: number; cls?: string }) {
  const [label] = toolMetaOf(t.name);
  const d = shortPath(t.detail, roots.value);
  return (
    <li class={cls}>
      <span class="k">{pad(i + 1)}</span><span class="nm">{label}</span>
      {d ? <code title={t.detail}>{d}</code> : null}
    </li>
  );
}

function Chips({ meta }: { meta?: Record<string, any> }) {
  const refs: string[] = (meta && meta.refs) || [];
  const skill = meta && meta.skill;
  const kbAct = meta && meta.kb;
  if (!refs.length && !skill && !kbAct) return null;
  return (
    <div class="chips">
      {kbAct ? <span class="chip"><Icon name="book" size={12} /><span>知识库</span></span> : null}
      {skill ? <span class="chip"><Icon name="puzzle" size={12} /><span>{skill}</span></span> : null}
      {refs.map((r) => (
        <span key={r} class="chip ref" data-fpath={r} title={r}><Icon name="clip" size={12} /><span>{baseName(r)}</span></span>
      ))}
    </div>
  );
}

/** Markdown 渲染结果，按消息对象缓存（消息不会变，换会话时旧缓存随对象一起被回收） */
const mdCache = new WeakMap<Message, string>();
const mdOf = (m: Message): string => {
  let h = mdCache.get(m);
  if (h === undefined) { h = md(m.content); mdCache.set(m, h); }
  return h;
};

/** 回复里的文件路径变成可点的小标签（老的文件库代码提供，要有根目录才能认出路径） */
function useLinkify(ref: { current: HTMLElement | null }, dep: unknown): void {
  const n = roots.value.length;
  useLayoutEffect(() => { if (ref.current && n) window.legacy.linkifyPaths(ref.current); }, [dep, n]);
}

// ---------- 一条已完成的消息 ----------
const Entry = memo(function Entry({ m, distill }: { m: Message; distill: boolean }) {
  const meta = m.meta || {};
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mdRef = useRef<HTMLDivElement>(null);
  const html = m.role === "user" || m.role === "event" || m.role === "error" ? "" : mdOf(m);
  useLinkify(mdRef, html);
  const isNew = !seen.has(m.id);
  useEffect(() => { seen.add(m.id); }, []);

  if (m.role === "user") {
    return (
      <article class={"entry user" + (isNew ? " new" : "")}>
        <Who t={m.created} who={meta.author || "交办"} />
        <div class="bd"><span class="txt">{m.content}</span><Chips meta={meta} /></div>
      </article>
    );
  }
  if (m.role === "event" && meta.qa) {
    const qa = meta.qa;
    return (
      <>
        <div class="evt"><span>{m.content}</span></div>
        {qa.questions.map((q: any, i: number) => {
          const a = (qa.answers || [])[i] || {};
          const picks: string[] = [...(a.selected || []), ...(a.other ? ["其他：" + a.other] : [])];
          return (
            <article class="entry" key={i}>
              <Who t={m.created} who="问答" />
              <div class="bd"><b>{q.question}</b><div>{picks.length ? picks.join("、") : "（没选）"}{a.note ? ` · ${a.note}` : ""}</div></div>
            </article>
          );
        })}
      </>
    );
  }
  if (m.role === "event") return <div class="evt"><span>{m.content.replace(/^[✔✘⌛]\s*/, "")}</span></div>;

  const tools: Tool[] = meta.tools || [];
  const info = [meta.seconds != null ? meta.seconds + " 秒" : "", meta.cost ? "$" + meta.cost.toFixed(4) : ""].filter(Boolean).join(" · ");
  return (
    <article class={"entry" + (isNew ? " new" : "")}>
      <Who t={m.created} who="Claude" />
      <div class="bd">
        {tools.length > 0 && (
          <>
            <button class={"fold" + (open ? " open" : "")} onClick={() => setOpen(!open)} aria-expanded={open}>
              <Icon name="chevR" size={14} />做了 {tools.length} 步
            </button>
            {open && <ol class="steps">{tools.map((t, i) => <Step key={i} t={t} i={i} />)}</ol>}
          </>
        )}
        {m.role === "error"
          ? <div class="errbox"><Icon name="alert" size={17} /><div>{m.content}</div></div>
          : <div class="md" ref={mdRef} dangerouslySetInnerHTML={{ __html: html }} />}
        {(info || distill) && (
          <div class="info">
            {info ? <span>{info}</span> : null}
            {distill && (
              <button class="btn ghost sm" disabled={busy} title="Claude 会把这次的做法整理成一条经验笔记，存进团队知识库"
                onClick={() => { setBusy(true); window.kbDistill(); }}>
                <Icon name="book" size={14} />沉淀成经验
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}, (a, b) => a.m === b.m && a.distill === b.distill);

// ---------- 正在输出的那一条 ----------
/** Markdown 渲染节流到每帧一次，只更新自己 */
function useLiveHtml(): string {
  const [html, setHtml] = useState(() => md(liveText.peek()));
  useEffect(() => {
    let raf = 0;
    const stop = liveText.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setHtml(md(liveText.peek())); });
    });
    return () => { stop(); cancelAnimationFrame(raf); };
  }, []);
  return html;
}

function LiveEntry() {
  const waiting = isWaiting.value;
  const tools = liveTools.value;
  const thinking = liveThinking.value;
  const html = useLiveHtml();
  const mdRef = useRef<HTMLDivElement>(null);
  const tb = useRef<HTMLDivElement>(null);
  const shown = liveSteps.peek();
  useLinkify(mdRef, html);
  useLayoutEffect(() => { liveSteps.value = tools.length; }, [tools.length]);
  useLayoutEffect(() => { followBottom(); }, [html, tools.length, thinking.length, waiting]);
  // 思考块：文字长高时，读者停在底部就跟着滚
  const tbStick = useRef(true);
  useLayoutEffect(() => { if (tb.current && tbStick.current) tb.current.scrollTop = tb.current.scrollHeight; }, [thinking]);
  return (
    <article class="entry live-entry">
      <Who t={null} who={waiting ? "待确认" : "进行中"} />
      <div class="bd">
        {tools.length > 0 && <ol class="steps running">{tools.map((t, i) => (
          <Step key={i} t={t} i={i} cls={(i >= shown ? "new " : "") + (i === tools.length - 1 && !waiting ? "cur" : "")} />
        ))}</ol>}
        {thinking && (
          <>
            <button class={"fold" + (thinkOpen.value ? " open" : "")} onClick={() => { thinkOpen.value = !thinkOpen.value; }} aria-expanded={thinkOpen.value}>
              <Icon name="chevR" size={14} />思考中
            </button>
            {thinkOpen.value && (
              <div class="think" ref={tb} onScroll={(e) => { const t = e.currentTarget; tbStick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 30; }}>{thinking}</div>
            )}
          </>
        )}
        <div class={"md" + (waiting ? "" : " typing")} ref={mdRef} dangerouslySetInnerHTML={{ __html: html }} />
        {!waiting && !html && <div class="live"><b><i /><i /><i /></b></div>}
      </div>
    </article>
  );
}

// ---------- 待确认的操作 ----------
function ApprovalDetail({ a }: { a: Approval }) {
  const i = (a.input as Record<string, any>) || {};
  if (a.tool === "Bash") return <>{i.command}{i.description ? `\n\n# ${i.description}` : ""}</>;
  if (a.tool === "Edit") return <><span class="del">- {i.old_string}</span>{"\n"}<span class="add">+ {i.new_string}</span></>;
  if (a.tool === "Write") { const c: string = i.content || ""; return <>{c.slice(0, 2000)}{c.length > 2000 ? "\n……" : ""}</>; }
  return <>{JSON.stringify(i, null, 1)}</>;
}

function Ticket({ a }: { a: Approval }) {
  const [busy, setBusy] = useState(false);
  const decide = (allow: boolean) => {
    setBusy(true);
    decideApproval(a.id, allow).catch((e) => { toast(e.message, "err"); setBusy(false); });
  };
  return (
    <div class="slip ticket">
      <div class="hd"><div class="kick">待确认</div><h4>{a.summary}</h4></div>
      <pre><ApprovalDetail a={a} /></pre>
      <div class="acts">
        <button class="btn" disabled={busy} onClick={() => decide(false)}><Icon name="x" size={15} />拒绝</button>
        <button class="btn primary" disabled={busy} onClick={() => decide(true)}><Icon name="check" size={15} />同意</button>
      </div>
    </div>
  );
}

// ---------- 列表 ----------
export function MessageList() {
  const ref = useRef<HTMLDivElement>(null);
  const msgs = messages.value;
  const sess = currentSess.value;
  const q = queued.value;
  const apps = approvals.value;
  const live = liveActive.value;
  const mine = isMine.value;
  const sid = current.value;
  const lastAi = mine && !live && !(sess && sess.running) && sess && sess.claude_session
    ? msgs.map((m) => m.role).lastIndexOf("assistant") : -1;

  useEffect(() => {
    box = ref.current;
    return () => { box = null; };
  }, []);

  // 换会话：先假定贴底，消息到了以后滚到底
  const opened = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (opened.current !== sid) { opened.current = sid; stick = true; }
  }, [sid]);

  // 内容变了：加载更早的消息就补回高度，否则贴底就跟着滚（有待确认的操作也滚到底）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (anchor) { el.scrollTop = anchor.top + (el.scrollHeight - anchor.h); anchor = null; return; }
    if (stick || apps.length) { el.scrollTop = el.scrollHeight; }
  }, [msgs, apps.length, q.length, sid, loading.value]);

  const onScroll = () => {
    const el = ref.current!;
    stick = nearBottom(el);
    // 失败后不自动重试，免得刷屏，点按钮重试
    if (hasMore.value && olderState.value === "" && el.scrollTop < 40) void older();
  };
  const older = () => loadOlder(() => { const el = ref.current!; anchor = { h: el.scrollHeight, top: el.scrollTop }; });
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest("[data-fpath]") as HTMLElement | null;
    if (a?.dataset.fpath) window.legacy.showFiles(a.dataset.fpath);
  };

  const empty = !msgs.length && !live && !apps.length && !q.length;
  const st = olderState.value;
  return (
    <div class="msgs" ref={ref} onScroll={onScroll} onClick={onClick}>
      <div class="col">
        {empty && !loading.value && <div class="entry-empty">还没有记录。写下要交给 Claude 的事，发送后从这里开始。</div>}
        {hasMore.value && (
          <button class="btn ghost sm older" disabled={st === "loading"}
            onClick={() => { olderState.value = ""; void older(); }}>
            {st === "loading" ? "加载中…" : st === "failed" ? "加载失败，点此重试" : "加载更早的消息"}
          </button>
        )}
        {msgs.map((m, i) => <Entry key={m.id} m={m} distill={i === lastAi} />)}
        {live && <LiveEntry />}
        {apps.map((a) => <Ticket key={a.id} a={a} />)}
        {q.map((x) => (
          <article class="entry user queued" key={"q" + x.id}>
            <Who t={null} who="排队中" />
            <div class="bd">
              <span class="txt">{x.text}</span>
              {mine && (
                <div style="margin-top:6px">
                  <button class="btn ghost sm" onClick={(e) => {
                    const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
                    cancelQueued(x.id).catch((err) => { toast(err.message, "err"); b.disabled = false; });
                  }}><Icon name="x" size={13} />取消</button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

