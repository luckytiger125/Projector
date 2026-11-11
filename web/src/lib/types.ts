// 后端数据的类型。字段按接口现状写，没把握的标成可选；以后端为准。

export type Id = string;

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "user" | string;
  avatar: string;
  can_bypass?: boolean;
  [k: string]: unknown;
}

export interface Section {
  id: number;
  name: string;
  archived?: boolean;
  [k: string]: unknown;
}

export interface QueuedMessage { id: number | string; text: string }

export interface Session {
  id: Id;
  title: string;
  user_id: number;
  created: number;
  updated: number;
  running?: boolean;
  pending?: number;
  /** pending / running / queued / stopped / done / idle */
  status?: string;
  claude_session?: string | null;
  message_count?: number;
  file_count?: number | null;
  duration_seconds?: number | null;
  section_id?: number | null;
  section_name?: string;
  bypass?: boolean | number;
  work_dir?: string;
  owner?: string;
  owner_avatar?: string;
  queue?: QueuedMessage[];
  [k: string]: unknown;
}

export interface Tool { name: string; detail?: string }

/** 正在进行的回复（服务端 live 快照、事件累积的结果形状相同） */
export interface LiveData { text: string; thinking: string; tools: Tool[] }

export interface Message {
  id: number;
  role: "user" | "assistant" | "event" | "error" | string;
  content: string;
  created: number;
  meta?: Record<string, any>;
  [k: string]: unknown;
}

export interface Approval { id: string; session_id: Id; summary: string; [k: string]: unknown }

export interface QuestionOption { label: string; description?: string }
export interface QuestionItem {
  question: string;
  header?: string;
  multi_select?: boolean;
  options: QuestionOption[];
}
export interface Question { id: string; session_id: Id; questions: QuestionItem[]; [k: string]: unknown }

export interface AskAnswer { selected: string[]; other: string; note: string }
export interface AskState { step: number; ans: AskAnswer[] }

export interface SessionDetail {
  seq: number;
  session: Session;
  messages: Message[];
  has_more: boolean;
  live: Partial<LiveData> | null;
  approvals: Approval[];
  questions?: Question[];
}

/** SSE 事件。type 以外的字段按类型取用；seq 由服务端在 broadcast 时加上。 */
export interface ServerEvent {
  type: string;
  seq?: number;
  session_id?: Id;
  session?: Session;
  message?: Message;
  approval?: Approval;
  question?: Question;
  id?: string;
  text?: string;
  name?: string;
  detail?: string;
  [k: string]: unknown;
}
