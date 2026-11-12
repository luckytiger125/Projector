"""sdk_runner 的完整实现（计划 §7 的 1~12 项；第 13 项由 test_sdk_switch.py / test_approvals 等现有测试覆盖）。
用假的 SDK 模块（monkeypatch sdk_runner._load_sdk）：假客户端按“脚本”吐消息，能模拟连接失败、挂起、崩溃、interrupt 有/无响应。
端到端的用例走真实的 HTTP 接口；权限回调、钩子、ask_user 直接从假客户端记下的选项里取出来在事件循环里调用。
等待都靠轮询（有上限）或 run 结束，不靠固定时长的 sleep。_kill_pid_tree 一律换成记录调用的假函数，绝不会真的杀进程。
"""
import asyncio
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import approvals
import events
import guard
import runner
import sdk_runner
import store

import server  # noqa: E402  (conftest 已先设好临时目录)

WAIT = 10
SETTING_KEYS = ("runner_mode", "sdk_idle_seconds", "perm_mode", "ask_cmds", "bash_allow")


# ---------- 假的 SDK ----------

@dataclass
class SystemMessage:
    subtype: str
    data: dict = field(default_factory=dict)


@dataclass
class StreamEvent:
    event: dict
    uuid: str = "u"
    session_id: str = "sess-1"
    parent_tool_use_id: str | None = None


@dataclass
class TextBlock:
    text: str


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict


@dataclass
class AssistantMessage:
    content: list
    model: str = "m"


@dataclass
class ResultMessage:
    subtype: str = "success"
    is_error: bool = False
    result: str | None = None
    session_id: str = "sess-1"
    total_cost_usd: float | None = None
    usage: dict | None = None
    model_usage: dict | None = None
    terminal_reason: str | None = None
    errors: list | None = None
    duration_ms: int = 0
    duration_api_ms: int = 0
    num_turns: int = 1


class FakeOptions:
    """接受任意关键字并存成属性；没传过的属性读出来是 None。"""

    def __init__(self, **kw):
        self.__dict__.update(kw)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return None


class HookMatcher:
    def __init__(self, matcher=None, hooks=None, timeout=None, on_failure=None):
        self.matcher, self.hooks, self.timeout, self.on_failure = matcher, hooks or [], timeout, on_failure


class PermissionResultAllow:
    def __init__(self, updated_input=None, updated_permissions=None):
        self.updated_input = updated_input


class PermissionResultDeny:
    def __init__(self, message="", interrupt=False):
        self.message, self.interrupt = message, interrupt


class CLIConnectionError(Exception):
    pass


class CanUseToolShadowedWarning(UserWarning):
    pass


class FakeTool:
    def __init__(self, name, description, input_schema, handler):
        self.name, self.description, self.input_schema, self.handler = name, description, input_schema, handler


class Gate:
    def __init__(self, name):
        self.name = name


class Crash:
    """让读消息的迭代器抛异常（进程崩溃），先往 stderr 回调里写几行。"""

    def __init__(self, exc, stderr=()):
        self.exc, self.stderr = exc, list(stderr)


class Exit:
    """读消息的迭代器正常结束（进程自己退出了）。"""


_END = object()


class FakeProc:
    def __init__(self, pid):
        self.pid, self.returncode = pid, None


def se(kind, **kw):
    return StreamEvent(event={"type": kind, **kw})


def delta(text):
    return se("content_block_delta", delta={"type": "text_delta", "text": text})


def thinking(text):
    return se("content_block_delta", delta={"type": "thinking_delta", "thinking": text})


class FakeSdk:
    """模块替身。script：prompt → 消息列表（元素可以是消息、Gate、Crash、Exit）；没写的 prompt 默认回一条 ResultMessage。"""
    SystemMessage, StreamEvent, TextBlock, ToolUseBlock = SystemMessage, StreamEvent, TextBlock, ToolUseBlock
    AssistantMessage, ResultMessage, HookMatcher = AssistantMessage, ResultMessage, HookMatcher
    PermissionResultAllow, PermissionResultDeny = PermissionResultAllow, PermissionResultDeny
    CLIConnectionError, CanUseToolShadowedWarning = CLIConnectionError, CanUseToolShadowedWarning
    ClaudeAgentOptions = FakeOptions
    __file__ = "/nonexistent/claude_agent_sdk/__init__.py"

    def __init__(self):
        self.instances: list = []
        self.script: dict = {}
        self.gates: dict = {}
        self.kills: list = []
        self.fail_connect = 0
        self.reject_on_failure = False
        self.connect_gate = None
        self.interrupt_responds = True
        self.zombie = False              # disconnect 之后进程还活着
        self.stderr_on_connect: list = []
        self.session_id = "sess-1"
        self._pid = 4000
        ctl = self

        class ClaudeSDKClient:
            def __init__(self, options):
                self.options = options
                self.out = asyncio.Queue()
                self.queries, self.producers = [], set()
                self.connect_calls = self.disconnected = self.interrupts = 0
                self.connected = False
                self.proc = None
                self._transport = None
                ctl.instances.append(self)

            async def connect(self):
                self.connect_calls += 1
                hooks = (self.options.hooks or {}).values()
                if ctl.reject_on_failure and any(m.on_failure for ms in hooks for m in ms):
                    raise CLIConnectionError("hooks: on_failure is not supported by this claude version")
                if ctl.fail_connect > 0:
                    ctl.fail_connect -= 1
                    raise CLIConnectionError("起不来")
                if ctl.connect_gate:
                    await ctl.gate(ctl.connect_gate).wait()
                ctl._pid += 1
                self.proc = FakeProc(ctl._pid)
                self._transport = SimpleNamespace(_process=self.proc)
                self.connected = True
                for line in ctl.stderr_on_connect:
                    self.options.stderr(line + "\n")

            async def query(self, prompt, session_id="default"):
                if not self.connected:
                    raise CLIConnectionError("Not connected. Call connect() first.")
                self.queries.append(prompt)
                t = asyncio.get_running_loop().create_task(self._produce(prompt))
                self.producers.add(t)

            async def _produce(self, prompt):
                items = ctl.script.get(prompt) or [ResultMessage(result="re:" + prompt, session_id=ctl.session_id)]
                for it in items:
                    if isinstance(it, Gate):
                        await ctl.gate(it.name).wait()
                    elif isinstance(it, Crash):
                        for line in it.stderr:
                            self.options.stderr(line + "\n")
                        self.proc.returncode = 1
                        self.out.put_nowait(it.exc)
                        return
                    elif it is Exit:
                        self.proc.returncode = 0
                        self.out.put_nowait(_END)
                        return
                    else:
                        self.out.put_nowait(it)

            async def receive_messages(self):
                while True:
                    item = await self.out.get()
                    if item is _END:
                        return
                    if isinstance(item, BaseException):
                        raise item
                    yield item

            async def interrupt(self):
                self.interrupts += 1
                if ctl.interrupt_responds:
                    self.out.put_nowait(ResultMessage(is_error=True, result="", terminal_reason="aborted_streaming"))
                else:
                    await asyncio.sleep(3600)

            async def disconnect(self):
                self.disconnected += 1
                self.connected = False
                for t in self.producers:
                    t.cancel()
                self.out.put_nowait(_END)
                if self.proc is not None and self.proc.returncode is None and not ctl.zombie:
                    self.proc.returncode = 0
                self._transport = None   # 和真 SDK 一样：断开后取不到进程了

        self.ClaudeSDKClient = ClaudeSDKClient

    def gate(self, name):
        return self.gates.setdefault(name, asyncio.Event())

    @staticmethod
    def tool(name, description, input_schema):
        return lambda fn: FakeTool(name, description, input_schema, fn)

    @staticmethod
    def create_sdk_mcp_server(name, version="1.0.0", tools=None):
        return {"type": "sdk", "name": name, "tools": tools or []}

    def fake_kill(self, pid):
        """替换 sdk_runner._kill_pid_tree：记下来，并让对应的假进程“死掉”。"""
        self.kills.append(pid)
        for inst in self.instances:
            if inst.proc is not None and inst.proc.pid == pid:
                inst.proc.returncode = -9
                inst.out.put_nowait(_END)


