"""用 claude-agent-sdk 的常驻会话运行 Claude Code（runner_mode=sdk 时用；默认的 cli 模式不经过这里）。
每个会话一个常驻客户端，轮与轮之间不重启 claude 进程。设计见 docs/plans/2026-11-agent-sdk.md。

本文件不 import runner（runner 把这一轮要用的东西装进 TurnSpec 传进来），也不在模块顶层 import claude_agent_sdk：
没装这个包时服务照常启动，只有 sdk 模式下发消息才会报错（见 availability / unavailable_message）。

所有状态（客户端池 _POOL）只在事件循环线程里读写，不加线程锁。
每个客户端由一个专属任务（_Client._owner）负责 connect → 读消息 → disconnect（SDK 要求同一个异步上下文里连接和断开）。
目标机是 Python 3.10：不用 asyncio.timeout / TaskGroup / ExceptionGroup，超时一律 asyncio.wait_for。
"""
import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import approvals
import events  # noqa: F401
import guard
import store
import usage  # noqa: F401


class SdkUnavailable(Exception):
    """sdk 模式用不了（没装包、找不到原生 claude.exe 等）；消息是给管理员看的中文原因。"""


def _load_sdk():
    """晚导入 claude_agent_sdk 并返回模块（测试会 monkeypatch 这个函数）。"""
    import claude_agent_sdk
    return claude_agent_sdk


def availability() -> str | None:
    """None 表示 sdk 可用；否则返回中文原因。"""
    try:
        _load_sdk()
    except ImportError:
        return "没有安装 claude-agent-sdk（在服务目录下运行 pip install -r requirements-sdk.txt）"
    except Exception as e:
        return f"claude-agent-sdk 加载失败：{e}"
    return None


UNAVAILABLE_HINT = "请让管理员在设置里把运行方式切回 cli（或在 config.bat 里设 RUNNER_MODE=cli 并清掉设置）"


def unavailable_message(reason: str) -> str:
    return f"sdk 模式不可用：{reason}。{UNAVAILABLE_HINT}"


@dataclass
class TurnSpec:
    """runner 为这一轮准备好的全部输入（sdk_runner 不依赖 runner）。"""
    sid: str
    owner_id: int
    cli_path: str
    cwd: str
    add_dirs: list = field(default_factory=list)
    hint_file: str = ""                       # 附加提示词文件
    disallowed: list = field(default_factory=list)   # AskUserQuestion + deny 规则 + 被进程内工具替换的两个外部工具
    allowed: list = field(default_factory=list)      # 自动放行名单（完全放行档为空）
    bypass: bool = False                      # 完全放行档
    ask_rules: list = field(default_factory=list)    # 标准档的 ask 规则
    mcp_center: dict = field(default_factory=dict)   # 外部工具服务 approval_mcp.py 的 stdio 配置
    plugin_dir: str | None = None
    resume: str | None = None
    policy: Callable[[], guard.Policy] | None = None  # 每次工具调用时现取，新建的账号立刻生效
    timeout: float = 3600.0
    log_path: str = ""


# ---------- 参数和小工具 ----------

STOP_GRACE = 5.0            # 停止：interrupt 之后最多等这一轮自己收尾多久（测试可改小）
DISCONNECT_TIMEOUT = 20.0   # disconnect() 最多等多久
STDERR_KEEP = 50            # 保留最近多少行 stderr 给报错用
MAX_BUFFER = 32 * 1024 * 1024

_DEAD = object()            # 放进轮次队列的哨兵：客户端进程没了


def _env_float(name: str, default: float) -> float:
    try:
        v = float(os.environ.get(name) or default)
    except ValueError:
        return default
    return v if v > 0 else default


def connect_timeout() -> float:
    return _env_float("SDK_CONNECT_TIMEOUT", 120.0)


def max_clients() -> int:
    try:
        n = int(os.environ.get("SDK_MAX_CLIENTS") or 8)
    except ValueError:
        n = 8
    return max(1, n)


