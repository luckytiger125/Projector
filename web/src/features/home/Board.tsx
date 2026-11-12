// 值班板：待处理、今日会话、今日知识库。
import { useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api";
import { fmtCost, fmtDuration, fmtTok, hm, pad, baseName, sessStatus } from "../../lib/format";
import { Icon } from "../../lib/icons";
import type { Session } from "../../lib/types";
import { navigate } from "../../router";
import { me, token } from "../../stores/auth";
import { conn } from "../../stores/events";
import { kbToday, openNote } from "../../stores/kb";
import { roots } from "../../stores/roots";
import { currentSection, sectionMatch, sessionSectionName, sessions } from "../../stores/sessions";

interface UsageMeta { input: string; output: string; cache: string; turns: string; cost: string }
const EMPTY: UsageMeta = { input: "尚未入账", output: "尚未入账", cache: "尚未入账", turns: "尚未入账", cost: "尚未入账" };

function Card({ s }: { s: Session }) {
  const [label, cls] = sessStatus(s);
  const dur = s.duration_seconds ?? (s.created && s.updated ? s.updated - s.created : null);
  const files = s.file_count;
  const dot = cls === "run" ? "run" : cls === "wait" ? "wait" : s.status === "queued" ? "queue" : "";
  const tag = cls === "wait" ? "red" : s.status === "queued" ? "warn" : "";
  return (
    <a class={"dcard" + (cls === "wait" ? " todo" : "")} onClick={() => navigate("/s/" + s.id)}>
      <h4><span class={"dot " + dot} /><span class="t">{s.title}</span><span class={"tag " + tag}>{label}</span></h4>
      <p>{fmtDuration(dur)} · {files != null ? files + " 份" : "—"}</p>
      <div class="ft"><span>分区 · {sessionSectionName(s.section_id)}</span><span>{hm(s.updated)}</span></div>
    </a>
  );
}

export function Board() {
  const [usage, setUsage] = useState<UsageMeta>(EMPTY);
  useEffect(() => {
    // 用量接口没就绪时保留“尚未入账”
    api("/api/usage/me").then((d) => {
      if (!d.has_data) return;
      const t = d.total || {};
      setUsage({ input: fmtTok(t.input), output: fmtTok(t.output), cache: fmtTok(t.cache_read), turns: fmtTok(t.turns), cost: fmtCost(t.cost) });
    }).catch(() => {});
  }, [me.value?.id]);

  const sec = currentSection.value;
  const today = new Date(new Date().toDateString()).getTime() / 1000;
  const visible = sessions.value.filter((s) => sectionMatch(s.section_id, sec));
  const pending = visible.filter((s) => s.pending);
  const running = visible.filter((s) => s.running && !s.pending);
  const items = pending.reduce((n, s) => n + (s.pending || 0), 0);
  let title = "今天没有待确认", sub = "待确认的操作会出现在第一列。";
  if (items) { title = `${items} 项待确认`; sub = "点开第一列里的会话，同意或拒绝后再继续。"; }
  else if (running.length) { title = `${running.length} 个会话进行中`; sub = "Claude 还在台式机上干活。"; }
  const queue = [...pending, ...running];
  const todays = visible.filter((s) => s.updated >= today);
  const active = todays.filter((s) => s.pending || s.running);
  const done = todays.filter((s) => !s.pending && !s.running);
  const d = new Date();
  const root = roots.value[0] || "";
  const connected = conn.value === "open";
  const facts: Array<[string, string, string?]> = [
    ["日期", `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`],
    ["输入", usage.input],
    ["值守", me.value ? me.value.display_name : "—"],
    ["输出", usage.output],
    ["服务器", location.host],
    ["缓存", usage.cache],
    ["工作目录", root || "—", root],
    ["轮次", usage.turns],
    ["状态", connected ? "已连接" : token.value ? "重新连接中" : "—"],
    ["费用", usage.cost],
  ];
  const kb = kbToday.value;
  return (
    <section class="board">
      <header class="masthead">
        <div>
          <div class="kicker"><span>Projector · 综合部工作台</span></div>
          <h1>{title}</h1>
          <p class="sub">{sub}</p>
        </div>
        <dl class="facts">
          {facts.map(([k, v, tip]) => (
            <div key={k}><dt>{k}</dt><dd title={tip} style={k === "状态" && connected ? "color:var(--ok)" : undefined}>{v}</dd></div>
          ))}
        </dl>
      </header>
      <div class="cols">
        <section>
          <div class="sec-h"><span class="n">01</span><span class="t">待处理</span><span class="c">{queue.length}</span></div>
          {queue.length ? queue.map((s) => <Card key={s.id} s={s} />) : <div class="empty">没有待确认的操作</div>}
        </section>
        <section>
          <div class="sec-h"><span class="n">02</span><span class="t">今日会话</span><span class="c">{todays.length}</span></div>
          {active.map((s) => <Card key={s.id} s={s} />)}
          {done.length > 0 && <div class="empty">已完成 {done.length}</div>}
          {!todays.length && <div class="empty">今天还没有会话</div>}
        </section>
        <section>
          <div class="sec-h"><span class="n">03</span><span class="t">今日知识库</span><span class="c">{kb.length}</span></div>
          {kb.length
            ? kb.map((r) => (
              <a key={r.path} class="dcard" onClick={() => openNote(r.path)}>
                <h4><Icon name="book" size={14} /><span class="t">{r.title || baseName(r.path || "")}</span></h4>
                <div class="ft"><span>{r.type || r.note || "知识库"}</span><span>{typeof r.created === "number" ? hm(r.created) : ""}</span></div>
              </a>
            ))
            : <div class="empty">今天还没有新增知识库内容</div>}
        </section>
      </div>
    </section>
  );
}
