// 步骤记录：这次对话的完整过程。桌面上是盖在对话上的册页，手机上是全屏页。
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/api";
import { Sheet } from "../../components/Sheet";
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
    <Sheet kicker="记录" title="完整过程" note={data?.note || ""} onClose={() => closeOverlay()}>
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
    </Sheet>
  );
}