def idle_seconds() -> int:
    """空闲多久后关掉：管理员设置 sdk_idle_seconds > 环境变量 SDK_IDLE_SECONDS > 600；限制在 30~86400（和 runner.sdk_idle_seconds 同一规则）。"""
    try:
        default = int(os.environ.get("SDK_IDLE_SECONDS") or 600)
    except ValueError:
        default = 600
    try:
        n = int(store.get_setting("sdk_idle_seconds", default))
    except (TypeError, ValueError):
        n = default
    return max(30, min(86400, n))


def _mode_is_sdk() -> bool:
    """当前运行方式是不是 sdk（和 runner.runner_mode 同一规则：设置 > 环境变量 > cli）。读不出来就当还是 sdk，别误关。"""
    try:
        raw = store.get_setting("runner_mode", None)
        if raw is None:
            raw = os.environ.get("RUNNER_MODE")
        return str(raw or "").strip().lower() == "sdk"
    except Exception:
        return True


def _is_windows() -> bool:
    return sys.platform == "win32"


def _tool_detail(args: dict) -> str:
    """和 runner._tool_detail 一样的规则（sdk_runner 不能 import runner）。"""
    for key in ("file_path", "path", "pattern", "url", "command", "skill", "query", "title", "name"):
        if args.get(key):
            return str(args[key])[:200]
    return ""


def _kill_pid_tree(pid: int) -> None:
    """杀掉 claude 进程；Windows 上连子进程一起（taskkill /T /F）。已经不在了不算错。测试里会被 monkeypatch。"""
    try:
        if _is_windows():
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
        else:
            os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
    except Exception:
        pass


def _append_log(path: str, text: str) -> None:
    """追加写日志；写不进去不能影响运行。"""
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8", errors="replace") as f:
            f.write(text)
    except Exception:
        pass


def resolve_cli(claude_bin: str) -> str:
    """SDK 拒绝运行 .cmd/.bat：Windows 上 find_claude 给的是这种包装时，找原生 claude.exe；找不到抛 SdkUnavailable。其他情况原样返回。"""
    if not _is_windows() or Path(claude_bin).suffix.lower() not in (".cmd", ".bat"):
        return claude_bin
    candidates = []
    found = shutil.which("claude.exe")
    if found:
        candidates.append(Path(found))
    candidates.append(Path.home() / ".local" / "bin" / "claude.exe")
    try:
        candidates.append(Path(_load_sdk().__file__).parent / "_bundled" / "claude.exe")
    except Exception:
        pass
    for p in candidates:
        try:
            if p.is_file():
                return str(p)
        except OSError:
            continue
    raise SdkUnavailable(f"sdk 模式需要原生的 claude.exe，这台电脑上找到的是 {claude_bin}。"
                         "请用官方安装脚本安装 Claude Code，或在 config.bat 里把 CLAUDE_BIN 指到 claude.exe")


def _loop_problem() -> str | None:
    """Windows 上 asyncio 起子进程需要 Proactor 事件循环；不是的话返回原因。"""
    if not _is_windows():
        return None
    proactor = getattr(asyncio, "ProactorEventLoop", None)
    if proactor is None or not isinstance(asyncio.get_running_loop(), proactor):
        return "服务当前的事件循环不支持启动子进程（Windows 上需要 ProactorEventLoop；不要用 --reload 或多进程方式启动服务）"
    return None


def _fingerprint(spec: TurnSpec, cli_path: str) -> str:
    """决定常驻客户端能不能复用的输入（不含 resume、policy、add_dirs：add_dirs 另按“子集”判断）。"""
    return json.dumps([cli_path, spec.owner_id, spec.cwd, spec.hint_file, spec.disallowed, spec.allowed, spec.bypass,
                       spec.ask_rules, spec.mcp_center, spec.plugin_dir], sort_keys=True, ensure_ascii=False, default=str)


# ---------- 回调：权限确认、文件隔离钩子、进程内 ask_user ----------

