// 用量页签：本月 / 上月 / 全部，汇总和按用户的表，导出 CSV。
import { fmtCost, fmtTok } from "../../lib/format";
import { loadAdminUsage, usageCsv, usageData, usageError, usageRange, usageState } from "../../stores/admin";
import type { UsageRange } from "../../stores/usage";
import { toast } from "../../stores/ui";

const RANGES: Array<[UsageRange, string]> = [["month", "本月"], ["last", "上月"], ["all", "全部"]];

function exportCsv(): void {
  const csv = usageCsv();
  if (csv === null) { toast("没有可导出的数据", "err"); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "usage.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Body() {
  if (usageState.value === "loading") return <div class="empty">读取中…</div>;
  if (usageState.value === "error") return <div class="ad-err">{usageError.value}</div>;
  const d = usageData.value;
  if (!d || !d.has_data) return <div class="empty">还没有采集到用量</div>;
  const t = d.total || {};
  const stats: Array<[string, unknown]> = [["输入", t.input], ["输出", t.output], ["缓存读", t.cache_read], ["轮次", t.turns], ["费用", fmtCost(t.cost)]];
  const rows = d.by_user || [];
  return (
    <>
      <div class="ac-stats">
        {stats.map(([k, v]) => <div key={k} class="ac-stat"><div class="v">{String(v ?? "—")}</div><div class="l">{k}</div></div>)}
      </div>
      <table class="ledger ac-ledger ad-uledger">
        <thead><tr><th>用户</th><th>输入</th><th>输出</th><th>轮次</th><th>费用</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((u, i) => (
            <tr key={i}>
              <td class="nmc"><div class="nm"><span>{u.display_name || "#" + u.user_id}</span></div></td>
              <td class="num" data-l="输入">{fmtTok(u.input)}</td>
              <td class="num" data-l="输出">{fmtTok(u.output)}</td>
              <td class="num" data-l="轮次">{fmtTok(u.turns)}</td>
              <td class="num" data-l="费用">{fmtCost(u.cost)}</td>
            </tr>
          )) : <tr><td colSpan={5} class="ctr">区间内没有数据</td></tr>}
        </tbody>
      </table>
    </>
  );
}

export function UsageTab() {
  return (
    <>
      <div class="ad-seg-row">
        <div class="ad-seg">
          {RANGES.map(([k, label]) => <button key={k} type="button" class={usageRange.value === k ? "on" : ""} onClick={() => void loadAdminUsage(k)}>{label}</button>)}
        </div>
        <button class="btn sm" type="button" onClick={exportCsv}>导出 CSV</button>
      </div>
      <Body />
    </>
  );
}
