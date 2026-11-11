// 启动和进入应用：把各个 store 串起来的编排。和老代码 enter() / 启动那几行对应。
// 本模块 import 时没有副作用；第二步由 main.tsx 调用 startApp()。
import { me, bootstrapAuth } from "./auth";
import type { User } from "../lib/types";
import { resetChat } from "./chat";
import { loadSkills, resetComposer } from "./composer";
import { connect } from "./events";
import { resetFiles } from "./files";
import { loadSections, resetSessions } from "./sessions";

const enterHooks = new Set<(u: User) => void>();
/** 进入应用时额外要做的事（老代码里：kbInit、首页用量），桥接层接上 */
export function onEnter(fn: (u: User) => void): () => void {
  enterHooks.add(fn);
  return () => enterHooks.delete(fn);
}

/** 登录成功或启动取到用户后调用：重置所有状态，取分区和技能，连事件流（连上后第一次 open 会拉会话列表） */
export function enterApp(user: User): void {
  // 先重置，再设 me：设 me 会触发路由同步去取当前网址对应的会话，不能被后面的重置清掉
  resetSessions();
  resetChat();
  resetComposer();
  resetFiles();
  me.value = user;
  void loadSections();
  for (const fn of enterHooks) fn(user);
  connect();
  void loadSkills();
}

/** 启动：有令牌就补种 cookie、取 /api/me、进入应用；没有令牌显示登录页（登录成功后由登录组件调用 enterApp） */
export async function startApp(): Promise<void> {
  const u = await bootstrapAuth();
  if (u) enterApp(u);
}
