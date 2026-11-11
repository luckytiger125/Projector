"""sdk 运行方式的开关和接线（计划 §8 第 2 步）：runner_mode / sdk_idle_seconds、设置接口、不可用时的报错、
sdk 模式下一轮走通（run_turn 用假协程）、停止、build_sdk_spec 的三档，以及 approvals.wait_approval / wait_question。
不依赖真的 claude 和真的 claude-agent-sdk。等待都靠 threading.Event / run.done，不靠 sleep。"""
import asyncio
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import approvals
import runner
import sdk_runner
import store

import server  # noqa: E402  (conftest 已先设好临时目录)

WAIT = 10
SETTING_KEYS = ("runner_mode", "sdk_idle_seconds", "perm_mode", "ask_cmds", "bash_allow")


def _wipe_settings():
    for k in SETTING_KEYS:
        store.db("DELETE FROM settings WHERE key=?", (k,))


@pytest.fixture(autouse=True)
def clean_settings(monkeypatch):
    monkeypatch.delenv("RUNNER_MODE", raising=False)
    monkeypatch.delenv("SDK_IDLE_SECONDS", raising=False)
    _wipe_settings()
    runner.RUNS.clear()
    yield
    _wipe_settings()
    runner.RUNS.clear()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(runner, "find_claude", lambda: "claude")
    with TestClient(server.app) as c:
        yield c
        while runner.RUNS:   # 收尾：等还在跑的轮次结束
            c.portal.call(next(iter(runner.RUNS.values())).done.wait)


@pytest.fixture
def alice(make_user):
    return make_user("alice", display_name="爱丽丝")


@pytest.fixture
def admin(make_user):
    return make_user("boss", role="admin")


def _new_session(c, user):
    return c.post("/api/sessions", json={}, headers=user["headers"]).json()["id"]


def _send(c, user, sid, text="你好"):
    return c.post(f"/api/sessions/{sid}/messages", json={"text": text}, headers=user["headers"])


# ---------- runner_mode / sdk_idle_seconds ----------

def test_runner_mode_default_is_cli():
    assert runner.runner_mode() == "cli"


def test_runner_mode_env(monkeypatch):
    monkeypatch.setenv("RUNNER_MODE", " SDK ")
    assert runner.runner_mode() == "sdk"
    monkeypatch.setenv("RUNNER_MODE", "cli")
    assert runner.runner_mode() == "cli"


def test_runner_mode_setting_beats_env(monkeypatch):
    monkeypatch.setenv("RUNNER_MODE", "sdk")
    store.set_setting("runner_mode", "cli")
    assert runner.runner_mode() == "cli"
    monkeypatch.setenv("RUNNER_MODE", "cli")
    store.set_setting("runner_mode", "sdk")
    assert runner.runner_mode() == "sdk"


@pytest.mark.parametrize("bad", ["", "foo", "SDK2", 5])
def test_runner_mode_invalid_falls_back_to_cli(monkeypatch, bad):
    monkeypatch.setenv("RUNNER_MODE", "sdk")
    store.set_setting("runner_mode", bad)   # 设置里是非法值：按 cli（不再回退到环境变量，和 perm_mode 的做法一致）
    assert runner.runner_mode() == "cli"


def test_runner_mode_invalid_env_falls_back_to_cli(monkeypatch):
    monkeypatch.setenv("RUNNER_MODE", "bogus")
    assert runner.runner_mode() == "cli"


def test_sdk_idle_seconds_priority_and_limits(monkeypatch):
    assert runner.sdk_idle_seconds() == 600
    monkeypatch.setenv("SDK_IDLE_SECONDS", "120")
    assert runner.sdk_idle_seconds() == 120
    store.set_setting("sdk_idle_seconds", 300)
    assert runner.sdk_idle_seconds() == 300   # 设置优先于环境变量
    store.set_setting("sdk_idle_seconds", 5)
    assert runner.sdk_idle_seconds() == 30
    store.set_setting("sdk_idle_seconds", 10 ** 9)
    assert runner.sdk_idle_seconds() == 86400
    store.set_setting("sdk_idle_seconds", "abc")
    assert runner.sdk_idle_seconds() == 120   # 设置解析失败：用默认（环境变量的值）
    store.db("DELETE FROM settings WHERE key='sdk_idle_seconds'")
    monkeypatch.setenv("SDK_IDLE_SECONDS", "xyz")
    assert runner.sdk_idle_seconds() == 600
    monkeypatch.setenv("SDK_IDLE_SECONDS", "1")
    assert runner.sdk_idle_seconds() == 30