# ---------- 环境 ----------

def _wipe_settings():
    for k in SETTING_KEYS:
        store.db("DELETE FROM settings WHERE key=?", (k,))


class Env:
    def __init__(self, c, fake):
        self.c, self.fake = c, fake

    def loop(self, fn, *a):
        return self.c.portal.call(fn, *a)

    def start(self, fn, *a):
        return self.c.portal.start_task_soon(fn, *a)

    def poll(self, pred, what="条件", timeout=WAIT):
        end = time.monotonic() + timeout
        while not pred():
            assert time.monotonic() < end, f"等不到：{what}"
            time.sleep(0.005)

    def session(self, user):
        return self.c.post("/api/sessions", json={}, headers=user["headers"]).json()["id"]

    def send(self, user, sid, text="你好", wait=True):
        r = self.c.post(f"/api/sessions/{sid}/messages", json={"text": text}, headers=user["headers"])
        assert r.status_code == 200, r.text
        if wait:
            self.wait(sid)

    def wait(self, sid):
        self.poll(lambda: sid not in runner.RUNS, f"会话 {sid} 这一轮结束")
        self.loop(asyncio.sleep, 0)

    def msgs(self, sid, role=None):
        rows = store.db("SELECT role, content, meta FROM messages WHERE session_id=? ORDER BY id", (sid,))
        return [r for r in rows if role is None or r["role"] == role]

    def last(self, sid):
        return self.msgs(sid)[-1]

    def event_texts(self, sid):
        return [m["content"] for m in self.msgs(sid, "event")]

    def count(self):
        return self.loop(self._count)

    @staticmethod
    async def _count():
        return sdk_runner.client_count()

    def opts(self, i=-1):
        return self.fake.instances[i].options


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for k in ("RUNNER_MODE", "SDK_IDLE_SECONDS", "SDK_MAX_CLIENTS", "SDK_CONNECT_TIMEOUT"):
        monkeypatch.delenv(k, raising=False)
    _wipe_settings()
    runner.RUNS.clear()
    approvals.APPROVALS.clear()
    approvals.QUESTIONS.clear()
    yield
    _wipe_settings()
    runner.RUNS.clear()


@pytest.fixture
def fx(monkeypatch):
    fake = FakeSdk()
    monkeypatch.setattr(sdk_runner, "_load_sdk", lambda: fake)
    monkeypatch.setattr(sdk_runner, "_kill_pid_tree", fake.fake_kill)   # 绝不真的杀进程
    monkeypatch.setattr(sdk_runner, "STOP_GRACE", 0.3)
    monkeypatch.setattr(runner, "find_claude", lambda: "claude")
    store.set_setting("runner_mode", "sdk")
    with TestClient(server.app) as c:
        e = Env(c, fake)
        yield e
        while runner.RUNS:   # 收尾：放行挂着的轮次，等它们结束，再关掉所有客户端
            for g in fake.gates.values():
                e.loop(_set, g)
            e.loop(next(iter(runner.RUNS.values())).done.wait)
        e.loop(sdk_runner.close_all)


async def _set(ev):
    ev.set()


@pytest.fixture
def alice(make_user):
    return make_user("alice", display_name="爱丽丝")


@pytest.fixture
def boss(make_user):
    return make_user("boss", role="admin", display_name="老板")


def mkspec(tmp_path, sid="d1", **kw):
    """手工拼 TurnSpec，直接调 run_turn 的用例用。"""
    base = dict(sid=sid, owner_id=1, cli_path="claude", cwd=str(tmp_path), add_dirs=[str(tmp_path / "a")],
                hint_file=str(tmp_path / "hint.txt"), disallowed=["AskUserQuestion"], allowed=["Read"],
                mcp_center={"command": "python", "args": ["x"], "env": {}},
                policy=lambda: guard.Policy(ws_root=str(tmp_path / "ws"), own=[], forbidden=[], other_names=[]),
                timeout=10, log_path=str(tmp_path / f"{sid}.log"))
    base.update(kw)
    return sdk_runner.TurnSpec(**base)


def new_run():
    return SimpleNamespace(stopped=False, timed_out=False)


def turn(fx, spec, prompt="p", run=None):
    evs = []
    final = fx.loop(sdk_runner.run_turn, run or new_run(), prompt, spec, evs.append)
    return final, evs


# ---------- 1. 事件转换 ----------

def test_event_conversion_and_persistence(fx, alice):
    fx.fake.script["问"] = [
        SystemMessage("init", {"session_id": "sess-1"}),                  # 每轮开头的 init：忽略
        se("message_start"),
        thinking("想一想"), thinking(""),                                    # 空的思考不转发
        delta("你"), delta(""), delta("好"),                                 # 空的文字不转发
        se("content_block_start"), se("message_delta"),                    # 其他流事件忽略
        AssistantMessage([TextBlock("你好"), ToolUseBlock("t1", "Read", {"file_path": "/x/a.txt"}),
                          ToolUseBlock("t2", "Bash", {"command": "echo " + "x" * 300}),
                          ToolUseBlock("t3", "Weird", {})]),
        se("message_start"), delta("好的"),
        ResultMessage(result="你好，好的", session_id="sess-9", total_cost_usd=0.01),
    ]
    sid = fx.session(alice)
    start_seq = events.current_seq()
    fx.send(alice, sid, "问")
    evs = [e for (s, _, _, e) in events._ring if s > start_seq and e.get("session_id") == sid
           and e["type"] in ("delta_reset", "thinking", "delta", "tool")]
    assert [(e["type"], e.get("text") or e.get("name")) for e in evs] == [
        ("delta_reset", None), ("thinking", "想一想"), ("delta", "你"), ("delta", "好"),
        ("tool", "Read"), ("tool", "Bash"), ("tool", "Weird"), ("delta_reset", None), ("delta", "好的")]
    assert evs[4]["detail"] == "/x/a.txt" and evs[5]["detail"] == "echo " + "x" * 195 and evs[6]["detail"] == ""
    seqs = [e["seq"] for e in evs]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    last = fx.last(sid)
    assert (last["role"], last["content"]) == ("assistant", "你好，好的")
    assert [t["name"] for t in json.loads(last["meta"])["tools"]] == ["Read", "Bash", "Weird"]
    assert store.db("SELECT claude_session FROM sessions WHERE id=?", (sid,), one=True)["claude_session"] == "sess-9"
    assert runner.RUNS == {}


