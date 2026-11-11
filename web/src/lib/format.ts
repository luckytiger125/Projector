// 时间、大小、路径缩写等小工具。从老代码搬来，行为不变。
// 需要“现在”的函数都接受可选的 now 参数，方便测试。

export function fsize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(1) + " GB";
}

export const pad = (n: number): string => String(n).padStart(2, "0");
/** t 是秒级时间戳 */
export const fdate = (t: number): string => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const ftime = (t: number): string => {
  const d = new Date(t * 1000);
  return `${fdate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const hm = (t: number): string => {
  const d = new Date(t * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 相对时间：今天显示时分，昨天，N 天前（7 天内），更早显示 月/日 */
export function rel(t: number, now: Date = new Date()): string {
  const d = new Date(t * 1000);
  const day = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (day === 0) return hm(t);
  if (day === 1) return "昨天";
  if (day < 7) return day + " 天前";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function fmtDuration(sec: unknown): string {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "—";
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
}

export const localYmd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const fmtCost = (v: unknown): string =>
  v === null || v === undefined ? "未采集费用" : Number(v) === 0 ? "0（估算）" : `$${Number(v).toFixed(4)}（估算）`;
export const fmtTok = (v: unknown): string => (v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-CN"));

/** 问候语（按小时） */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}

/**
 * 把文件库、工作区下的完整路径缩短成“文件库/…”“工作区/…”。
 * roots：[文件库根, 工作区根]（/api/files 返回的 roots）。
 */
export function shortPath(p: string | undefined, roots: string[]): string | undefined {
  if (!p) return p;
  const names = ["文件库", "工作区"];
  for (const i of [1, 0]) {   // 工作区可能在文件库里面，先认工作区
    if (!roots[i]) continue;
    const root = roots[i].replace(/[\\/]$/, "");
    if (p.toLowerCase().startsWith(root.toLowerCase())) {
      let rest = p.slice(root.length).replace(/^[\\/]/, "").replaceAll("\\", "/");
      if (i === 1) rest = rest.split("/").slice(2).join("/");   // 去掉用户和会话两层
      return names[i] + "/" + rest;
    }
  }
  return p;
}

/** 工具名 → [中文名, 图标名] */
export const TOOL_META: Record<string, [string, string]> = {
  Read: ["读取", "book"], Glob: ["查找文件", "search"], Grep: ["搜索内容", "search"], Edit: ["修改", "edit"], MultiEdit: ["修改", "edit"],
  Write: ["写入", "file"], Bash: ["运行命令", "terminal"], WebFetch: ["打开网页", "globe"], Skill: ["使用技能", "puzzle"],
  Task: ["子任务", "bolt"], TodoWrite: ["列计划", "steps"], NotebookEdit: ["修改笔记本", "edit"],
  mcp__center__kb_search: ["查知识库", "book"], mcp__center__kb_read: ["读笔记", "book"], mcp__center__kb_write: ["写进知识库", "book"],
  mcp__center__read_document: ["读文档", "file"], mcp__center__ask_user: ["问你", "chat"],
  mcp__center__skill_list: ["查技能", "puzzle"], mcp__center__skill_checkout: ["取出技能", "puzzle"], mcp__center__skill_submit: ["提交技能", "puzzle"],
};

export function toolMeta(name: string): [string, string] {
  return TOOL_META[name] || [name.replace(/^mcp__\w+__/, ""), "bolt"];
}

/** 会话状态 → [文字, 样式类] */
export function sessStatus(
  s: { status?: string; pending?: unknown; running?: unknown; claude_session?: unknown; message_count?: unknown } | null | undefined,
): [string, string] {
  const map: Record<string, [string, string]> = {
    pending: ["待确认", "wait"], running: ["进行中", "run"], queued: ["排队中", "off"], stopped: ["已停止", "off"], done: ["已完成", "done"],
  };
  if (s && s.status && map[s.status]) return map[s.status];
  if (s && s.pending) return ["待确认", "wait"];
  if (s && s.running) return ["进行中", "run"];
  if (s && !s.claude_session && !s.message_count) return ["未开始", "off"];
  return ["已完成", "done"];
}