# ---------- 设置接口 ----------

def test_settings_get_has_new_fields(client, admin, monkeypatch):
    monkeypatch.setattr(sdk_runner, "availability", lambda: "没装")
    body = client.get("/api/admin/settings", headers=admin["headers"]).json()
    assert body["runner_mode"] == "cli" and body["sdk_available"] is False and body["sdk_error"] == "没装"
    assert body["sdk_idle_seconds"] == 600 and body["sdk_clients"] == 0
    for k in ("perm_mode", "bash_allow", "ask_cmds", "safe", "default_ask", "default_allow", "max_concurrent"):
        assert k in body   # 原有字段一个都不少
    monkeypatch.setattr(sdk_runner, "availability", lambda: None)
    body = client.get("/api/admin/settings", headers=admin["headers"]).json()
    assert body["sdk_available"] is True and body["sdk_error"] == ""


def test_settings_put_runner_mode_and_idle(client, admin, monkeypatch):
    closed = []

    async def fake_close_idle(now=None):
        closed.append(now)
        return 0
    monkeypatch.setattr(sdk_runner, "close_idle", fake_close_idle)
    monkeypatch.setattr(sdk_runner, "availability", lambda: "没装")   # 不可用时也允许存成 sdk
    h = admin["headers"]
    r = client.put("/api/admin/settings", json={"runner_mode": "sdk", "sdk_idle_seconds": 90}, headers=h)
    assert r.status_code == 200 and r.json()["runner_mode"] == "sdk" and r.json()["sdk_idle_seconds"] == 90
    assert closed == []   # 切到 sdk 不用关
    r = client.put("/api/admin/settings", json={"runner_mode": "foo"}, headers=h)   # 非法值忽略
    assert r.status_code == 200 and r.json()["runner_mode"] == "sdk"
    r = client.put("/api/admin/settings", json={"runner_mode": "cli"}, headers=h)
    assert r.json()["runner_mode"] == "cli"
    assert closed == [float("inf")]   # 切回 cli：关掉空闲的


@pytest.mark.parametrize("n", [0, 29, 86401])
def test_settings_put_bad_idle_seconds(client, admin, n):
    r = client.put("/api/admin/settings", json={"sdk_idle_seconds": n, "runner_mode": "sdk"}, headers=admin["headers"])
    assert r.status_code == 400 and "30" in r.json()["detail"]
    assert store.get_setting("sdk_idle_seconds") is None and store.get_setting("runner_mode") is None   # 400 时什么都没存


def test_settings_put_requires_admin(client, alice):
    assert client.put("/api/admin/settings", json={"runner_mode": "sdk"}, headers=alice["headers"]).status_code == 403


# ---------- sdk 模式：不可用 ----------

def test_sdk_mode_unavailable_returns_500_and_leaves_nothing(client, alice, monkeypatch):
    store.set_setting("runner_mode", "sdk")
    monkeypatch.setattr(sdk_runner, "availability", lambda: "没有安装 claude-agent-sdk")
    called = []
    monkeypatch.setattr(runner, "run_claude", lambda *a, **k: called.append("run_claude"))
    monkeypatch.setattr(runner, "build_command", lambda *a, **k: called.append("build_command"))
    sid = _new_session(client, alice)
    r = _send(client, alice, sid)
    assert r.status_code == 500
    detail = r.json()["detail"]
    assert "切回 cli" in detail and "没有安装 claude-agent-sdk" in detail and detail.startswith("sdk 模式不可用：")
    assert runner.RUNS == {}
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0
    assert store.db("SELECT COUNT(*) AS c FROM messages WHERE session_id=?", (sid,), one=True)["c"] == 0
    assert called == []