ASK_USER_DESCRIPTION = (
    "在用户的屏幕上弹出选项卡片，让用户点选，等用户回答后返回结果。\n"
    "需要用户在几个方案里做选择、或确认关键信息时使用；一次最多 4 个问题。\n"
    "不要用它问显而易见的事情，也不要在回答文字里列选项等用户打字回复。")

ASK_USER_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "description": "要问的问题，一次最多 4 个",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "完整的问题，以问号结尾"},
                    "header": {"type": "string", "description": "很短的标签，最多 6 个字，比如“模板”“范围”"},
                    "options": {
                        "type": "array",
                        "description": "2~4 个选项；用户总能另外选“其他”自己填写",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "选项文字，简短（推荐的选项在末尾加“（推荐）”）"},
                                "description": {"type": "string", "description": "一句话说明选这个会怎样"},
                            },
                            "required": ["label"],
                        },
                    },
                    "multi_select": {"type": "boolean", "description": "可以多选时设为 true"},
                },
                "required": ["question", "options"],
            },
        },
    },
    "required": ["questions"],
}


def _make_callbacks(sdk, spec: TurnSpec):
    """按会话绑定的三个回调：(can_use_tool, guard 钩子, ask_user 工具)。sid、owner_id、cwd 取自建客户端时的 spec；policy 每次调用现取。"""
    sid, owner_id = spec.sid, spec.owner_id

    async def can_use_tool(tool_name, tool_input, context=None):
        try:
            # 文件隔离的第二道（第一道是钩子）：涉及别人的个人文件或系统数据，不弹确认直接拒绝
            reason = guard.check_tool(spec.policy(), tool_name, tool_input, spec.cwd)
            if reason:
                approvals.reject_by_guard(sid, tool_name, tool_input)
                return sdk.PermissionResultDeny(message=reason)
            allow, message = await approvals.wait_approval(sid, owner_id, tool_name, tool_input)
            if allow:
                return sdk.PermissionResultAllow(updated_input=tool_input)
            return sdk.PermissionResultDeny(message=message or "用户拒绝了这个操作，不要重试同样的操作")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            return sdk.PermissionResultDeny(message=f"确认通道出错（{type(e).__name__}），这一步没有执行，可以让用户重发一次")

    async def guard_hook(input_data, tool_use_id=None, context=None):
        """PreToolUse：三档都生效（在权限判断之前，放行规则挡不住它）。出任何错都按拒绝处理。"""
        try:
            reason = guard.check_tool(spec.policy(), str(input_data.get("tool_name") or ""),
                                      input_data.get("tool_input") or {}, input_data.get("cwd") or spec.cwd)
        except Exception as e:
            reason = f"文件隔离检查出错，为安全起见已拒绝这次操作（{type(e).__name__}: {e}）。请告诉用户联系管理员。"
        if reason:
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                           "permissionDecisionReason": reason}}
        return {}

    async def ask_user(args):
        try:
            text = await approvals.wait_question(sid, owner_id, (args or {}).get("questions"))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            text = f"没能弹出问题（{type(e).__name__}），请直接在回答里问用户。"
        return {"content": [{"type": "text", "text": text}]}

    ask_tool = sdk.tool("ask_user", ASK_USER_DESCRIPTION, ASK_USER_SCHEMA)(ask_user)
    return can_use_tool, guard_hook, ask_tool


