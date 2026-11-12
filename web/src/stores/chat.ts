// 当前会话的一切：会话对象、消息、正在进行的回复、确认、提问、本机文件夹。
// 事件（SSE）怎么分发在 events.ts；这里只提供“改状态”的函数，组件不直接碰事件。
import { batch, computed, signal } from "@preact/signals";
import { api, post } from "../lib/api";
import { requestNotifyPermission } from "../lib/desktop";
import type {
  Approval, AskState, Id, LiveData, Message, Question, ServerEvent, Session, SessionDetail, Tool,
} from "../lib/types";
import { replace } from "../router";
import { me } from "./auth";
import { refs, resetComposer, skill, workDir } from "./composer";
import { currentSection, upsertInList } from "./sessions";
import { toast } from "./ui";

// ---------- 状态 ----------

/** 当前会话 id；null 表示还没发第一条消息的新会话（或没打开会话） */
export const current = signal<Id | null>(null);
/** 当前会话对象（可能是别人的，管理员查看时） */
export const currentSess = signal<Session | null>(null);
/** 已载入的消息，只放最近一页起的一段；更新时总是换新数组（列表按消息 id 做 key） */
export const messages = signal<Message[]>([]);
/** 服务器上是否还有更早的消息 */
export const hasMore = signal(false);
/** ""=空闲  "loading"=正在取  "failed"=上次失败（留着按钮重试） */
export const olderState = signal<"" | "loading" | "failed">("");
export const loading = signal(false);

// 正在进行的回复：老代码里是一个 live 对象（null 表示没有）。这里拆成一个开关加三个 signal，
// 文字增量只动 liveText，思考块和工具步骤各自更新。
export const liveActive = signal(false);
export const liveText = signal("");
export const liveThinking = signal("");
export const liveTools = signal<Tool[]>([]);
/** “思考中”块是否被用户展开（要在重渲染后保持） */
export const thinkOpen = signal(false);
/** 实时步骤里已经显示过几步（只用来给新增的步骤播入场动画） */
export const liveSteps = signal(0);

export const approvals = signal<Approval[]>([]);
/** Claude 正在等你回答的问题（ask_user） */
export const questions = signal<Question[]>([]);
/** 每组问题的作答状态，按问题 id */
export const askState = signal<Record<string, AskState>>({});
/** 当前会话上传的本机文件夹 */
export const links = signal<Array<{ id: string; [k: string]: unknown }>>([]);
/** 当前会话详情快照的事件序号：seq 不大于它的会话事件已经包含在快照里，要忽略 */
export const snapSeq = signal(0);
/** 已经显示过的消息（只给新消息播入场动画）。不是 signal，组件渲染时读写 */
export const seen = new Set<number | string>();

export const isMine = computed(() => !currentSess.value || !me.value || currentSess.value.user_id === me.value.id);
export const isWaiting = computed(() => approvals.value.length > 0 || questions.value.length > 0);
/** 排队中的消息（还没写进聊天记录） */
export const queued = computed(() => currentSess.value?.queue || []);
/** 发送按钮是否在忙 */
export const sending = signal(false);

// ---------- 实时回复 ----------

export function setLive(d: Partial<LiveData> | null): void {
  batch(() => {
    liveActive.value = !!d;
    liveText.value = d?.text || "";
    liveThinking.value = d?.thinking || "";
    liveTools.value = d?.tools ? [...d.tools] : [];
  });
}
export const clearLive = (): void => setLive(null);
/** 没有实时回复时建一个空的（老代码的 live = live || newLive()） */
function ensureLive(): void {
  if (!liveActive.value) liveActive.value = true;
}

// ---------- 重置 ----------

/** 清空当前会话的一切（回到值班板、新会话、切换会话时） */
export function resetChat(): void {
  batch(() => {
    current.value = null;
    currentSess.value = null;
    messages.value = [];
    hasMore.value = false;
    olderState.value = "";
    clearLive();
    approvals.value = [];
    questions.value = [];
    links.value = [];
    snapSeq.value = 0;
    liveSteps.value = 0;
    thinkOpen.value = false;
    loading.value = false;
  });
  seen.clear();
}