# ---------- sdk 模式：一轮走通 / 停止 ----------

def test_sdk_mode_turn_flows_through(client, alice, monkeypatch):
    store.set_setting("runner_mode", "sdk")
    monkeypatch.setattr(sdk_runner, "availability", lambda: None)
    monkeypatch.setattr(runner, "run_claude", lambda *a, **k: pytest.fail("sdk 模式不该调 run_claude"))
    monkeypatch.setattr(runner, "build_command", lambda *a, **k: pytest.fail("sdk 模式不该调 build_command"))
    seen = {}

    async def fake_run_turn(run, prompt, spec, on_event):
        seen.update(run=run, prompt=prompt, spec=spec)
        on_event({"type": "delta_reset"})
        on_event({"type": "delta", "text": "好"})
        seen["live_text"] = run.text
        return {"type": "result", "result": "好的", "session_id": "abc",
                "usage": {"input_tokens": 3, "output_tokens": 4}, "total_cost_usd": 0.01}
    monkeypatch.setattr(sdk_runner, "run_turn", fake_run_turn)

    sid = _new_session(client, alice)
    r = _send(client, alice, sid, "你好")
    assert r.status_code == 200 and r.json() == {"ok": True}
    # run_turn 在事件循环里被调用；等这一轮收尾
    async def wait_done():
        while "run" not in seen:
            await asyncio.sleep(0)
        await seen["run"].done.wait()
    client.portal.call(wait_done)

    assert seen["prompt"] == "你好" and seen["spec"].sid == sid and seen["live_text"] == "好"
    assert seen["run"].stop_fn is not None
    msgs = store.db("SELECT role, content FROM messages WHERE session_id=? ORDER BY id", (sid,))
    assert [(m["role"], m["content"]) for m in msgs] == [("user", "你好"), ("assistant", "好的")]
    assert store.db("SELECT claude_session FROM sessions WHERE id=?", (sid,), one=True)["claude_session"] == "abc"
    rows = store.db("SELECT input_tokens, output_tokens, cost_usd FROM usage_turns WHERE session_id=?", (sid,))
    assert len(rows) == 1 and rows[0]["input_tokens"] == 3 and rows[0]["output_tokens"] == 4
    assert runner.RUNS == {}
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0
    # sdk 模式只写提示词文件，不写 settings / guard / mcp 配置
    assert (store.DATA / "mcp" / f"hint_{sid}.txt").exists()
    for f in (f"settings_{sid}.json", f"guard_{sid}.json", f"{sid}.json"):
        assert not (store.DATA / "mcp" / f).exists()


def test_sdk_mode_run_turn_exception_is_reported(client, alice, monkeypatch):
    store.set_setting("runner_mode", "sdk")
    monkeypatch.setattr(sdk_runner, "availability", lambda: None)
    holder = {}

    async def boom(run, prompt, spec, on_event):
        holder["run"] = run
        raise RuntimeError("炸了")
    monkeypatch.setattr(sdk_runner, "run_turn", boom)
    sid = _new_session(client, alice)
    _send(client, alice, sid)

    async def wait_done():
        while "run" not in holder:
            await asyncio.sleep(0)
        await holder["run"].done.wait()
    client.portal.call(wait_done)
    last = store.db("SELECT role, content FROM messages WHERE session_id=? ORDER BY id DESC", (sid,), one=True)
    assert last["role"] == "error" and "sdk 运行出错：炸了" in last["content"] and "切回 cli" in last["content"]
    assert runner.RUNS == {}