def test_is_error_result_becomes_error_message(fx, alice):
    fx.fake.script["x"] = [ResultMessage(subtype="success", is_error=True, result="Not logged in · Please run /login")]
    sid = fx.session(alice)
    fx.send(alice, sid, "x")
    last = fx.last(sid)
    assert last["role"] == "error" and last["content"] == "出错了：Not logged in · Please run /login"


# ---------- 2. 选项拼装三档 ----------

def test_options_standard(fx, alice, monkeypatch):
    monkeypatch.setattr(runner.skills_api, "plugin_dir_for", lambda owner: Path("/tmp/plug"))
    sid = fx.session(alice)
    store.db("UPDATE sessions SET claude_session=? WHERE id=?", ("old-sess", sid))
    fx.send(alice, sid)
    o = fx.opts()
    assert o.cli_path == "claude" and o.cwd == str(store.FILE_ROOT) and o.resume == "old-sess"
    assert str(store.KB_ROOT) in o.add_dirs
    ask = json.loads(o.settings)["permissions"]["ask"]
    assert ask and ask[0].startswith("Bash(")
    assert o.permission_mode is None
    assert "Bash" in o.allowed_tools and "Edit" in o.allowed_tools
    assert "mcp__projector__ask_user" in o.allowed_tools and "mcp__center__ask_user" not in o.allowed_tools
    assert o.disallowed_tools[0] == "AskUserQuestion"
    assert o.disallowed_tools[-2:] == ["mcp__center__approve", "mcp__center__ask_user"]
    assert any(t.startswith("Read(") for t in o.disallowed_tools)
    hint = o.extra_args["append-system-prompt-file"]
    assert Path(hint).exists() and hint.endswith(f"hint_{sid}.txt")
    assert o.system_prompt == {"type": "preset", "preset": "claude_code"}   # 不能是 None，否则清空默认提示词
    assert o.include_partial_messages is True and o.max_buffer_size == 32 * 1024 * 1024
    assert o.plugins == [{"type": "local", "path": str(Path("/tmp/plug"))}]
    assert o.env["MCP_TIMEOUT"] == "60000"
    assert o.env["MCP_TOOL_TIMEOUT"] == str(int(approvals.APPROVAL_TIMEOUT * 1000) + 60000)
    assert set(o.mcp_servers) == {"center", "projector"}
    assert o.mcp_servers["center"]["args"][0].endswith("approval_mcp.py")
    assert o.mcp_servers["center"]["env"]["CENTER_SESSION"] == sid
    assert o.mcp_servers["projector"]["type"] == "sdk" and o.mcp_servers["projector"]["tools"][0].name == "ask_user"
    assert callable(o.can_use_tool) and callable(o.stderr)
    (m,) = o.hooks["PreToolUse"]
    assert m.matcher is None and m.on_failure == "block" and len(m.hooks) == 1
    # sdk 模式不写 settings / guard / mcp 配置文件
    for f in (f"settings_{sid}.json", f"guard_{sid}.json", f"{sid}.json"):
        assert not (store.DATA / "mcp" / f).exists()


def test_options_no_resume_no_plugin(fx, alice, monkeypatch):
    monkeypatch.setattr(runner.skills_api, "plugin_dir_for", lambda owner: None)
    fx.send(alice, fx.session(alice))
    o = fx.opts()
    assert o.resume is None and o.plugins is None


def test_options_strict(fx, alice, monkeypatch):
    monkeypatch.setattr(runner, "perm_mode", lambda: "strict")
    fx.send(alice, fx.session(alice))
    o = fx.opts()
    assert o.settings is None and o.permission_mode is None
    assert "Bash" not in o.allowed_tools and "Bash(ls:*)" in o.allowed_tools and "Edit" in o.allowed_tools
    assert callable(o.can_use_tool) and o.hooks["PreToolUse"][0].on_failure == "block"


def test_options_bypass(fx, boss):
    sid = fx.session(boss)
    store.db("UPDATE sessions SET bypass=1 WHERE id=?", (sid,))
    fx.send(boss, sid)
    o = fx.opts()
    assert o.permission_mode == "bypassPermissions" and o.allowed_tools == [] and o.settings is None
    assert callable(o.can_use_tool)
    assert o.hooks["PreToolUse"][0].on_failure == "block"   # 完全放行档下隔离钩子照样挂着


# ---------- 3. 权限回调 ----------

def _callbacks(fx, user):
    sid = fx.session(user)
    fx.send(user, sid)
    return sid, fx.opts()


def _run_cb(fx, fn, *a):
    return fx.start(fn, *a)


def _decide(fx, user, allow):
    fx.poll(lambda: approvals.APPROVALS, "确认卡片出现")
    (aid,) = list(approvals.APPROVALS)
    r = fx.c.post(f"/api/approvals/{aid}", json={"allow": allow}, headers=user["headers"])
    assert r.status_code == 200


def test_can_use_tool_allow(fx, alice):
    sid, o = _callbacks(fx, alice)
    inp = {"command": "git push"}
    fut = _run_cb(fx, o.can_use_tool, "Bash", inp, None)
    _decide(fx, alice, True)
    res = fut.result(WAIT)
    assert isinstance(res, PermissionResultAllow) and res.updated_input == inp
    assert "✔ 已同意（爱丽丝）：运行命令：git push" in fx.event_texts(sid)
    assert approvals.APPROVALS == {}


def test_can_use_tool_deny(fx, alice):
    sid, o = _callbacks(fx, alice)
    fut = _run_cb(fx, o.can_use_tool, "Bash", {"command": "git push"}, None)
    _decide(fx, alice, False)
    res = fut.result(WAIT)
    assert isinstance(res, PermissionResultDeny) and res.message == "用户拒绝了这个操作，不要重试同样的操作"
    assert "✘ 已拒绝（爱丽丝）：运行命令：git push" in fx.event_texts(sid)


def test_can_use_tool_timeout(fx, alice, monkeypatch):
    sid, o = _callbacks(fx, alice)
    monkeypatch.setattr(approvals, "APPROVAL_TIMEOUT", 0.05)
    res = fx.loop(o.can_use_tool, "Write", {"file_path": "/x/a.txt"}, None)
    assert isinstance(res, PermissionResultDeny) and res.message == "等待用户确认超时"
    assert "⌛ 确认超时，已拒绝：新建或覆盖文件：/x/a.txt" in fx.event_texts(sid)


def test_can_use_tool_exception_is_deny(fx, alice, monkeypatch):
    sid, o = _callbacks(fx, alice)

    async def boom(*a):
        raise RuntimeError("内部错误")
    monkeypatch.setattr(approvals, "wait_approval", boom)
    res = fx.loop(o.can_use_tool, "Bash", {"command": "ls"}, None)
    assert isinstance(res, PermissionResultDeny) and "确认通道出错" in res.message and "RuntimeError" in res.message


def test_can_use_tool_deny_without_message_gets_default(fx, alice, monkeypatch):
    sid, o = _callbacks(fx, alice)

    async def deny_empty(*a):
        return False, ""
    monkeypatch.setattr(approvals, "wait_approval", deny_empty)
    res = fx.loop(o.can_use_tool, "Bash", {"command": "ls"}, None)
    assert res.message == "用户拒绝了这个操作，不要重试同样的操作"