// ---------- 取快照期间的事件缓冲 ----------
// 老代码的缺陷：取快照期间到达的事件按 snapSeq=0 应用到旧状态，随后被快照整体覆盖，快照之后产生的事件就丢了。
// 这里：取快照期间，属于这个会话的事件先存起来；快照应用后再逐个重放，seq 不大于 snapSeq 的由去重规则丢掉。
export const eventBuffer: { sid: Id | null; events: ServerEvent[] } = { sid: null, events: [] };
let replayHandler: ((ev: ServerEvent) => void) | null = null;
/** events.ts 注册：缓冲的事件用它重放 */
export function setReplayHandler(fn: (ev: ServerEvent) => void): void { replayHandler = fn; }
/** 这个会话的事件现在是不是该缓冲 */
export function shouldBuffer(sid: string | undefined): boolean {
  return !!sid && eventBuffer.sid === sid;
}

// ---------- 打开会话 ----------

/**
 * 打开会话。id 为 null 是新会话（还没发第一条）。
 * 取不到（不存在或无权）会抛错，调用方负责提示并回到首页。
 * 注意：事件在取快照期间到达时，按 snapSeq=0 应用到空状态，随后被快照覆盖（和老代码一样）。
 */
export async function openSession(id: Id | null): Promise<void> {
  const switching = id !== current.peek();
  batch(() => {
    current.value = id;
    snapSeq.value = 0;
    liveSteps.value = 0;
    // 换了会话才先清空，免得新标题下还显示上一个会话的内容；重取同一个会话（resync）时保留旧内容，取回来再替换，和老代码一致
    // 新会话（id 为 null）老代码也是整体清空
    if (switching || !id) {
      currentSess.value = null; messages.value = []; hasMore.value = false; olderState.value = "";
      clearLive(); approvals.value = []; questions.value = []; links.value = []; thinkOpen.value = false;
    }
  });
  seen.clear();
  eventBuffer.sid = null; eventBuffer.events = [];
  if (!id) return;
  loading.value = true;
  eventBuffer.sid = id;
  let replay: ServerEvent[] = [];
  try {
    const data = await api<SessionDetail>("/api/sessions/" + id);
    if (current.value !== id) return;
    batch(() => {
      snapSeq.value = data.seq || 0;
      thinkOpen.value = false;
      currentSess.value = data.session;
      messages.value = data.messages;
      hasMore.value = !!data.has_more;
      olderState.value = "";
      setLive(data.live);
      approvals.value = data.approvals;
      questions.value = data.questions || [];
    });
    const ls = await api(`/api/sessions/${id}/links`).catch(() => []);
    if (current.value === id) links.value = ls;   // 老代码这里没检查，切走了也会写进去
    if (eventBuffer.sid === id) replay = eventBuffer.events;
  } finally {
    if (eventBuffer.sid === id) { eventBuffer.sid = null; eventBuffer.events = []; }
    if (current.value === id) loading.value = false;
  }
  for (const ev of replay) replayHandler?.(ev);
}

/** 重新取当前会话（resync、断线重连后） */
export function reloadCurrent(): Promise<void> {
  const id = current.peek();
  return id ? openSession(id) : Promise.resolve();
}

// ---------- 更早的消息 ----------

/**
 * 加载更早的一页。返回是否真的并入了消息。
 * beforeApply：在消息数组被替换之前同步调用，组件用它记下 scrollHeight / scrollTop，
 * 渲染完后把滚动位置补上增加的高度（读者正在看的那条不动）。
 */
export async function loadOlder(beforeApply?: () => void): Promise<boolean> {
  const sid = current.value;
  if (!sid || !hasMore.value || olderState.value === "loading" || !messages.value.length) return false;   // 防并发/重复
  const before = messages.value[0].id;
  olderState.value = "loading";
  try {
    const data = await api<{ messages: Message[]; has_more: boolean }>(`/api/sessions/${sid}/messages?before=${before}&limit=100`);
    // 期间切了会话或整体重载过：这一页已经没用了
    if (current.value !== sid || !messages.value.length || messages.value[0].id !== before) return false;
    const have = new Set(messages.value.map((m) => m.id));
    beforeApply?.();
    batch(() => {
      messages.value = data.messages.filter((m) => !have.has(m.id)).concat(messages.value);
      hasMore.value = !!data.has_more;
      olderState.value = "";
    });
    return true;
  } catch {
    if (current.value === sid) olderState.value = "failed";   // 失败后不自动重试，点按钮重试
    return false;
  }
}