def test_sdk_mode_stop_calls_stop_fn(client, alice, monkeypatch):
    store.set_setting("runner_mode", "sdk")
    monkeypatch.setattr(sdk_runner, "availability", lambda: None)
    started = threading.Event()
    holder = {}
    stops = []

    async def hanging_run_turn(run, prompt, spec, on_event):
        holder["gate"] = asyncio.Event()
        holder["run"] = run
        started.set()
        await holder["gate"].wait()
        return {"type": "result", "result": "被打断了", "session_id": "zzz"}

    def fake_request_stop(sid):
        stops.append(sid)
        holder["gate"].set()
    monkeypatch.setattr(sdk_runner, "run_turn", hanging_run_turn)
    monkeypatch.setattr(sdk_runner, "request_stop", fake_request_stop)

    sid = _new_session(client, alice)
    assert _send(client, alice, sid).status_code == 200
    assert started.wait(WAIT)
    r = client.post(f"/api/sessions/{sid}/stop", headers=alice["headers"])
    assert r.status_code == 200 and stops == [sid]
    client.portal.call(holder["run"].done.wait)
    last = store.db("SELECT role, content FROM messages WHERE session_id=? ORDER BY id DESC", (sid,), one=True)
    assert last["role"] == "error" and last["content"].startswith("已停止。")
    assert holder["run"].stopped is True and runner.RUNS == {}


def test_sdk_close_session_swallows_errors(client, monkeypatch):
    async def bad(sid):
        raise RuntimeError("x")
    monkeypatch.setattr(sdk_runner, "close_session", bad)
    client.portal.call(runner.sdk_close_session, "nope")   # 不抛


def test_delete_session_closes_sdk_client(client, alice, monkeypatch):
    closed = []

    async def fake_close(sid):
        closed.append(sid)
    monkeypatch.setattr(sdk_runner, "close_session", fake_close)
    sid = _new_session(client, alice)
    assert client.delete(f"/api/sessions/{sid}", headers=alice["headers"]).status_code == 200
    assert closed == [sid]


# ---------- build_sdk_spec 三档 ----------

@pytest.fixture
def users(make_user):
    a = make_user("zhang", display_name="张三")
    b = make_user("li", display_name="李四")
    boss = make_user("boss2", role="admin")
    return store.get_user(a["id"]), store.get_user(b["id"]), store.get_user(boss["id"])


def _sess(user, **kw):
    row = {"id": f"sdk{user['id']}x", "user_id": user["id"], "bypass": 0, "claude_session": None, "work_dir": None}
    row.update(kw)
    return row


def _common_checks(spec, owner, sess):
    assert spec.disallowed[0] == "AskUserQuestion"
    assert spec.disallowed[-2:] == ["mcp__center__approve", "mcp__center__ask_user"]
    assert spec.disallowed[1:-2] == runner._deny_rules(owner) and spec.disallowed[1:-2]
    assert spec.sid == sess["id"] and spec.owner_id == owner["id"] and spec.cli_path == "claude"
    assert spec.timeout == runner.TASK_TIMEOUT
    assert spec.log_path == str(runner.LOGS / f"claude_{sess['id']}.log")
    assert spec.hint_file == str(store.DATA / "mcp" / f"hint_{sess['id']}.txt") and Path(spec.hint_file).exists()
    assert spec.mcp_center["command"] and spec.mcp_center["args"][0].endswith("approval_mcp.py")
    assert spec.mcp_center["env"]["CENTER_SESSION"] == sess["id"]
    pol = spec.policy()
    assert pol.own == [str(store.user_ws_dir(owner, create=False))]
    for f in (f"settings_{sess['id']}.json", f"guard_{sess['id']}.json", f"{sess['id']}.json"):
        assert not (store.DATA / "mcp" / f).exists()


def test_spec_standard(users):
    ua, ub, boss = users
    sess = _sess(ua)
    spec = runner.build_sdk_spec("claude", sess, ua, [])
    _common_checks(spec, ua, sess)
    assert spec.bypass is False and spec.ask_rules and spec.ask_rules[0].startswith("Bash(")
    assert "Bash" in spec.allowed and "Edit" in spec.allowed
    assert "mcp__projector__ask_user" in spec.allowed and "mcp__center__ask_user" not in spec.allowed
    assert "mcp__center__kb_search" in spec.allowed and spec.allowed.count("mcp__projector__ask_user") == 1