# ---------- 4. 文件隔离 ----------

@pytest.fixture
def two(fx, make_user):
    a = make_user("zhang", display_name="张三")
    b = make_user("li", display_name="李四")
    return a, store.get_user(b["id"])


def _hook_in(tool, inp, cwd=None):
    return {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": inp, "cwd": cwd or str(store.FILE_ROOT)}


def _is_deny(res):
    out = res.get("hookSpecificOutput") or {}
    return out.get("hookEventName") == "PreToolUse" and out.get("permissionDecision") == "deny" and out.get("permissionDecisionReason")


def test_hook_denies_other_workspace_and_allows_own(fx, two):
    ua, ub = two
    sid, o = _callbacks(fx, ua)
    hook = o.hooks["PreToolUse"][0].hooks[0]
    other = store.user_ws_dir(ub)
    mine = store.user_ws_dir(store.get_user(ua["id"]))
    assert _is_deny(fx.loop(hook, _hook_in("Read", {"file_path": str(other / "a.txt")}), "id1", {}))
    assert _is_deny(fx.loop(hook, _hook_in("Bash", {"command": f"cat {other}/a.txt"}), None, {}))
    assert _is_deny(fx.loop(hook, _hook_in("Write", {"file_path": str(other / "b.txt")}), None, {}))
    assert fx.loop(hook, _hook_in("Read", {"file_path": str(mine / "a.txt")}), None, {}) == {}
    assert fx.loop(hook, _hook_in("Bash", {"command": f"cat {mine}/a.txt"}), None, {}) == {}
    assert fx.loop(hook, _hook_in("Bash", {"command": "ls"}), None, {}) == {}


def test_hook_still_attached_and_denies_in_bypass(fx, make_user, boss):
    other = make_user("zhang", display_name="张三")
    sid = fx.session(boss)
    store.db("UPDATE sessions SET bypass=1 WHERE id=?", (sid,))
    fx.send(boss, sid)
    o = fx.opts()
    assert o.permission_mode == "bypassPermissions"
    hook = o.hooks["PreToolUse"][0].hooks[0]
    other_ws = store.user_ws_dir(store.get_user(other["id"]))
    assert _is_deny(fx.loop(hook, _hook_in("Read", {"file_path": str(other_ws / "a.txt")}), None, {}))


def test_hook_exception_is_deny(fx, alice, monkeypatch):
    sid, o = _callbacks(fx, alice)
    hook = o.hooks["PreToolUse"][0].hooks[0]

    def boom(*a, **k):
        raise RuntimeError("策略炸了")
    monkeypatch.setattr(guard, "check_tool", boom)
    res = fx.loop(hook, _hook_in("Read", {"file_path": "/x"}), None, {})
    assert _is_deny(res) and "文件隔离检查出错" in res["hookSpecificOutput"]["permissionDecisionReason"]
    assert _is_deny(fx.loop(hook, None, None, {}))   # 连输入都不是字典：也是拒绝


def test_can_use_tool_guard_fallback_denies_without_card(fx, two):
    ua, ub = two
    sid, o = _callbacks(fx, ua)
    other = store.user_ws_dir(ub)
    res = fx.loop(o.can_use_tool, "Read", {"file_path": str(other / "a.txt")}, None)
    assert isinstance(res, PermissionResultDeny) and res.message
    assert approvals.APPROVALS == {}
    assert any(t.startswith("⛔ 已自动拒绝（涉及其他人的个人文件或系统数据）：使用 Read：") for t in fx.event_texts(sid))


# ---------- 5. 提问 ----------

QS = [{"question": "选哪个？", "header": "方案", "options": [{"label": "甲"}, {"label": "乙", "description": "备选"}],
       "multi_select": False}]


def _ask_tool(o):
    return o.mcp_servers["projector"]["tools"][0]


def _answer(fx, user, **body):
    fx.poll(lambda: approvals.QUESTIONS, "问题卡片出现")
    (qid,) = list(approvals.QUESTIONS)
    r = fx.c.post(f"/api/questions/{qid}", json=body, headers=user["headers"])
    assert r.status_code == 200, r.text


def _text(res):
    assert res["content"][0]["type"] == "text" and len(res["content"]) == 1
    return res["content"][0]["text"]


def test_ask_user_tool_definition(fx, alice):
    sid, o = _callbacks(fx, alice)
    t = _ask_tool(o)
    assert t.name == "ask_user" and "弹出选项卡片" in t.description and "最多 4 个问题" in t.description
    s = t.input_schema
    assert s["required"] == ["questions"] and s["properties"]["questions"]["type"] == "array"
    item = s["properties"]["questions"]["items"]
    assert set(item["properties"]) == {"question", "header", "options", "multi_select"}
    assert item["required"] == ["question", "options"]
    assert set(item["properties"]["options"]["items"]["properties"]) == {"label", "description"}


def test_ask_user_answer(fx, alice):
    sid, o = _callbacks(fx, alice)
    fut = fx.start(_ask_tool(o).handler, {"questions": QS})
    _answer(fx, alice, answers=[{"selected": ["甲"], "note": "快点"}], skipped=False)
    assert _text(fut.result(WAIT)) == "用户的回答：\n1. 选哪个？ → 甲（备注：快点）"


def test_ask_user_skip(fx, alice):
    sid, o = _callbacks(fx, alice)
    fut = fx.start(_ask_tool(o).handler, {"questions": QS})
    _answer(fx, alice, answers=[], skipped=True)
    assert _text(fut.result(WAIT)).startswith("用户跳过了这些问题，没有选择。")
    assert any("跳过了 Claude 的问题" in t for t in fx.event_texts(sid))


def test_ask_user_timeout(fx, alice, monkeypatch):
    sid, o = _callbacks(fx, alice)
    monkeypatch.setattr(approvals, "APPROVAL_TIMEOUT", 0.05)
    assert _text(fx.loop(_ask_tool(o).handler, {"questions": QS})) == "用户 30 分钟内没有回答。"
    assert "⌛ 问题超时没有回答" in fx.event_texts(sid) and approvals.QUESTIONS == {}


def test_ask_user_bad_input_and_exception(fx, alice, monkeypatch):
    sid, o = _callbacks(fx, alice)
    h = _ask_tool(o).handler
    assert _text(fx.loop(h, {})) == "问题格式不对：每个问题要有 question 和至少一个带 label 的选项。"
    assert _text(fx.loop(h, None)).startswith("问题格式不对")

    async def boom(*a):
        raise RuntimeError("x")
    monkeypatch.setattr(approvals, "wait_question", boom)
    assert _text(fx.loop(h, {"questions": QS})) == "没能弹出问题（RuntimeError），请直接在回答里问用户。"


# ---------- 6. 停止 ----------

def _started(fx, n=1):
    fx.poll(lambda: fx.fake.instances and sum(len(i.queries) for i in fx.fake.instances) >= n, "这一轮已发给 claude")


def test_stop_interrupts_then_closes_gracefully(fx, alice):
    fx.fake.script["慢"] = [se("message_start"), delta("半截"), Gate("g")]
    sid = fx.session(alice)
    fx.send(alice, sid, "慢", wait=False)
    _started(fx)
    fx.poll(lambda: runner.RUNS.get(sid) and runner.RUNS[sid].text == "半截", "收到半截文字")
    assert fx.c.post(f"/api/sessions/{sid}/stop", headers=alice["headers"]).status_code == 200
    fx.wait(sid)
    inst = fx.fake.instances[0]
    assert inst.interrupts == 1 and inst.disconnected == 1
    assert fx.fake.kills == []   # interrupt 有响应：正常关闭，不杀进程
    last = fx.last(sid)
    assert last["role"] == "error" and last["content"].startswith("已停止。")
    assert fx.count() == 0 and runner.RUNS == {}


def test_stop_without_interrupt_response_kills(fx, alice):
    fx.fake.interrupt_responds = False
    fx.fake.script["慢"] = [delta("半截"), Gate("g")]
    sid = fx.session(alice)
    fx.send(alice, sid, "慢", wait=False)
    _started(fx)
    fx.c.post(f"/api/sessions/{sid}/stop", headers=alice["headers"])
    fx.wait(sid)
    inst = fx.fake.instances[0]
    assert inst.interrupts == 1 and fx.fake.kills == [inst.proc.pid]
    assert fx.last(sid)["content"].startswith("已停止。") and fx.count() == 0


def test_stop_while_connecting_closes_immediately(fx, alice):
    fx.fake.connect_gate = "cg"
    sid = fx.session(alice)
    fx.send(alice, sid, "你好", wait=False)
    fx.poll(lambda: fx.fake.instances and fx.fake.instances[0].connect_calls == 1, "开始连接")
    fx.c.post(f"/api/sessions/{sid}/stop", headers=alice["headers"])
    fx.wait(sid)
    assert fx.last(sid)["content"].startswith("已停止。") and fx.count() == 0
    assert fx.fake.instances[0].queries == [] and fx.fake.instances[0].interrupts == 0


def test_next_turn_after_stop_cold_starts_with_resume(fx, alice):
    fx.fake.script["慢"] = [Gate("g")]
    sid = fx.session(alice)
    fx.send(alice, sid, "先答一轮")
    fx.send(alice, sid, "慢", wait=False)
    _started(fx, 2)
    fx.c.post(f"/api/sessions/{sid}/stop", headers=alice["headers"])
    fx.wait(sid)
    fx.send(alice, sid, "再来")
    assert len(fx.fake.instances) == 2 and fx.opts().resume == "sess-1"
    assert fx.last(sid)["content"] == "re:再来"


# ---------- 7. 空闲回收和池上限 ----------

def test_close_idle(fx, tmp_path):
    store.set_setting("sdk_idle_seconds", 30)
    for sid in ("a", "b"):
        turn(fx, mkspec(tmp_path, sid))
    fx.fake.script["hold"] = [Gate("h"), ResultMessage(result="re:hold")]
    fut = fx.start(sdk_runner.run_turn, new_run(), "hold", mkspec(tmp_path, "c"), lambda e: None)
    _started(fx, 3)
    assert fx.count() == 3
    now = time.time()
    assert fx.loop(sdk_runner.close_idle, now) == 0              # 都没超时
    assert fx.loop(sdk_runner.close_idle, now + 31) == 2         # 超时的两个空闲的关掉，在忙的不动
    assert fx.count() == 1
    assert [i.disconnected for i in fx.fake.instances] == [1, 1, 0]
    assert fx.loop(sdk_runner.close_idle, float("inf")) == 0     # inf 也只关空闲的
    fx.loop(_set, fx.fake.gate("h"))
    assert fut.result(WAIT)["result"] == "re:hold"
    assert fx.loop(sdk_runner.close_idle, float("inf")) == 1 and fx.count() == 0


def test_idle_seconds_priority_and_limits(monkeypatch):
    assert sdk_runner.idle_seconds() == 600
    monkeypatch.setenv("SDK_IDLE_SECONDS", "120")
    assert sdk_runner.idle_seconds() == 120
    store.set_setting("sdk_idle_seconds", 300)
    assert sdk_runner.idle_seconds() == 300
    store.set_setting("sdk_idle_seconds", 5)
    assert sdk_runner.idle_seconds() == 30
    store.set_setting("sdk_idle_seconds", 10 ** 9)
    assert sdk_runner.idle_seconds() == 86400
    store.set_setting("sdk_idle_seconds", "abc")
    assert sdk_runner.idle_seconds() == 120
    store.db("DELETE FROM settings WHERE key='sdk_idle_seconds'")
    monkeypatch.setenv("SDK_IDLE_SECONDS", "xyz")
    assert sdk_runner.idle_seconds() == 600


def test_pool_cap_evicts_least_recently_used_idle(fx, tmp_path, monkeypatch):
    monkeypatch.setenv("SDK_MAX_CLIENTS", "2")
    for sid in ("a", "b"):
        turn(fx, mkspec(tmp_path, sid))

    async def age():
        sdk_runner._POOL["a"].last_used -= 100
    fx.loop(age)
    turn(fx, mkspec(tmp_path, "c"))
    a, b, c = fx.fake.instances
    assert (a.disconnected, b.disconnected, c.disconnected) == (1, 0, 0) and fx.count() == 2
    assert fx.loop(_pool_keys) == {"b", "c"}


async def _pool_keys():
    return set(sdk_runner._POOL)


def test_pool_cap_not_enforced_when_all_busy(fx, tmp_path, monkeypatch):
    monkeypatch.setenv("SDK_MAX_CLIENTS", "2")
    futs = []
    for sid in ("a", "b", "c"):
        fx.fake.script["hold-" + sid] = [Gate("h-" + sid), ResultMessage(result="re:hold-" + sid)]
        futs.append(fx.start(sdk_runner.run_turn, new_run(), "hold-" + sid, mkspec(tmp_path, sid), lambda e: None))
    _started(fx, 3)
    assert fx.count() == 3 and all(i.disconnected == 0 for i in fx.fake.instances)
    for sid in ("a", "b", "c"):
        fx.loop(_set, fx.fake.gate("h-" + sid))
    for f in futs:
        assert f.result(WAIT)["result"].startswith("re:hold")


def test_max_clients_env(monkeypatch):
    assert sdk_runner.max_clients() == 8
    monkeypatch.setenv("SDK_MAX_CLIENTS", "3")
    assert sdk_runner.max_clients() == 3
    monkeypatch.setenv("SDK_MAX_CLIENTS", "0")
    assert sdk_runner.max_clients() == 1
    monkeypatch.setenv("SDK_MAX_CLIENTS", "x")
    assert sdk_runner.max_clients() == 8


# ---------- 8. 异常退出 ----------

def test_crash_mid_turn_then_rebuild_with_resume(fx, alice):
    sid = fx.session(alice)
    fx.send(alice, sid, "先答一轮")
    fx.fake.script["崩"] = [delta("半"), Crash(RuntimeError("管道断了"), stderr=["Traceback…", "致命错误：炸了"])]
    fx.send(alice, sid, "崩")
    last = fx.last(sid)
    assert last["role"] == "error" and last["content"].startswith("出错了：claude 进程异常退出")
    assert "致命错误：炸了" in last["content"]
    assert runner.RUNS == {} and store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0
    assert fx.count() == 0   # 已经从池里摘掉
    fx.send(alice, sid, "恢复了吗")
    assert len(fx.fake.instances) == 2 and fx.opts().resume == "sess-1"
    assert fx.last(sid)["content"] == "re:恢复了吗"


def test_process_exits_quietly_mid_turn(fx, alice):
    fx.fake.script["走"] = [Exit]
    sid = fx.session(alice)
    fx.send(alice, sid, "走")
    last = fx.last(sid)
    assert last["role"] == "error" and "claude 进程异常退出" in last["content"] and "进程已退出" in last["content"]
    assert fx.count() == 0


def test_stderr_tail_is_last_300_chars(fx, tmp_path):
    fx.fake.script["崩"] = [Crash(RuntimeError("x"), stderr=["开头" * 200, "最后一行"])]
    final, _ = turn(fx, mkspec(tmp_path), "崩")
    assert final["is_error"] and final["result"].startswith("claude 进程异常退出：") and final["result"].endswith("最后一行")
    assert len(final["result"]) <= len("claude 进程异常退出：") + 300


def test_crash_keeps_known_session_id(fx, tmp_path):
    spec = mkspec(tmp_path, resume="old")
    fx.fake.script["崩"] = [Exit]
    final, _ = turn(fx, spec, "崩")
    assert final["session_id"] == "old" and final["is_error"]
    turn(fx, mkspec(tmp_path, resume="old"), "ok")
    assert fx.opts().resume == "old"


# ---------- 9. 用量入账 ----------

def _usage_rows(sid):
    return store.db("SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd "
                    "FROM usage_turns WHERE session_id=?", (sid,))


def test_usage_from_model_usage(fx, alice):
    fx.fake.script["用"] = [ResultMessage(result="好", total_cost_usd=9.9, usage={"input_tokens": 1, "output_tokens": 1},
                                          model_usage={"claude-x": {"inputTokens": 10, "outputTokens": 5, "cacheReadInputTokens": 2,
                                                                    "cacheCreationInputTokens": 1, "costUSD": 0.5}})]
    sid = fx.session(alice)
    fx.send(alice, sid, "用")
    (r,) = _usage_rows(sid)
    assert (r["model"], r["input_tokens"], r["output_tokens"], r["cache_read_tokens"], r["cache_write_tokens"], r["cost_usd"]) == \
        ("claude-x", 10, 5, 2, 1, 0.5)


@pytest.mark.parametrize("empty", [{}, None])
def test_usage_falls_back_to_usage_when_model_usage_empty(fx, alice, empty):
    fx.fake.script["用"] = [ResultMessage(result="好", total_cost_usd=0.2, usage={"input_tokens": 7, "output_tokens": 3}, model_usage=empty)]
    sid = fx.session(alice)
    fx.send(alice, sid, "用")
    (r,) = _usage_rows(sid)
    assert (r["input_tokens"], r["output_tokens"], r["cost_usd"]) == (7, 3, 0.2)


def test_final_of_modelusage_key_only_when_present():
    assert "modelUsage" not in sdk_runner._final_of(ResultMessage(model_usage=None))
    assert "modelUsage" not in sdk_runner._final_of(ResultMessage(model_usage={}))
    f = sdk_runner._final_of(ResultMessage(model_usage={"m": {"inputTokens": 1}}, result=None, errors=["坏了", "真的坏了"], is_error=True))
    assert f["modelUsage"] == {"m": {"inputTokens": 1}} and f["result"] == "坏了；真的坏了" and f["type"] == "result"
    assert set(f) >= {"subtype", "is_error", "result", "session_id", "total_cost_usd", "usage"}


# ---------- 10. 开关：切回 cli ----------

def test_switch_back_to_cli_closes_idle_and_next_turn_uses_run_claude(fx, boss, monkeypatch):
    sid = fx.session(boss)
    fx.send(boss, sid, "sdk 一轮")
    assert fx.count() == 1
    r = fx.c.put("/api/admin/settings", json={"runner_mode": "cli"}, headers=boss["headers"])
    assert r.status_code == 200
    assert fx.count() == 0 and fx.fake.instances[0].disconnected == 1
    monkeypatch.setattr(runner, "run_claude", lambda run, prompt, cmd, cwd, emit: {"result": "cli 的回复"})
    fx.send(boss, sid, "cli 一轮")
    assert fx.last(sid)["content"] == "cli 的回复" and len(fx.fake.instances) == 1


def test_mode_switched_during_turn_closes_client_after_it(fx, alice):
    fx.fake.script["慢"] = [Gate("g"), ResultMessage(result="re:慢")]
    sid = fx.session(alice)
    fx.send(alice, sid, "慢", wait=False)
    _started(fx)
    store.set_setting("runner_mode", "cli")
    fx.loop(_set, fx.fake.gate("g"))
    fx.wait(sid)
    assert fx.last(sid)["content"] == "re:慢"
    assert fx.fake.instances[0].disconnected == 1 and fx.count() == 0


def test_mode_still_sdk_keeps_client(fx, alice):
    fx.send(alice, fx.session(alice))
    assert fx.count() == 1 and fx.fake.instances[0].disconnected == 0


def test_sdk_not_installed_message(monkeypatch):
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)   # 模拟没装
    reason = sdk_runner.availability()
    assert reason and "没有安装 claude-agent-sdk" in reason


