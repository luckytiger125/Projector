// 首页：顶上一片缓慢漂浮的“星空”（笔记少于 6 条时是装饰用的假星空），统计、使用说明、最近更新、常被提到、还没写的、标签。
import { useEffect, useRef } from "preact/hooks";
import { api } from "../../lib/api";
import { rel } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { KB_TYPES, filterNotes, kbData, kbSection, kcls, openNote, sectionMatch, visibleNotes } from "../../stores/kb";
import { openByName } from "./actions";
import { KGraph } from "./graph";
import type { GData } from "./graph";

/** 数字从 0 涨到目标值。文字先写成最终值（动画不走时也对），动画开始时才从 0 起 */
function Count({ to }: { to: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const e = el.current;
    if (!e || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 900);
      e.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <div class="v" ref={el}>{to}</div>;
}

/** 首页顶上的星空：笔记够多就画真的图谱缩影，不够就画一片装饰用的星 */
function Sky({ real }: { real: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const section = kbSection.value;
  useEffect(() => {
    let live = true;
    let g: KGraph | null = null;
    void (async () => {
      let data: GData | null = null;
      if (real) {
        try { data = await api<GData>("/api/kb/graph" + (section ? "?section=" + encodeURIComponent(section) : "")); } catch { data = null; }
      }
      if (!live || !canvas.current) return;
      if (!data) {
        const types = ["经验", "文件卡片", "主题"], nodes: GData["nodes"] = [], edges: GData["edges"] = [];
        for (let i = 0; i < 26; i++) nodes.push({ id: "d" + i, title: "", type: types[i % 3], deg: 1 + (i % 4) });
        for (let i = 1; i < 26; i++) edges.push(["d" + i, "d" + Math.floor(Math.random() * i)]);
        data = { nodes, edges };
      }
      g = new KGraph(canvas.current, data, { mini: true });
    })();
    return () => { live = false; g?.stop(); };
  }, [real, section]);
  return <canvas class="kh-sky" ref={canvas} aria-hidden="true" />;
}

export function Home() {
  const d = kbData.value!;
  const visible = visibleNotes.value;
  const by: Record<string, number> = {};
  for (const n of visible) by[n.type] = (by[n.type] || 0) + 1;
  const week = visible.filter((n) => n.mtime >= Date.now() / 1000 - 7 * 86400).length;
  const stale = visible.filter((n) => n.source_state);
  const tiles: Array<[string, number, string, string]> = [
    ["经验", by["经验"] || 0, "exp", "做过的事和做法"], ["文件卡片", by["文件卡片"] || 0, "card", "重要文件的摘要"],
    ["主题", by["主题"] || 0, "topic", "项目、客户、产品"], ["本周更新", week, "week", "7 天内新增或修改"],
  ];
  const paths = new Set(visible.map((n) => n.path));
  const recent = (d.recent || []).filter((r) => paths.has(r.path));
  const typeOf = (p: string) => d.notes.find((n) => n.path === p)?.type;
  return (
    <div class="pane kb-home">
      <div class="kh-hero">
        <Sky real={visible.length >= 6} />
        <div class="kh-copy">
          <div class="kh-kick">TEAM MEMORY</div>
          <h2 class="kh-h">大家做过的事，<em>都记在这里</em></h2>
          <p>Claude 回答问题前会先翻一翻这里。聊完点<b>“沉淀经验”</b>，或在文件库里点<b>“整理进知识库”</b>，它就会越来越懂你们的工作。</p>
        </div>
      </div>
      <div class="kh-stats">
        {tiles.map(([l, v, c, s]) => (
          <div key={l} class={`kh-stat k-${c}` + (c !== "week" ? " link" : "")} role={c !== "week" ? "button" : undefined} tabIndex={c !== "week" ? 0 : undefined}
            onClick={c !== "week" ? () => filterNotes({ type: l }) : undefined}
            onKeyDown={c !== "week" ? (e) => { if (e.key === "Enter") filterNotes({ type: l }); } : undefined}>
            <Count to={v} /><div class="l">{l}</div><small>{s}</small>
          </div>
        ))}
      </div>
      {visible.length < 6 && (
        <div class="kh-how">
          <div><span>1</span><b>聊完一件事</b><small>在 Claude 的回答下面点“沉淀成经验”，它会把做法整理成一条笔记</small></div>
          <div><span>2</span><b>整理重要文件</b><small>文件库里选中文件或文件夹，点“整理进知识库”，Claude 读完后写成文件卡片</small></div>
          <div><span>3</span><b>以后直接问</b><small>“上次和客户 A 的合同在哪”——Claude 会先查知识库，再去打开原文件</small></div>
        </div>
      )}
      <div class="kh-grid">
        <div class="kh-col">
          <h3><Icon name="clock" size={14} />最近更新</h3>
          <div class="kh-feed">
            {recent.length ? recent.map((r, i) => (
              <div key={r.path + i} class={`kh-ev k-${kcls(typeOf(r.path))}` + (r.exists ? "" : " gone")} style={`animation-delay:${Math.min(i, 12) * 30}ms`}
                role={r.exists ? "button" : undefined} tabIndex={r.exists ? 0 : undefined}
                onClick={r.exists ? () => openNote(r.path) : undefined} onKeyDown={r.exists ? (e) => { if (e.key === "Enter") openNote(r.path); } : undefined}>
                <span class="kh-evd" />
                <div><b>{r.title}</b><small>{r.by_name} · {r.note || "修改"} · {rel(r.created || 0)}</small></div>
              </div>
            )) : <div class="kb-hint">还没有动静。第一条经验往往来自一次顺利完成的对话。</div>}
          </div>
        </div>
        <div class="kh-col">
          {stale.length > 0 && <>
            <h3><Icon name="alert" size={14} />原文件改过的卡片</h3>
            <div class="kh-list">
              {stale.slice(0, 6).map((n) => (
                <a key={n.path} role="button" tabIndex={0} onClick={() => openNote(n.path)}>{n.title}<span class="tag warn">{n.source_state === "missing" ? "原文件不在了" : "可能过时"}</span></a>
              ))}
            </div>
          </>}
          {d.hubs.length > 0 && <>
            <h3><Icon name="sparkle" size={14} />常被提到</h3>
            <div class="kh-chips">
              {d.hubs.map((h) => <a key={h.path} class={"kchip k-" + kcls(h.type)} role="button" tabIndex={0} onClick={() => openNote(h.path)}>{h.title}<i>{h.backlinks}</i></a>)}
            </div>
          </>}
          {d.ghosts.length > 0 && <>
            <h3><Icon name="plus" size={14} />被提到但还没写的</h3>
            <div class="kh-chips">
              {d.ghosts.map((g) => <a key={g.name} class="kchip ghost" role="button" tabIndex={0} onClick={() => void openByName(g.name)}>{g.name}<i>{g.count}</i></a>)}
            </div>
          </>}
          {d.tags.length > 0 && <>
            <h3><Icon name="search" size={14} />标签</h3>
            <div class="kh-tags">
              {d.tags.map(([t, c]) => <a key={t} role="button" tabIndex={0} style={`font-size:${Math.min(12 + c * 1.2, 19)}px`} onClick={() => filterNotes({ tag: t })}>#{t}</a>)}
            </div>
          </>}
          {!stale.length && !d.hubs.length && !d.ghosts.length && !d.tags.length && <div class="kb-hint">笔记多起来以后，这里会显示常被提到的主题、标签和需要更新的卡片。</div>}
        </div>
      </div>
    </div>
  );
}