def build_options(sdk, spec: TurnSpec, *, cli_path: str, resume: str | None = None, stderr=None, block: bool = True):
    """拼 ClaudeAgentOptions（不连接）。block=False 时钩子不带 on_failure（旧版 claude 不认这个参数）。"""
    can_use_tool, guard_hook, ask_tool = _make_callbacks(sdk, spec)
    hook_kwargs = {"on_failure": "block"} if block else {}
    kwargs = dict(
        cli_path=cli_path,
        cwd=spec.cwd,
        add_dirs=list(spec.add_dirs),
        allowed_tools=list(spec.allowed),
        disallowed_tools=list(spec.disallowed),
        include_partial_messages=True,
        max_buffer_size=MAX_BUFFER,
        # 不传 system_prompt=None：那会清空默认提示词
        system_prompt={"type": "preset", "preset": "claude_code"},
        can_use_tool=can_use_tool,
        hooks={"PreToolUse": [sdk.HookMatcher(matcher=None, hooks=[guard_hook], **hook_kwargs)]},
        mcp_servers={"center": spec.mcp_center,
                     "projector": sdk.create_sdk_mcp_server("projector", tools=[ask_tool])},
        env={"MCP_TOOL_TIMEOUT": str(int(approvals.APPROVAL_TIMEOUT * 1000) + 60000), "MCP_TIMEOUT": "60000"},
    )
    if spec.hint_file:
        kwargs["extra_args"] = {"append-system-prompt-file": spec.hint_file}
    if resume:
        kwargs["resume"] = resume
    if spec.bypass:
        kwargs["permission_mode"] = "bypassPermissions"
    if spec.ask_rules:
        kwargs["settings"] = json.dumps({"permissions": {"ask": list(spec.ask_rules)}}, ensure_ascii=False)
    if spec.plugin_dir:
        kwargs["plugins"] = [{"type": "local", "path": spec.plugin_dir}]
    if stderr is not None:
        kwargs["stderr"] = stderr
    return sdk.ClaudeAgentOptions(**kwargs)


_shadow_silenced = False


def _silence_shadow_warning(sdk) -> None:
    """allowed_tools 里有整工具放行时 SDK 会发 CanUseToolShadowedWarning：这是我们有意的配置，压掉。
    警告是在 connect() 里（await 之后）发的，用 catch_warnings 包住 await 会让多个客户端互相覆盖过滤器，所以改成进程级只设一次。"""
    global _shadow_silenced
    cls = getattr(sdk, "CanUseToolShadowedWarning", None)
    if cls is not None and not _shadow_silenced:
        warnings.filterwarnings("ignore", category=cls)
        _shadow_silenced = True


# ---------- 常驻客户端 ----------

_POOL: dict[str, "_Client"] = {}
_BG: set = set()   # 后台任务的引用（防止被垃圾回收）


def _spawn(coro) -> "asyncio.Task":
    t = asyncio.get_running_loop().create_task(coro)
    _BG.add(t)
    t.add_done_callback(_BG.discard)
    return t