# ---------- 11. 复用和重建 ----------

def test_two_turns_connect_once(fx, alice):
    sid = fx.session(alice)
    fx.send(alice, sid, "一")
    fx.send(alice, sid, "二")
    (inst,) = fx.fake.instances
    assert inst.connect_calls == 1 and inst.queries == ["一", "二"] and inst.disconnected == 0
    assert [m["content"] for m in fx.msgs(sid, "assistant")] == ["re:一", "re:二"]


def test_switching_to_bypass_rebuilds_with_resume(fx, boss):
    sid = fx.session(boss)
    fx.send(boss, sid, "一")
    store.db("UPDATE sessions SET bypass=1 WHERE id=?", (sid,))
    fx.send(boss, sid, "二")
    a, b = fx.fake.instances
    assert a.disconnected == 1 and a.options.permission_mode is None
    assert b.options.permission_mode == "bypassPermissions" and b.options.resume == "sess-1" and b.queries == ["二"]
    assert fx.count() == 1


def test_rebuild_uses_known_session_id_when_spec_has_none(fx, boss):
    sid = fx.session(boss)
    fx.send(boss, sid, "一")
    store.db("UPDATE sessions SET claude_session=NULL, bypass=1 WHERE id=?", (sid,))
    fx.send(boss, sid, "二")
    assert fx.fake.instances[1].options.resume == "sess-1"   # 客户端自己知道上一轮的会话 id


