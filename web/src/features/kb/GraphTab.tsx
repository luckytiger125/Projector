// 关系图谱：画布（力导向布局、拖动、缩放、点节点打开笔记）、按类型隐藏的工具条、图例。画布代码在 graph.ts，命令式，这里只负责创建和停掉。
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api";
import { Icon } from "../../lib/icons";
import { KB_TYPES, kbHidden, kbSection, kcls, openNote } from "../../stores/kb";
import { toast } from "../../stores/ui";
import { openByName } from "./actions";
import { KGraph } from "./graph";
import type { GData } from "./graph";

export function Graph() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const g = useRef<KGraph | null>(null);
  const [data, setData] = useState<GData | null>(null);
  const section = kbSection.value;
  const hidden = kbHidden.value;

  // 取数据：换分区重新取
  useEffect(() => {
    let live = true;
    setData(null);
    api<GData>("/api/kb/graph" + (section ? "?section=" + encodeURIComponent(section) : ""))
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => toast(e.message, "err"));
    return () => { live = false; };
  }, [section]);

  // 画：数据或隐藏的类型变了就重画（重新布局，和老代码一样）；离开页签、关掉弹层时停掉动画
  const nodes = data ? data.nodes.filter((n) => !hidden.has(n.type === "ghost" ? "ghost" : n.type)) : [];
  useEffect(() => {
    if (!data || !canvas.current) return;
    const ids = new Set(nodes.map((n) => n.id));
    const graph = new KGraph(canvas.current, { nodes, edges: data.edges.filter(([a, b]) => ids.has(a) && ids.has(b)) }, {
      onClick: (n) => { if (n.type === "ghost") void openByName(n.title); else openNote(n.id); },
    });
    g.current = graph;
    return () => { graph.stop(); if (g.current === graph) g.current = null; };
  }, [data, hidden]);
  const toggle = (k: string) => {
    const s = new Set(hidden);
    if (s.has(k)) s.delete(k); else s.add(k);
    kbHidden.value = s;
  };
  return (
    <div class="pane kb-graph">
      <canvas class="kb-canvas" ref={canvas} role="img" aria-label="笔记之间的关系图" />
      <div class="gtools">
        {Object.keys(KB_TYPES).concat(["还没写的"]).map((t) => {
          const key = t === "还没写的" ? "ghost" : t;
          return <button key={key} type="button" class={"gt" + (hidden.has(key) ? "" : " on")} onClick={() => toggle(key)}><i class={"k-" + kcls(key)} />{t}</button>;
        })}
        <button type="button" class="gt" onClick={() => g.current?.fit(true)}><Icon name="eye" size={13} />看全部</button>
      </div>
      <div class="glegend">{data && !nodes.length ? "还没有笔记，所以图谱是空的" : "拖动画布移动，滚轮缩放，点圆点打开笔记"}</div>
    </div>
  );
}