class _Client:
    """一个会话的常驻客户端。所有字段只在事件循环线程里读写。"""

    def __init__(self, sdk, spec: TurnSpec, fp: str, cli_path: str, resume: str | None):
        self.sdk = sdk
        self.sid = spec.sid
        self.spec = spec
        self.fp = fp
        self.cli_path = cli_path
        self.resume = resume
        self.dirs = set(spec.add_dirs)
        self.log_path = spec.log_path
        self.session_id = resume or None      # 已知的 claude 会话 id（ResultMessage 会更新）
        self.client = None
        self.proc = None
        self.pid: int | None = None
        self.dead = False
        self.error = ""                       # 死因
        self.busy = True                      # 建出来就是在忙（连接中也算），一轮结束后放开
        self.last_used = time.time()
        self.turn_q: asyncio.Queue | None = None
        self.turn_done: asyncio.Event | None = None
        self.stderr_tail: list[str] = []
        self.block = True
        self.connected = asyncio.get_running_loop().create_future()   # 结果：None=连上了，字符串=失败原因
        self._killed = False
        self.stopping = False                 # 用户点了停止、正在收尾：不能再被下一轮复用
        self._close_task = None
        self.task = asyncio.get_running_loop().create_task(self._owner())

    # --- 日志 / stderr ---

    def log(self, text: str) -> None:
        _append_log(self.log_path, text)

    def _on_stderr(self, line: str) -> None:
        line = line.rstrip("\r\n")
        self.stderr_tail.append(line)
        del self.stderr_tail[:-STDERR_KEEP]
        self.log("[stderr] " + line + "\n")

    def stderr_text(self) -> str:
        return "\n".join(self.stderr_tail).strip()[-300:]

    # --- 进程信息（私有属性，取不到就是 None）---

    def refresh_pid(self) -> None:
        if self.pid is None:
            proc = getattr(getattr(self.client, "_transport", None), "_process", None)
            if proc is not None:
                self.proc = proc
                self.pid = getattr(proc, "pid", None)

    def process_alive(self) -> bool:
        return self.proc is not None and getattr(self.proc, "returncode", 0) is None

    # --- 专属任务 ---

    def _set_connected(self, err) -> None:
        if not self.connected.done():
            self.connected.set_result(err)

    async def _connect(self) -> None:
        sdk = self.sdk
        _silence_shadow_warning(sdk)
        while True:
            options = build_options(sdk, self.spec, cli_path=self.cli_path, resume=self.resume,
                                    stderr=self._on_stderr, block=self.block)
            self.client = sdk.ClaudeSDKClient(options)
            try:
                await self.client.connect()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self.block and "on_failure" in str(e):
                    self.block = False
                    self.log("这个版本的 claude 不支持钩子失败即拒绝，改由回调自身兜底\n")
                    continue
                raise
            self.refresh_pid()
            return

    async def _owner(self) -> None:
        sdk = self.sdk
        try:
            self.log(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} [sdk] {self.cli_path} "
                     f"{'resume ' + self.resume if self.resume else '新会话'} ====\n")
            try:
                await self._connect()
            except asyncio.CancelledError:
                self._set_connected("连接被取消")
                raise
            except Exception as e:
                self.error = f"{type(e).__name__}: {e}"
                self.log(f"连接失败：{self.error}\n")
                self._set_connected(self.error)
                return
            self._set_connected(None)
            try:
                async for msg in self.client.receive_messages():
                    q = self.turn_q
                    if q is not None:   # 没有进行中的轮次就丢弃（后台通知之类的迟到消息不能混进下一轮）
                        q.put_nowait(msg)
                self.error = self.error or "claude 进程已退出"
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.error = f"{type(e).__name__}: {e}"
        finally:
            self.dead = True
            self.refresh_pid()
            if self.error:
                self.log(f"退出：{self.error}\n")
            if _POOL.get(self.sid) is self:
                del _POOL[self.sid]
            q = self.turn_q
            if q is not None:
                q.put_nowait(_DEAD)
            self._set_connected(self.error or "连接被取消")
            if self.client is not None:
                try:
                    await asyncio.wait_for(self.client.disconnect(), DISCONNECT_TIMEOUT)
                except asyncio.CancelledError:
                    raise
                except Exception as e:   # 含超时：吞掉，进程由 close() 最后的检查兜底
                    self.log(f"disconnect 出错：{type(e).__name__}: {e}\n")

    # --- 关闭 ---

    def _kill_now(self) -> None:
        self.refresh_pid()
        if self.pid and not self._killed:
            self._killed = True
            _kill_pid_tree(self.pid)

    async def close(self, force: bool = False) -> None:
        """关闭（幂等，可以并发调用）。force：先杀进程树再收尾；否则先正常 disconnect。"""
        if _POOL.get(self.sid) is self:
            del _POOL[self.sid]
        if force:
            self._kill_now()
        if self._close_task is None:
            self._close_task = asyncio.get_running_loop().create_task(self._shutdown())
        await asyncio.shield(self._close_task)

    async def _shutdown(self) -> None:
        try:
            if not self.task.done():
                self.task.cancel()
                await asyncio.wait({self.task}, timeout=DISCONNECT_TIMEOUT + 10)
            self.refresh_pid()
            if self.pid and self.process_alive():
                _kill_pid_tree(self.pid)   # disconnect 之后进程还在：再杀一次
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.log(f"关闭出错：{type(e).__name__}: {e}\n")
        finally:
            self.dead = True


# ---------- 事件转换 ----------

def _emit(on_event, ev: dict) -> None:
    try:
        on_event(ev)
    except Exception:
        usage.log_failure("-", "sdk_event")