// ---------- 会话更新（session 事件、新建会话） ----------

const sessionListeners = new Set<(s: Session) => void>();
/** 订阅每一次会话更新（管理后台的聊天记录页签用它刷新列表） */
export function onSessionUpdate(fn: (s: Session) => void): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

/**
 * 一个会话更新了。skipList：列表快照比这个事件新，不覆盖列表项；
 * skipCurrent：当前会话的详情快照比这个事件新，不覆盖当前会话对象。
 */
export function upsertSession(s: Session, skipList = false, skipCurrent = false): void {
  if (!skipList) upsertInList(s);
  for (const fn of sessionListeners) fn(s);
  if (s.id === current.value && !skipCurrent) {
    batch(() => {
      currentSess.value = s;
      if (!s.running) { clearLive(); liveSteps.value = 0; }
    });
  }
}

// ---------- 事件对状态的修改（events.ts 调用） ----------

export function applyMessage(m: Message): void {
  batch(() => {
    if (!messages.value.some((x) => x.id === m.id)) messages.value = [...messages.value, m];
    if (m.role === "user") {
      setLive({ text: "", thinking: "", tools: [] });
      thinkOpen.value = false; liveSteps.value = 0; seen.delete("live");
    } else if (m.role !== "event") {
      clearLive(); liveSteps.value = 0;
    }
  });
}
export function applyApproval(a: Approval): void {
  if (!approvals.value.some((x) => x.id === a.id)) approvals.value = [...approvals.value, a];
}
export function applyApprovalDone(id: string): void {
  approvals.value = approvals.value.filter((a) => a.id !== id);
}
export function applyQuestion(q: Question): void {
  if (!questions.value.some((x) => x.id === q.id)) questions.value = [...questions.value, q];
}
export function applyQuestionDone(id: string): void {
  questions.value = questions.value.filter((q) => q.id !== id);
}
/** delta_reset：文字和思考清空，工具步骤保留 */
export function applyDeltaReset(): void {
  batch(() => {
    const tools = liveActive.value ? liveTools.value : [];
    setLive({ text: "", thinking: "", tools });
  });
}
export function applyDelta(text: string): void {
  batch(() => { ensureLive(); liveText.value += text; });
}
export function applyThinking(text: string): void {
  batch(() => { ensureLive(); liveThinking.value += text; });
}
export function applyTool(t: Tool): void {
  batch(() => { ensureLive(); liveTools.value = [...liveTools.value, t]; });
}

// ---------- 新建会话和发送 ----------

/** 没有当前会话就先建一个（发第一条消息时）。建好后把网址从 /s/new 换成 /s/{id} */
export async function ensureSession(title: string): Promise<Id> {
  if (current.value) return current.value;
  const s = await post<Session>("/api/sessions", {
    title: (title || "新会话").slice(0, 20), work_dir: workDir.value || null, section_id: currentSection.value,
  });
  batch(() => {
    current.value = s.id;
    currentSess.value = s;
    messages.value = []; hasMore.value = false; olderState.value = ""; approvals.value = []; links.value = [];
    workDir.value = "";
  });
  upsertSession(s);
  replace("/s/" + s.id, { force: true });
  return s.id;
}

/** 发送。返回是否发出去了；失败会弹提示条。输入框的清空由组件在返回 true 后做 */
export async function sendMessage(text: string): Promise<boolean> {
  text = text.trim();
  if (!text || sending.value) return false;
  sending.value = true;
  requestNotifyPermission();
  try {
    const sid = await ensureSession(text);
    const r = await post(`/api/sessions/${sid}/messages`, { text, refs: refs.value.map((x) => x.path), skill: skill.value });
    resetComposer();
    if (r && r.queued) toast("已加入排队，前面的完成后自动开始", "ok", 2000);   // 排队项由随后的 session 事件显示
    return true;
  } catch (e) {
    toast((e as Error).message, "err");
    return false;
  } finally { sending.value = false; }
}

// ---------- 其他会话操作 ----------

export function stopSession(): Promise<void> | undefined {
  const id = current.value;
  return id ? post(`/api/sessions/${id}/stop`).then(() => toast("已发送停止指令")) : undefined;
}