def test_spec_strict(users, monkeypatch):
    ua, ub, boss = users
    monkeypatch.setattr(runner, "perm_mode", lambda: "strict")
    sess = _sess(ua)
    spec = runner.build_sdk_spec("claude", sess, ua, [])
    _common_checks(spec, ua, sess)
    assert spec.bypass is False and spec.ask_rules == []
    assert "Bash" not in spec.allowed and "Bash(ls:*)" in spec.allowed and "Bash(python:*)" in spec.allowed
    assert "mcp__projector__ask_user" in spec.allowed and "mcp__center__ask_user" not in spec.allowed


def test_spec_bypass(users):
    ua, ub, boss = users
    sess = _sess(boss, bypass=1)
    spec = runner.build_sdk_spec("claude", sess, boss, [])
    _common_checks(spec, boss, sess)
    assert spec.bypass is True and spec.allowed == [] and spec.ask_rules == []


def test_spec_bypass_ignored_without_permission(users):
    ua, ub, boss = users
    spec = runner.build_sdk_spec("claude", _sess(ua, bypass=1), ua, [])   # 普通账号没有完全放行的权限
    assert spec.bypass is False and spec.allowed


def test_spec_matches_command_rules(users):
    """同一套名单和规则：和 build_command 生成的 --allowedTools 一致（只差被替换的那个工具）。"""
    ua, ub, boss = users
    sess = _sess(ua)
    cmd = runner.build_command("claude", sess, ua, [])
    allowed = cmd[cmd.index("--allowedTools") + 1:cmd.index("--settings")]
    spec = runner.build_sdk_spec("claude", sess, ua, [])
    assert [("mcp__center__ask_user" if t == "mcp__projector__ask_user" else t) for t in spec.allowed] == allowed


def test_spec_resume_dirs_plugin(users, monkeypatch):
    ua, ub, boss = users
    monkeypatch.setattr(runner.skills_api, "plugin_dir_for", lambda owner: Path("/tmp/plug"))
    spec = runner.build_sdk_spec("claude", _sess(ua, claude_session="abc-123", work_dir="/tmp/w"), ua,
                                 [Path("/a"), Path("/a"), Path("/b"), Path("/a")])
    assert spec.resume == "abc-123" and spec.add_dirs == [str(Path("/a")), str(Path("/b"))]
    assert spec.plugin_dir == str(Path("/tmp/plug")) and spec.cwd == "/tmp/w"
    monkeypatch.setattr(runner.skills_api, "plugin_dir_for", lambda owner: None)
    spec = runner.build_sdk_spec("claude", _sess(ua, claude_session=""), ua, [])
    assert spec.resume is None and spec.plugin_dir is None and spec.add_dirs == []


def test_spec_policy_is_fetched_lazily(users, make_user):
    ua, ub, boss = users
    spec = runner.build_sdk_spec("claude", _sess(ua), ua, [])
    before = spec.policy().other_names
    make_user("newcomer")
    assert len(spec.policy().other_names) == len(before) + 1   # 新建账号立刻生效


# ---------- approvals.wait_approval / wait_question ----------

@pytest.fixture
def sess_ids(client, alice):
    return _new_session(client, alice), alice


def _events(sid):
    return [m["content"] for m in store.db("SELECT content FROM messages WHERE session_id=? AND role='event' ORDER BY id", (sid,))]


def _decide(client, sid, uid, allow):
    async def go():
        t = asyncio.ensure_future(approvals.wait_approval(sid, uid, "Bash", {"command": "ls"}))
        await asyncio.sleep(0)   # 让它跑到等待 future 的地方
        (a,) = approvals.pending_for(sid)
        approvals.resolve_approval(a["id"], allow, "爱丽丝")
        return await t, approvals.pending_for(sid)
    return client.portal.call(go)


def test_wait_approval_allow(client, sess_ids):
    sid, alice = sess_ids
    (allow, message), left = _decide(client, sid, 0, True)
    assert allow is True and message == "" and left == []
    assert _events(sid) == ["✔ 已同意（爱丽丝）：运行命令：ls"]


