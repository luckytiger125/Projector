// 步骤记录：这次对话的完整过程。桌面上是盖在对话上的册页，手机上是全屏页。
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api";
import { Icon } from "../../lib/icons";
import { closeOverlay, overlayRoute } from "../../router";

interface Step { kind: string; name?: string; text: string; error?: boolean }
const LABEL: Record<string, string> = { user: "用户", assistant: "CLAUDE", thinking: "思考", tool_use: "调用工具", tool_result: "工具返回" };

export function StepsPage() {
  const r = overlayRoute.value;
  const id = r && r.name === "steps" ? r.id : null;
  const [data, setData] = useState<{ note?: string; steps: Step[] } | null>(null);
  const [err, setErr] = useState("");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setData(null); setErr("");
    if (!id) return;
    let live = true;
    api(`/api/sessions/${id}/transcript`).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { if (data && body.current) body.current.scrollTop = body.current.scrollHeight; }, [data]);
  if (!id) return null;
  return (
    <div class="veil" onMouseDown={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}>
      <div class="sheet">
        <div class="sheet-head">
          <button class="icon-btn m-back" title="返回" aria-label="返回" onClick={() => closeOverlay()}><Icon name="chevL" size={20} /></button>
          <div class="ttl"><div class="kicker"><span>记录</span></div><h3>完整过程</h3></div>
          <span class="note">{data?.note || ""}</span>
          <button class="icon-btn x" title="关闭" aria-label="关闭" onClick={() => closeOverlay()}><Icon name="x" size={18} /></button>
        </div>
        <div class="sheet-bar" />
        <div class="steps-body" ref={body}>
          {!data && !err && <div class="empty">读取中…</div>}
          {err && <div class="err">{err}</div>}
          {data && !data.steps.length && <div class="empty">没有记录</div>}
          {data?.steps.map((s, i) => (
            <div key={i} class={`step ${s.kind} ${s.error ? "err" : ""}`} style={`animation-delay:${Math.min(i, 20) * 15}ms`}>
              <div class="k">{LABEL[s.kind] || s.kind}{s.name ? " · " + s.name : ""}</div>
              <pre>{s.text}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