def _convert(sdk, msg, on_event) -> None:
    """StreamEvent / AssistantMessage → 和 runner.run_claude 一样的事件；其他消息忽略。"""
    if isinstance(msg, sdk.StreamEvent):
        ev = msg.event if isinstance(msg.event, dict) else {}
        kind = ev.get("type")
        if kind == "message_start":
            _emit(on_event, {"type": "delta_reset"})
        elif kind == "content_block_delta":
            delta = ev.get("delta") or {}
            if delta.get("type") == "thinking_delta":
                if delta.get("thinking"):
                    _emit(on_event, {"type": "thinking", "text": delta["thinking"]})
            elif delta.get("text"):
                _emit(on_event, {"type": "delta", "text": delta["text"]})
    elif isinstance(msg, sdk.AssistantMessage):
        content = msg.content if isinstance(msg.content, list) else []
        for block in content:
            if isinstance(block, sdk.ToolUseBlock):
                _emit(on_event, {"type": "tool", "name": block.name, "detail": _tool_detail(block.input or {})})


def _final_of(msg) -> dict:
    result = msg.result
    if not result and getattr(msg, "errors", None):
        result = "；".join(str(e) for e in msg.errors)
    final = {"type": "result", "subtype": msg.subtype, "is_error": bool(msg.is_error), "result": result,
             "session_id": msg.session_id, "total_cost_usd": msg.total_cost_usd, "usage": msg.usage,
             "terminal_reason": getattr(msg, "terminal_reason", None)}
    if msg.model_usage:   # 空的不放：normalize_usage 没有 modelUsage 时才会回退到 usage
        final["modelUsage"] = msg.model_usage
    return final


# ---------- 跑一轮 ----------

def _error(text: str, session_id=None) -> dict:
    return {"is_error": True, "result": text, "session_id": session_id}


async def run_turn(run, prompt: str, spec: TurnSpec, on_event) -> dict:
    """跑一轮，返回和 runner.run_claude 同形的 final 字典。不向外抛异常（CancelledError 除外）。"""
    try:
        return await _run_turn(run, prompt, spec, on_event)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        return _error(f"sdk 运行出错：{type(e).__name__}: {e}。{UNAVAILABLE_HINT}", spec.resume)


def _compatible(c: _Client, fp: str, spec: TurnSpec) -> bool:
    return not c.dead and not c.stopping and c.fp == fp and set(spec.add_dirs) <= c.dirs


async def _acquire(sdk, spec: TurnSpec, cli_path: str) -> "_Client | str":
    """取这个会话的客户端（复用或新建并等连接完成）。失败返回错误文字。"""
    fp = _fingerprint(spec, cli_path)
    c = _POOL.get(spec.sid)
    if c is not None and _compatible(c, fp, spec):
        c.busy = True
        c.last_used = time.time()
        return c
    resume = spec.resume
    if c is not None:
        resume = resume or c.session_id
        await c.close(False)   # 指纹变了：关旧建新
    if len(_POOL) >= max_clients():
        idle = [x for x in _POOL.values() if not x.busy and not x.dead]
        if idle:   # 全在忙就不限制
            await min(idle, key=lambda x: x.last_used).close(False)
    c = _POOL[spec.sid] = _Client(sdk, spec, fp, cli_path, resume)
    try:
        err = await asyncio.wait_for(asyncio.shield(c.connected), connect_timeout())
    except asyncio.TimeoutError:
        await c.close(True)
        return unavailable_message(f"连接 claude 超时（{int(connect_timeout())} 秒）")
    except asyncio.CancelledError:
        _spawn(c.close(True))
        raise
    if err:
        await c.close(False)
        return unavailable_message(f"启动 claude 失败：{err}")
    c.last_used = time.time()
    return c


