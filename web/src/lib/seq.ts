// SSE 事件序号去重的纯逻辑（不依赖任何状态，方便测试）。
// 规则照老代码 connect() 里的实现，一条都没改：
//  - 当前会话的事件如果 seq 不大于详情快照的 snapSeq，效果已经包含在快照里，要丢掉（session 事件除外）；
//  - session 事件交给 upsertSession，由两个 skip 标志决定要不要覆盖列表项和当前会话：
//    列表项：seq <= listSeq 时不覆盖（列表快照比这个事件新）；
//    当前会话：属于当前会话且 seq <= snapSeq 时不覆盖。

import type { ServerEvent } from "./types";

/** 事件属于哪个会话：session_id / approval.session_id / question.session_id / session.id，按这个顺序取第一个有值的 */
export function eventSessionId(ev: ServerEvent): string | undefined {
  return ev.session_id || ev.approval?.session_id || ev.question?.session_id || ev.session?.id || undefined;
}

/** 非 session 事件：属于当前会话且序号不比快照新，就该丢掉 */
export function isCoveredBySnapshot(ev: ServerEvent, current: string | null, snapSeq: number): boolean {
  const sid = eventSessionId(ev);
  return !!(ev.seq && sid && sid === current && ev.seq <= snapSeq && ev.type !== "session");
}

/** session 事件的两个 skip 标志。注意 seq 缺失时 `undefined <= n` 为 false，即不跳过 */
export function sessionEventSkips(ev: ServerEvent, current: string | null, snapSeq: number, listSeq: number): { skipList: boolean; skipCurrent: boolean } {
  const seq = ev.seq as number;
  return {
    skipList: seq <= listSeq,
    skipCurrent: eventSessionId(ev) === current && seq <= snapSeq,
  };
}