def test_new_account_changes_deny_rules_and_rebuilds(fx, alice, make_user):
    sid = fx.session(alice)
    fx.send(alice, sid, "一")
    make_user("newcomer")
    fx.send(alice, sid, "二")
    assert len(fx.fake.instances) == 2 and fx.fake.instances[0].disconnected == 1


def test_plugin_and_cwd_changes_rebuild(fx, tmp_path):
    turn(fx, mkspec(tmp_path))
    turn(fx, mkspec(tmp_path))
    assert len(fx.fake.instances) == 1
    turn(fx, mkspec(tmp_path, plugin_dir="/p"))
    assert len(fx.fake.instances) == 2 and fx.opts().plugins == [{"type": "local", "path": "/p"}]
    turn(fx, mkspec(tmp_path, plugin_dir="/p", cwd=str(tmp_path / "other")))
    assert len(fx.fake.instances) == 3
    turn(fx, mkspec(tmp_path, plugin_dir="/p", cwd=str(tmp_path / "other"), allowed=["Read", "Edit"]))
    assert len(fx.fake.instances) == 4
    turn(fx, mkspec(tmp_path, plugin_dir="/p", cwd=str(tmp_path / "other"), allowed=["Read", "Edit"], ask_rules=["Bash(rm:*)"]))
    assert len(fx.fake.instances) == 5 and json.loads(fx.opts().settings) == {"permissions": {"ask": ["Bash(rm:*)"]}}