async def _run_turn(run, prompt: str, spec: TurnSpec, on_event) -> dict:
    if reason := availability():
        return _error(unavailable_message(reason), spec.resume)
    try:
        cli_path = resolve_cli(spec.cli_path)
    except SdkUnavailable as e:
        return _error(unavailable_message(str(e)), spec.resume)
    if reason := _loop_problem():
        return _error(unavailable_message(reason), spec.resume)
    sdk = _load_sdk()

    got = await _acquire(sdk, spec, cli_path)
    if isinstance(got, str):
        return _error(got, spec.resume)
    c = got
    q = asyncio.Queue()
    c.turn_q, c.turn_done = q, asyncio.Event()
    try:
        if getattr(run, "stopped", False):   # 等连接的时候用户点了停止：这一轮不用发了
            return _error("已停止", c.session_id)
        try:
            await c.client.query(prompt)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await c.close(True)
            return _error(f"向 claude 发送消息失败：{type(e).__name__}: {e}", c.session_id)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + spec.timeout
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), max(0.0, deadline - loop.time()))
            except asyncio.TimeoutError:
                run.timed_out = True
                await c.close(True)
                return _error("超时", c.session_id)
            if msg is _DEAD:
                tail = c.stderr_text()
                text = "claude 进程异常退出" + (f"：{tail}" if tail else (f"（{c.error}）" if c.error else ""))
                return _error(text, c.session_id)
            if isinstance(msg, sdk.ResultMessage):
                if msg.session_id:
                    c.session_id = msg.session_id
                return _final_of(msg)
            _convert(sdk, msg, on_event)
    except asyncio.CancelledError:
        _spawn(c.close(True))   # 这一轮被取消（服务退出等）：客户端状态不明，强制关
        raise
    finally:
        c.turn_q = None
        c.busy = False
        c.last_used = time.time()
        c.turn_done.set()
        if not c.dead and not _mode_is_sdk():
            try:
                await c.close(False)   # 管理员已经切回 cli：这一轮跑完就关
            except asyncio.CancelledError:
                raise
            except Exception:
                pass


# ---------- 停止、回收 ----------

def request_stop(sid: str) -> None:
    """停止这一轮（同步调用，内部起任务）：interrupt → 最多等 STOP_GRACE 秒让这一轮自己收尾 → 关闭客户端（没等到就强制）。"""
    c = _POOL.get(sid)
    if c is not None:
        _spawn(_stop(c))


async def _stop(c: _Client) -> None:
    c.stopping = True   # 从这一刻起下一轮不会复用它（否则收尾时的关闭会打断新的一轮）
    try:
        if not c.connected.done():   # 还在等连接：没有什么可 interrupt 的，直接强制关
            await c.close(True)
            return
        done = c.turn_done if c.busy else None

        async def interrupt_and_wait():
            try:
                await c.client.interrupt()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            if done is not None:
                await done.wait()
        try:
            await asyncio.wait_for(interrupt_and_wait(), STOP_GRACE)
            graceful = True
        except asyncio.TimeoutError:
            graceful = False
        await c.close(force=not graceful)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        c.log(f"停止出错：{type(e).__name__}: {e}\n")


async def close_session(sid: str) -> None:
    """会话被删、或要强制重建时关掉它的常驻客户端。"""
    c = _POOL.get(sid)
    if c is not None:
        await c.close(True)


async def close_idle(now=None) -> int:
    """关掉空闲超时的客户端（不在忙，且 now - last_used >= 空闲秒数），返回关了几个。now=inf 等于关掉所有空闲的。"""
    now = time.time() if now is None else now
    limit = idle_seconds()
    targets = [c for c in list(_POOL.values()) if not c.busy and now - c.last_used >= limit]
    results = await asyncio.gather(*(c.close(False) for c in targets), return_exceptions=True)
    return sum(1 for r in results if not isinstance(r, BaseException))


async def close_all() -> None:
    """服务退出、切回 cli 时关掉所有客户端（强制，包括在忙的）。"""
    await asyncio.gather(*(c.close(True) for c in list(_POOL.values())), return_exceptions=True)


def client_count() -> int:
    return len(_POOL)