export function renameSession(title: string): Promise<unknown> | undefined {
  const id = current.value;
  return id && isMine.value && title ? post("/api/sessions/" + id, { title }, "PATCH") : undefined;
}

/** 完全放行开关（打开前的确认框由组件问）。失败抛错，由组件还原开关 */
export function setBypass(on: boolean): Promise<unknown> {
  return post("/api/sessions/" + current.value, { bypass: on }, "PATCH");
}

/** 删除会话（确认框由组件问）；列表里的移除由随后的 session_deleted 事件完成 */
export function deleteSession(id: Id): Promise<unknown> {
  return api("/api/sessions/" + id, { method: "DELETE" });
}

export function cancelQueued(qid: number | string): Promise<unknown> {
  return post(`/api/sessions/${current.value}/queue/${qid}`, null, "DELETE");
}

export function decideApproval(id: string, allow: boolean): Promise<unknown> {
  return post("/api/approvals/" + id, { allow });
}

// ---------- 提问面板的作答状态 ----------

const answered = (a: { selected: string[]; other: string }): boolean => a.selected.length > 0 || a.other.trim().length > 0;
export const isAnswered = answered;

function freshAsk(q: Question): AskState {
  return { step: 0, ans: q.questions.map(() => ({ selected: [], other: "", note: "" })) };
}
/** 取某组问题的作答状态（没有就建一个）。只读；改动用下面的函数 */
export function askOf(q: Question): AskState {
  return askState.value[q.id] || freshAsk(q);
}
function updateAsk(q: Question, fn: (st: AskState) => void): void {
  const old = askOf(q);
  const st: AskState = { step: old.step, ans: old.ans.map((a) => ({ ...a, selected: [...a.selected] })) };
  fn(st);
  askState.value = { ...askState.value, [q.id]: st };
}

export function askSetStep(step: number): void {
  const q = questions.value[0]; if (!q) return;
  updateAsk(q, (st) => { st.step = step; });
}
export function askSetOther(text: string): void {
  const q = questions.value[0]; if (!q) return;
  updateAsk(q, (st) => {
    const a = st.ans[st.step];
    a.other = text;
    if (a.other.trim() && !q.questions[st.step].multi_select) a.selected = [];
  });
}
export function askSetNote(text: string): void {
  const q = questions.value[0]; if (!q) return;
  updateAsk(q, (st) => { st.ans[st.step].note = text; });
}

/** 按数字键或点选项。多选是切换；单选是选中并清掉“其他”，不是最后一题则 260ms 后自动下一题 */
export function askPick(i: number): void {
  const q = questions.value[0]; if (!q) return;
  const st0 = askOf(q), item = q.questions[st0.step], o = item.options[i];
  if (!o) return;
  if (item.multi_select) {
    updateAsk(q, (st) => {
      const a = st.ans[st.step];
      a.selected = a.selected.includes(o.label) ? a.selected.filter((x) => x !== o.label) : [...a.selected, o.label];
    });
  } else {
    updateAsk(q, (st) => { const a = st.ans[st.step]; a.selected = [o.label]; a.other = ""; });
    if (st0.step < q.questions.length - 1) {
      setTimeout(() => { if (questions.value[0] === q) updateAsk(q, (st) => { st.step++; }); }, 260);   // 单选自动下一题
    }
  }
}

/**
 * 提交（或跳过）当前这组问题。成功后从 questions 里移除并清掉作答状态；
 * 失败抛出的错误在这里转成提示条，返回 false。提交前的“跳过？”确认框由组件问。
 */
export async function askSubmit(skipped = false): Promise<boolean> {
  const q = questions.value[0];
  if (!q) return false;
  const st = askOf(q);
  try {
    await post("/api/questions/" + q.id, {
      skipped, answers: st.ans.map((a) => ({ selected: a.selected, other: a.other.trim(), note: a.note.trim() })),
    });
    batch(() => {
      questions.value = questions.value.filter((x) => x.id !== q.id);
      const { [q.id]: _gone, ...rest } = askState.value;
      askState.value = rest;
    });
    toast(skipped ? "已跳过，Claude 会自己判断" : "已回答，Claude 继续干活", "ok", 2200);
    return true;
  } catch (e) {
    toast((e as Error).message, "err");
    return false;
  }
}