def test_add_dirs_subset_reuses_otherwise_rebuilds(fx, tmp_path):
    base = mkspec(tmp_path, add_dirs=["/a", "/b"])
    turn(fx, base)
    turn(fx, mkspec(tmp_path, add_dirs=["/b"]))
    turn(fx, mkspec(tmp_path, add_dirs=[]))
    turn(fx, mkspec(tmp_path, add_dirs=["/b", "/a"]))
    assert len(fx.fake.instances) == 1
    turn(fx, mkspec(tmp_path, add_dirs=["/a", "/c"]))   # 多了一个没带过的目录
    assert len(fx.fake.instances) == 2 and fx.opts().add_dirs == ["/a", "/c"]
    assert fx.fake.instances[0].disconnected == 1


def test_policy_is_not_part_of_fingerprint(fx, tmp_path):
    turn(fx, mkspec(tmp_path))
    turn(fx, mkspec(tmp_path, policy=lambda: None))
    assert len(fx.fake.instances) == 1


# ---------- 12. resolve_cli ----------

def _win(monkeypatch):
    monkeypatch.setattr(sdk_runner, "_is_windows", lambda: True)


def test_resolve_cli_non_windows_and_exe_unchanged(monkeypatch):
    assert sdk_runner.resolve_cli("/usr/bin/claude.cmd") == "/usr/bin/claude.cmd"   # 非 Windows 原样
    _win(monkeypatch)
    assert sdk_runner.resolve_cli("C:\\x\\claude.exe") == "C:\\x\\claude.exe"
    assert sdk_runner.resolve_cli("claude") == "claude"


def test_resolve_cli_windows_cmd_finds_exe(monkeypatch, tmp_path):
    _win(monkeypatch)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    sdk_dir = tmp_path / "sdk"
    (sdk_dir / "_bundled").mkdir(parents=True)
    monkeypatch.setattr(sdk_runner, "_load_sdk", lambda: SimpleNamespace(__file__=str(sdk_dir / "__init__.py")))
    on_path = tmp_path / "path" / "claude.exe"
    monkeypatch.setattr(sdk_runner.shutil, "which", lambda name: str(on_path) if on_path.exists() else None)
    cmd = "C:\\npm\\claude.cmd"
    with pytest.raises(sdk_runner.SdkUnavailable) as ei:   # 都没有：报错里带着原路径和怎么办
        sdk_runner.resolve_cli(cmd)
    assert "claude.exe" in str(ei.value) and cmd in str(ei.value) and "CLAUDE_BIN" in str(ei.value)
    (sdk_dir / "_bundled" / "claude.exe").write_text("x")                 # 3. SDK 自带的
    assert sdk_runner.resolve_cli(cmd) == str(sdk_dir / "_bundled" / "claude.exe")
    local = tmp_path / "home" / ".local" / "bin" / "claude.exe"           # 2. 用户目录
    local.parent.mkdir(parents=True)
    local.write_text("x")
    assert sdk_runner.resolve_cli(cmd) == str(local)
    on_path.parent.mkdir()                                                # 1. PATH 上的优先
    on_path.write_text("x")
    assert sdk_runner.resolve_cli("C:\\npm\\claude.BAT") == str(on_path)


def test_run_turn_windows_cmd_without_exe_returns_message(fx, tmp_path, monkeypatch):
    _win(monkeypatch)
    monkeypatch.setenv("HOME", str(tmp_path / "nohome"))
    monkeypatch.setattr(sdk_runner.shutil, "which", lambda name: None)
    final, _ = turn(fx, mkspec(tmp_path, cli_path="C:\\npm\\claude.cmd"))
    assert final["is_error"] and "切回 cli" in final["result"] and "claude.exe" in final["result"]
    assert fx.fake.instances == []


def test_run_turn_windows_requires_proactor_loop(fx, tmp_path, monkeypatch):
    _win(monkeypatch)
    final, _ = turn(fx, mkspec(tmp_path))   # 本机的事件循环不是 Proactor
    assert final["is_error"] and "ProactorEventLoop" in final["result"] and "切回 cli" in final["result"]
    assert fx.fake.instances == []


# ---------- 连接、超时、钩子兜底、关闭 ----------

def test_connect_failure_is_reported_with_hint(fx, alice):
    fx.fake.fail_connect = 1
    sid = fx.session(alice)
    fx.send(alice, sid)
    last = fx.last(sid)
    assert last["role"] == "error" and "sdk 模式不可用" in last["content"] and "起不来" in last["content"] and "切回 cli" in last["content"]
    assert fx.count() == 0 and runner.RUNS == {}
    fx.send(alice, sid, "再试")   # 下一轮重新建，能成功
    assert fx.last(sid)["content"] == "re:再试" and fx.count() == 1


def test_connect_timeout(fx, alice, monkeypatch):
    monkeypatch.setenv("SDK_CONNECT_TIMEOUT", "0.2")
    fx.fake.connect_gate = "never"
    sid = fx.session(alice)
    fx.send(alice, sid)
    last = fx.last(sid)
    assert last["role"] == "error" and "超时" in last["content"] and "切回 cli" in last["content"]
    assert fx.count() == 0


def test_on_failure_unsupported_falls_back_without_it(fx, alice):
    fx.fake.reject_on_failure = True
    sid = fx.session(alice)
    fx.send(alice, sid)
    first, second = fx.fake.instances
    assert first.options.hooks["PreToolUse"][0].on_failure == "block" and first.connect_calls == 1 and not first.connected
    assert second.options.hooks["PreToolUse"][0].on_failure is None and second.connected
    assert callable(second.options.hooks["PreToolUse"][0].hooks[0])   # 钩子本身还在
    assert fx.last(sid)["content"] == "re:你好"
    log = (runner.LOGS / f"claude_{sid}.log").read_text(encoding="utf-8")
    assert "这个版本的 claude 不支持钩子失败即拒绝，改由回调自身兜底" in log


def test_other_connect_errors_do_not_retry(fx, tmp_path):
    fx.fake.fail_connect = 5
    final, _ = turn(fx, mkspec(tmp_path))
    assert final["is_error"] and len(fx.fake.instances) == 1


def test_turn_timeout_kills_client(fx, alice, monkeypatch):
    monkeypatch.setattr(runner, "TASK_TIMEOUT", 0.2)
    fx.fake.script["卡"] = [delta("x"), Gate("never")]
    sid = fx.session(alice)
    fx.send(alice, sid, "卡")
    last = fx.last(sid)
    assert last["role"] == "error" and last["content"].startswith("超过 0 分钟没完成，已停止。")
    assert json.loads(last["meta"]).get("timed_out") is True
    assert fx.fake.kills == [fx.fake.instances[0].proc.pid] and fx.count() == 0