def test_wait_approval_deny(client, sess_ids):
    sid, alice = sess_ids
    (allow, message), left = _decide(client, sid, 0, False)
    assert allow is False and message == "用户拒绝了这个操作，不要重试同样的操作" and left == []
    assert _events(sid) == ["✘ 已拒绝（爱丽丝）：运行命令：ls"]


def test_wait_approval_timeout(client, sess_ids, monkeypatch):
    sid, alice = sess_ids
    monkeypatch.setattr(approvals, "APPROVAL_TIMEOUT", 0.05)
    result = client.portal.call(approvals.wait_approval, sid, 0, "Write", {"file_path": "/x/a.txt"})
    assert result == (False, "等待用户确认超时")
    assert _events(sid) == ["⌛ 确认超时，已拒绝：新建或覆盖文件：/x/a.txt"] and approvals.APPROVALS == {}


def test_reject_by_guard_records_event(client, sess_ids):
    sid, alice = sess_ids
    approvals.reject_by_guard(sid, "Read", {"file_path": "/y"})
    assert _events(sid) == ["⛔ 已自动拒绝（涉及其他人的个人文件或系统数据）：使用 Read：/y"]


QS = [{"question": "选哪个？", "header": "方案", "options": [{"label": "甲"}, {"label": "乙", "description": "备选"}],
       "multi_select": False}]


def _answer_question(client, sid, payload):
    async def go():
        t = asyncio.ensure_future(approvals.wait_question(sid, 0, QS))
        await asyncio.sleep(0)
        (q,) = approvals.questions_for(sid)
        q["future"].set_result(payload)
        return await t, approvals.questions_for(sid)
    return client.portal.call(go)


def test_wait_question_answer(client, sess_ids):
    sid, _ = sess_ids
    text, left = _answer_question(client, sid, (True, {"answers": [{"selected": ["甲"], "note": "快点"}], "skipped": False}))
    assert text == "用户的回答：\n1. 选哪个？ → 甲（备注：快点）" and left == []


def test_wait_question_skipped(client, sess_ids):
    sid, _ = sess_ids
    text, _ = _answer_question(client, sid, (True, {"answers": [], "skipped": True}))
    assert text.startswith("用户跳过了这些问题，没有选择。")


def test_wait_question_task_ended(client, sess_ids):
    sid, _ = sess_ids
    text, _ = _answer_question(client, sid, (False, "任务已结束"))
    assert text == "任务已结束"


def test_wait_question_timeout(client, sess_ids, monkeypatch):
    sid, _ = sess_ids
    monkeypatch.setattr(approvals, "APPROVAL_TIMEOUT", 0.05)
    text = client.portal.call(approvals.wait_question, sid, 0, QS)
    assert text == "用户 30 分钟内没有回答。" and approvals.QUESTIONS == {}
    assert _events(sid) == ["⌛ 问题超时没有回答"]


@pytest.mark.parametrize("raw", [[], None, "abc", [5, None, "x"], [{"question": "没选项"}], [{"options": [{"label": "甲"}]}],
                                 [{"question": "q", "options": "甲"}], [{"question": "q", "options": [{"label": " "}, 3]}],
                                 [{"question": None, "options": [{"label": "甲"}]}]])
def test_wait_question_bad_format(client, sess_ids, raw):
    sid, _ = sess_ids
    text = client.portal.call(approvals.wait_question, sid, 0, raw)
    assert text == "问题格式不对：每个问题要有 question 和至少一个带 label 的选项。" and approvals.QUESTIONS == {}


def test_wait_question_tolerates_missing_keys(client, sess_ids):
    sid, _ = sess_ids

    async def go():
        t = asyncio.ensure_future(approvals.wait_question(sid, 0, [{"question": "q", "options": [{"label": "甲"}, 7]}]))
        await asyncio.sleep(0)
        (q,) = approvals.questions_for(sid)
        q["future"].set_result((True, {"answers": [{"selected": ["甲"]}], "skipped": False}))
        return q["questions"], await t
    qs, text = client.portal.call(go)
    assert qs == [{"question": "q", "header": "", "options": [{"label": "甲", "description": ""}], "multi_select": False}]
    assert text == "用户的回答：\n1. q → 甲"
