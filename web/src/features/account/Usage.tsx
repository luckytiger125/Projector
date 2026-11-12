// 我的用量：本月 / 上月 / 全部，汇总、按模型、最近 20 轮。网址 /usage，数据在 stores/usage.ts。
import { Sheet } from "../../components/Sheet";
import type { SheetTab } from "../../components/Sheet";
import { fmtCost, fmtTok } from "../../lib/format";
import { closeOverlay, overlayRoute } from "../../router";
import { me } from "../../stores/auth";
import { data, error, loadUsage, range, state } from "../../stores/usage";
import type { UsageData, UsageRange } from "../../stores/usage";

const RANGES: Array<[UsageRange, string]> = [["month", "本月"], ["last", "上月"], ["all", "全部"]];

function Body({ d }: { d: UsageData }) {
  const t = d.total || {};
  const stats: Array<[string, unknown]> = [["输入", t.input], ["输出", t.output], ["缓存读", t.cache_read], ["轮次", t.turns], ["费用", fmtCost(t.cost)]];
  const models = d.by_model || [];
  const turns = d.turns || [];
  return (
    <>
      <div class="ac-stats">
        {stats.map(([k, v]) => <div key={k} class="ac-stat"><div class="v">{String(v ?? "—")}</div><div class="l">{k}</div></div>)}
      </div>
      {models.length > 0 && (
        <>
          <h4 class="sk-h">按模型</h4>
          <table class="ledger ac-ledger">
            <thead><tr><th>模型</th><th>输入</th><th>输出</th><th>费用</th></tr></thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={i}>
                  <td class="nmc"><div class="nm"><span>{m.model || "unknown"}</span></div></td>
                  <td class="num" data-l="输入">{fmtTok(m.input)}</td>
                  <td class="num" data-l="输出">{fmtTok(m.output)}</td>
                  <td class="num" data-l="费用">{fmtCost(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {turns.length > 0 && (
        <>
          <h4 class="sk-h">最近轮次</h4>
          <table class="ledger ac-ledger ac-turns">
            <thead><tr><th>会话</th><th>内容</th><th>输入</th><th>输出</th><th>费用</th></tr></thead>
            <tbody>
              {turns.map((x, i) => (
                <tr key={i}>
                  <td class="nmc"><div class="nm"><span title={x.session_title || ""}>{x.session_title || ""}</span></div></td>
                  <td class="sub ac-pv" title={x.preview || ""}>{x.preview || ""}</td>
                  <td class="num" data-l="输入">{fmtTok(x.input)}</td>
                  <td class="num" data-l="输出">{fmtTok(x.output)}</td>
                  <td class="num" data-l="费用">{fmtCost(x.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p class="note-hint ac-foot">token 是模型调用量，不等于套餐额度；费用为估算值；cache read 单价更低。</p>
    </>
  );
}

export function UsageSheet() {
  const r = overlayRoute.value;
  if (!r || r.name !== "usage" || !me.value) return null;
  const tabs: SheetTab[] = RANGES.map(([k, label]) => ({ key: k, label, on: range.value === k, onClick: () => { void loadUsage(k); } }));
  const d = data.value;
  let body;
  if (state.value === "loading") body = <div class="empty">读取中…</div>;
  else if (state.value === "error") body = <div class="empty">用量接口还没就绪：{error.value}</div>;
  else if (!d || !d.has_data) body = <div class="empty">还没有采集到用量</div>;
  else body = <Body d={d} />;
  return (
    <Sheet class="ac" kicker="Projector · 综合部工作台" title="我的用量" tabs={tabs} onClose={() => closeOverlay()}>
      <div class="pane">{body}</div>
    </Sheet>
  );
}