def test_run_turn_timeout_result_shape(fx, tmp_path):
    fx.fake.script["卡"] = [Gate("never")]
    run = new_run()
    final, _ = turn(fx, mkspec(tmp_path, timeout=0.2, resume="r0"), "卡", run)
    assert run.timed_out is True and final == {"is_error": True, "result": "超时", "session_id": "r0"}


def test_close_is_idempotent_and_concurrent(fx, tmp_path):
    turn(fx, mkspec(tmp_path))
    inst = fx.fake.instances[0]

    async def go():
        c = sdk_runner._POOL["d1"]
        await asyncio.gather(c.close(True), c.close(True), c.close(False))
        await c.close(False)
    fx.loop(go)
    assert fx.fake.kills == [inst.proc.pid] and inst.disconnected == 1 and fx.count() == 0


def test_close_kills_again_if_process_survives_disconnect(fx, tmp_path):
    fx.fake.zombie = True
    turn(fx, mkspec(tmp_path))
    pid = fx.fake.instances[0].proc.pid

    async def go():
        await sdk_runner._POOL["d1"].close(False)   # 不强制：disconnect 之后进程还活着 → 补杀一次
    fx.loop(go)
    assert fx.fake.kills == [pid]


def test_close_session_and_close_all_force(fx, tmp_path):
    for sid in ("a", "b", "c"):
        turn(fx, mkspec(tmp_path, sid))
    fx.loop(sdk_runner.close_session, "a")
    fx.loop(sdk_runner.close_session, "nope")   # 不存在：什么都不做
    assert fx.count() == 2 and len(fx.fake.kills) == 1
    fx.loop(sdk_runner.close_all)
    assert fx.count() == 0 and len(fx.fake.kills) == 3 and all(i.disconnected == 1 for i in fx.fake.instances)


def test_close_all_closes_busy_clients_and_turn_ends_with_error(fx, tmp_path):
    fx.fake.script["忙"] = [Gate("never")]
    fut = fx.start(sdk_runner.run_turn, new_run(), "忙", mkspec(tmp_path), lambda e: None)
    _started(fx)
    fx.loop(sdk_runner.close_all)
    final = fut.result(WAIT)
    assert final["is_error"] and "claude 进程异常退出" in final["result"] and fx.count() == 0


def test_late_messages_between_turns_are_dropped(fx, tmp_path):
    spec = mkspec(tmp_path)
    turn(fx, spec, "一")
    inst = fx.fake.instances[0]

    async def late():
        inst.out.put_nowait(delta("迟到的通知"))
        inst.out.put_nowait(ResultMessage(result="迟到的结果"))
        await asyncio.sleep(0.05)
    fx.loop(late)
    final, evs = turn(fx, spec, "二")
    assert final["result"] == "re:二" and evs == []   # 迟到的消息没有混进下一轮


def test_run_turn_never_raises(fx, tmp_path):
    inst_final, _ = turn(fx, mkspec(tmp_path, policy=None), "ok")   # policy 为空不影响这一轮本身
    assert inst_final["result"] == "re:ok"

    fx.fake.ClaudeAgentOptions = lambda **kw: (_ for _ in ()).throw(ValueError("选项不对"))
    final, _ = turn(fx, mkspec(tmp_path, sid="other"))
    assert final["is_error"] and "选项不对" in final["result"]
    assert fx.loop(_pool_keys) == {"d1"}   # 失败的那个没留在池里


def test_query_failure_returns_error_and_closes(fx, tmp_path):
    turn(fx, mkspec(tmp_path))
    inst = fx.fake.instances[0]

    async def bad_query(prompt, session_id="default"):
        raise CLIConnectionError("管道坏了")
    inst.query = bad_query
    final, _ = turn(fx, mkspec(tmp_path), "再来")
    assert final["is_error"] and "管道坏了" in final["result"] and fx.count() == 0


def test_on_event_exception_does_not_break_turn(fx, tmp_path):
    fx.fake.script["x"] = [delta("a"), ResultMessage(result="done")]

    def bad(ev):
        raise RuntimeError("订阅者出错")
    final = fx.loop(sdk_runner.run_turn, new_run(), "x", mkspec(tmp_path), bad)
    assert final["result"] == "done"


# ---------- 日志 ----------

def test_log_header_and_stderr(fx, alice):
    fx.fake.stderr_on_connect = ["warn: 一行 stderr"]
    sid = fx.session(alice)
    store.db("UPDATE sessions SET claude_session='abc' WHERE id=?", (sid,))
    fx.send(alice, sid)
    log = (runner.LOGS / f"claude_{sid}.log").read_text(encoding="utf-8")
    assert "[sdk]" in log and "claude" in log and "resume abc" in log and "warn: 一行 stderr" in log


def test_stderr_keeps_last_50_lines(fx, tmp_path):
    fx.fake.stderr_on_connect = [f"行{i}" for i in range(80)]
    turn(fx, mkspec(tmp_path))

    async def tail():
        return list(sdk_runner._POOL["d1"].stderr_tail)
    t = fx.loop(tail)
    assert len(t) == 50 and t[0] == "行30" and t[-1] == "行79"


def test_log_write_failure_is_harmless(fx, tmp_path):
    sdk_runner._append_log(str(tmp_path), "x")   # 路径是目录：写不进去，不抛
    sdk_runner._append_log("", "x")
    final, _ = turn(fx, mkspec(tmp_path, log_path=str(tmp_path / "no" / "such" / "dir" / "x.log")))
    assert final["result"] == "re:p"


# ---------- 防参数名写错：用真的 SDK 的 ClaudeAgentOptions 走一遍选项构造 ----------

def test_build_options_with_real_sdk(tmp_path):
    real = pytest.importorskip("claude_agent_sdk")
    spec = mkspec(tmp_path, bypass=False, ask_rules=["Bash(rm:*)"], plugin_dir="/p", allowed=["Read", "mcp__projector__ask_user"])
    o = sdk_runner.build_options(real, spec, cli_path="/bin/claude", resume="r1", stderr=lambda line: None)
    assert isinstance(o, real.ClaudeAgentOptions)
    assert o.cli_path == "/bin/claude" and o.resume == "r1" and o.cwd == str(tmp_path)
    assert o.hooks["PreToolUse"][0].on_failure == "block" and callable(o.hooks["PreToolUse"][0].hooks[0])
    assert callable(o.can_use_tool) and set(o.mcp_servers) == {"center", "projector"}
    assert o.mcp_servers["projector"]["type"] == "sdk"
    assert o.system_prompt == {"type": "preset", "preset": "claude_code"}
    assert o.extra_args == {"append-system-prompt-file": spec.hint_file}
    assert o.include_partial_messages is True and o.max_buffer_size == 32 * 1024 * 1024
    assert json.loads(o.settings) == {"permissions": {"ask": ["Bash(rm:*)"]}}
    assert o.plugins == [{"type": "local", "path": "/p"}] and o.permission_mode is None
    o2 = sdk_runner.build_options(real, mkspec(tmp_path, bypass=True), cli_path="c", block=False)
    assert o2.permission_mode == "bypassPermissions" and o2.hooks["PreToolUse"][0].on_failure is None and o2.settings is None
