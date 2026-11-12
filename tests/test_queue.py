"""排队、并发上限、运行状态持久化和重启恢复。
假的 run_claude 在线程里按“消息文字”挂起，测试里用 threading.Event 精确放行；等一轮结束用 run.done（事件循环里的 asyncio.Event），
不靠 sleep 同步。TestClient 必须用 with（保持同一个事件循环，后台的 _drive 任务才不会被丢掉）。"""
import asyncio
import json
import sqlite3
import threading
import time

import pytest
from fastapi.testclient import TestClient

import runner
import store

import server  # noqa: E402  (conftest 已先设好临时目录)

WAIT = 10


class FakeClaude:
    """替代 runner.run_claude：记录开始顺序和并发高水位，按 prompt 挂起直到被放行。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.started, self.gates = {}, {}
        self.cur = self.hwm = 0
        self.order = []
        self.all_open = False

    def _ev(self, table, key):
        with self.lock:
            ev = table.setdefault(key, threading.Event())
            if self.all_open and table is self.gates:
                ev.set()
            return ev

    def __call__(self, run, prompt, cmd, cwd, emit):
        class Proc:  # stop_session 会调 _kill_tree(run.proc)：kill 一下就是放行
            poll = staticmethod(lambda: None)
            kill = staticmethod(lambda: gate.set())
        gate = self._ev(self.gates, prompt)
        run.proc = Proc()
        with self.lock:
            self.cur += 1
            self.hwm = max(self.hwm, self.cur)
            self.order.append(prompt)
        self._ev(self.started, prompt).set()
        try:
            assert gate.wait(WAIT), "测试没有放行这一轮"
            if prompt == "boom":
                raise RuntimeError("boom")
        finally:
            with self.lock:
                self.cur -= 1
        return {"result": "re:" + prompt}

    def wait_started(self, prompt):
        assert self._ev(self.started, prompt).wait(WAIT), f"{prompt} 没有开始"

    def release(self, prompt):
        self._ev(self.gates, prompt).set()


class Env:
    def __init__(self, client, fake):
        self.c, self.fake = client, fake

    def on_loop(self, fn):
        async def w():
            return fn()
        return self.c.portal.call(w)

    def finish(self, sid, prompt):
        """放行一轮并等它在事件循环里彻底收尾（含 dispatch_queue）。"""
        run = runner.RUNS[sid]
        self.fake.release(prompt)
        self.c.portal.call(run.done.wait)

    def new_session(self, user, work_dir=None):
        body = {"work_dir": work_dir} if work_dir else {}
        return self.c.post("/api/sessions", json=body, headers=user["headers"]).json()["id"]

    def send(self, user, sid, text):
        return self.c.post(f"/api/sessions/{sid}/messages", json={"text": text}, headers=user["headers"])

    def view(self, user, sid):
        return self.c.get(f"/api/sessions/{sid}", headers=user["headers"]).json()

    def roles(self, user, sid):
        return [m["role"] for m in self.view(user, sid)["messages"]]

    def set_limit(self, admin, n):
        r = self.c.put("/api/admin/settings", json={"max_concurrent": n}, headers=admin["headers"])
        assert r.status_code == 200, r.text


@pytest.fixture
def env(monkeypatch):
    fake = FakeClaude()
    monkeypatch.setattr(runner, "run_claude", fake)
    monkeypatch.setattr(runner, "find_claude", lambda: "claude")
    monkeypatch.setattr(runner, "build_command", lambda *a, **k: ["claude"])
    # 假进程没有 pid；Windows 上真的 _kill_tree 会去调 taskkill，这里统一换成直接 kill
    monkeypatch.setattr(runner, "_kill_tree", lambda proc: proc.kill() if proc.poll() is None else None)
    monkeypatch.delenv("MAX_CONCURRENT", raising=False)
    store.db("DELETE FROM settings WHERE key='max_concurrent'")
    runner.RUNS.clear()
    with TestClient(server.app) as c:
        e = Env(c, fake)
        yield e
        fake.all_open = True   # 收尾：放行所有挂着的轮次，等它们（以及陆续开始的排队项）结束
        for ev in list(fake.gates.values()):
            ev.set()
        while runner.RUNS:
            c.portal.call(next(iter(runner.RUNS.values())).done.wait)
    store.db("DELETE FROM settings WHERE key='max_concurrent'")


@pytest.fixture
def alice(make_user):
    return make_user("alice", display_name="爱丽丝")


@pytest.fixture
def admin(make_user):
    return make_user("boss", role="admin")


# ---------- 排队 ----------

def test_send_while_running_queues_then_starts(env, alice):
    sid = env.new_session(alice)
    r1 = env.send(alice, sid, "A")
    assert r1.status_code == 200 and r1.json() == {"ok": True}   # 没排队时的返回和以前完全一样
    env.fake.wait_started("A")
    r2 = env.send(alice, sid, "B")
    assert r2.status_code == 200
    body = r2.json()
    assert body["queued"] is True and body["position"] == 1 and isinstance(body["queue_id"], int)
    assert env.send(alice, sid, "C").json()["position"] == 2

    v = env.view(alice, sid)
    assert [q["text"] for q in v["session"]["queue"]] == ["B", "C"]
    assert v["session"]["queue"][0]["id"] == body["queue_id"] and v["session"]["queue"][0]["author_name"] == "爱丽丝"
    assert v["session"]["status"] == "running"
    assert [m["role"] for m in v["messages"]] == ["user"]   # 排队的还没写进聊天记录

    env.finish(sid, "A")
    env.fake.wait_started("B")
    msgs = env.view(alice, sid)["messages"]
    assert [(m["role"], m["content"]) for m in msgs] == [("user", "A"), ("assistant", "re:A"), ("user", "B")]
    assert [q["text"] for q in env.view(alice, sid)["session"]["queue"]] == ["C"]
    env.finish(sid, "B")
    env.fake.wait_started("C")
    env.finish(sid, "C")
    assert env.roles(alice, sid) == ["user", "assistant"] * 3
    assert store.db("SELECT COUNT(*) AS c FROM turn_queue", one=True)["c"] == 0
    assert env.fake.order == ["A", "B", "C"]


def test_queue_cap_409(env, alice):
    sid = env.new_session(alice)
    env.send(alice, sid, "A")
    env.fake.wait_started("A")
    for i in range(runner.QUEUE_CAP):
        assert env.send(alice, sid, f"q{i}").json()["queued"] is True
    r = env.send(alice, sid, "overflow")
    assert r.status_code == 409 and "5" in r.json()["detail"]
    assert len(env.view(alice, sid)["session"]["queue"]) == runner.QUEUE_CAP


def test_cancel_endpoint_and_permissions(env, alice, admin, make_user):
    bob = make_user("bob")
    sid, other = env.new_session(alice), env.new_session(alice)
    env.send(alice, sid, "A")
    env.fake.wait_started("A")
    q1 = env.send(alice, sid, "B").json()["queue_id"]
    q2 = env.send(alice, sid, "C").json()["queue_id"]
    url = lambda s, q: f"/api/sessions/{s}/queue/{q}"
    assert env.c.delete(url(sid, q1), headers=bob["headers"]).status_code == 404   # 别人的会话
    assert env.c.delete(url(other, q1), headers=alice["headers"]).status_code == 404   # 条目不属于这个会话
    assert env.c.delete(url(sid, q1)).status_code == 401
    assert env.c.delete(url(sid, q1), headers=alice["headers"]).json() == {"ok": True}
    assert [q["text"] for q in env.view(alice, sid)["session"]["queue"]] == ["C"]
    assert env.c.delete(url(sid, q1), headers=alice["headers"]).status_code == 404   # 已经取消过
    assert env.c.delete(url(sid, q2), headers=admin["headers"]).status_code == 200   # 管理员可以
    assert env.view(alice, sid)["session"]["queue"] == []
    env.finish(sid, "A")
    assert env.fake.order == ["A"]   # 取消掉的没有再开始


def test_stop_clears_queue_and_records_texts(env, alice):
    sid = env.new_session(alice)
    env.send(alice, sid, "A")
    env.fake.wait_started("A")
    env.send(alice, sid, "写给老王的邮件")
    env.send(alice, sid, "第二条")
    run = runner.RUNS[sid]
    assert env.c.post(f"/api/sessions/{sid}/stop", headers=alice["headers"]).status_code == 200
    env.c.portal.call(run.done.wait)
    assert env.view(alice, sid)["session"]["queue"] == []
    assert store.db("SELECT COUNT(*) AS c FROM turn_queue", one=True)["c"] == 0
    events = [m for m in env.view(alice, sid)["messages"] if m["role"] == "event"]
    assert len(events) == 1
    assert "写给老王的邮件" in events[0]["content"] and "第二条" in events[0]["content"]
    assert events[0]["meta"]["queue_cancelled"] is True
    assert env.fake.order == ["A"] and not runner.RUNS


def test_stop_without_queue_adds_no_event(env, alice):
    sid = env.new_session(alice)
    env.send(alice, sid, "A")
    env.fake.wait_started("A")
    run = runner.RUNS[sid]
    env.c.post(f"/api/sessions/{sid}/stop", headers=alice["headers"])
    env.c.portal.call(run.done.wait)
    assert "event" not in env.roles(alice, sid)


# ---------- 全局并发上限 ----------

def test_global_limit_fifo_across_sessions(env, alice, admin):
    env.set_limit(admin, 1)
    s1, s2, s3 = (env.new_session(alice) for _ in range(3))
    assert env.send(alice, s1, "A").json() == {"ok": True}
    env.fake.wait_started("A")
    rb = env.send(alice, s2, "B")   # 另一个会话也要排队：上限是 1
    assert rb.json()["queued"] is True and rb.json()["position"] == 1
    assert env.send(alice, s1, "D").json()["queued"] is True
    assert env.send(alice, s3, "E").json()["queued"] is True
    assert env.view(alice, s2)["session"]["status"] == "queued"
    assert runner.RUNS.keys() == {s1}

    env.finish(s1, "A")   # 最早排队的是 B（s2），不是 s1 自己的 D
    env.fake.wait_started("B")
    assert runner.RUNS.keys() == {s2}
    env.finish(s2, "B")
    env.fake.wait_started("D")
    env.finish(s1, "D")
    env.fake.wait_started("E")
    env.finish(s3, "E")
    assert env.fake.order == ["A", "B", "D", "E"]
    assert env.fake.hwm == 1
    assert not runner.RUNS and store.db("SELECT COUNT(*) AS c FROM turn_queue", one=True)["c"] == 0


def test_never_exceeds_limit_two_runs_finish_together(env, alice, admin):
    env.set_limit(admin, 2)
    sids = [env.new_session(alice) for _ in range(4)]
    for s, t in zip(sids, "ABCD"):
        env.send(alice, s, t)
    env.fake.wait_started("A"), env.fake.wait_started("B")
    assert [env.view(alice, s)["session"]["status"] for s in sids] == ["running", "running", "queued", "queued"]
    ra, rb = runner.RUNS[sids[0]], runner.RUNS[sids[1]]
    env.fake.release("A"), env.fake.release("B")   # 两个同时结束
    env.c.portal.call(ra.done.wait), env.c.portal.call(rb.done.wait)
    env.fake.wait_started("C"), env.fake.wait_started("D")
    assert env.fake.order.count("C") == 1 and env.fake.order.count("D") == 1   # 谁都只开始一次
    for s, t in zip(sids[2:], "CD"):
        env.finish(s, t)
    assert env.fake.hwm == 2 and len(env.fake.order) == 4


def test_dispatch_is_not_reentrant_unsafe(env, alice, admin):
    """在循环里连续调用 dispatch_queue 不会重复启动同一条、也不会超限。"""
    env.set_limit(admin, 1)
    s1, s2 = env.new_session(alice), env.new_session(alice)
    env.send(alice, s1, "A")
    env.fake.wait_started("A")
    env.send(alice, s2, "B")
    env.on_loop(lambda: [runner.dispatch_queue() for _ in range(5)])
    assert runner.RUNS.keys() == {s1} and len(runner.queue_of(s2)) == 1


def test_failed_start_does_not_block_queue(env, alice, admin):
    env.set_limit(admin, 1)
    s1, s_bad, s_ok = env.new_session(alice), env.new_session(alice), env.new_session(alice)
    store.db("UPDATE sessions SET work_dir=? WHERE id=?", (str(store.DATA / "不存在的文件夹"), s_bad))
    env.send(alice, s1, "A")
    env.fake.wait_started("A")
    assert env.send(alice, s_bad, "X").json()["queued"] is True
    assert env.send(alice, s_ok, "Y").json()["queued"] is True
    # 会话已被删除的孤儿条目：直接丢掉
    store.db("INSERT INTO turn_queue (session_id, author_id, text, refs, skill, action, created) VALUES (?,?,?,?,?,?,?)",
             ("gone", alice["id"], "Z", "[]", "", "", 1.0))   # created 最小：排在最前面
    env.finish(s1, "A")
    env.fake.wait_started("Y")
    errs = [m for m in env.view(alice, s_bad)["messages"] if m["role"] == "error"]
    assert len(errs) == 1 and "没能开始" in errs[0]["content"] and "X" in errs[0]["content"]
    assert not runner.queue_of(s_bad) and not runner.queue_of("gone")
    assert s_bad not in runner.RUNS and "X" not in env.fake.order
    env.finish(s_ok, "Y")
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0


def test_delete_session_clears_queue(env, alice):
    sid = env.new_session(alice)
    store.db("INSERT INTO turn_queue (session_id, author_id, text, refs, skill, action, created) VALUES (?,?,?,?,?,?,?)",
             (sid, alice["id"], "Q", "[]", "", "", time.time()))
    assert env.c.delete(f"/api/sessions/{sid}", headers=alice["headers"]).status_code == 200
    assert store.db("SELECT COUNT(*) AS c FROM turn_queue", one=True)["c"] == 0


def test_list_endpoint_exposes_queue_and_queued_status(env, alice):
    sid = env.new_session(alice)
    store.db("INSERT INTO turn_queue (session_id, author_id, text, refs, skill, action, created) VALUES (?,?,?,?,?,?,?)",
             (sid, alice["id"], "Q1", "[]", "", "", 1.0))
    # 直接写库的孤立条目不触发 dispatch；列表接口应当把它报成 queued
    row = env.c.get("/api/sessions", headers=alice["headers"]).json()[0]
    assert row["status"] == "queued" and [q["text"] for q in row["queue"]] == ["Q1"]


# ---------- active_runs ----------

def test_active_runs_row_during_run_and_after(env, alice):
    sid = env.new_session(alice)
    env.send(alice, sid, "A")
    env.fake.wait_started("A")
    rows = store.db("SELECT * FROM active_runs")
    assert [(r["session_id"], r["user_id"]) for r in rows] == [(sid, alice["id"])] and rows[0]["started"] > 0
    env.finish(sid, "A")
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0


def test_active_runs_cleared_when_run_claude_raises(env, alice):
    sid = env.new_session(alice)
    env.send(alice, sid, "boom")
    env.fake.wait_started("boom")
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 1
    env.finish(sid, "boom")
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0 and sid not in runner.RUNS
    assert "error" in env.roles(alice, sid)


def test_active_runs_cleared_when_drive_fails_late(alice, monkeypatch):
    store.db("INSERT INTO sessions (id,title,source,created,updated,user_id) VALUES ('s1','T','web',0,0,?)", (alice["id"],))
    store.db("INSERT INTO active_runs (session_id,user_id,started) VALUES ('s1',?,0)", (alice["id"],))
    monkeypatch.setattr(runner, "run_claude", lambda *a, **k: {"result": "ok"})

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk full")
    monkeypatch.setattr(runner, "add_message", boom)
    run = runner.Run("s1", alice["id"])
    runner.RUNS["s1"] = run
    asyncio.run(runner._drive(run, "p", [], "."))
    assert "s1" not in runner.RUNS
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0


def test_begin_turn_failure_leaves_no_active_row(env, alice, monkeypatch):
    sid = env.new_session(alice)

    def boom(*a, **k):
        raise RuntimeError("cmd failed")
    monkeypatch.setattr(runner, "build_command", boom)
    with pytest.raises(RuntimeError):
        env.send(alice, sid, "A")
    assert sid not in runner.RUNS
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0


# ---------- 重启恢复 ----------

def _queue_row(sid, uid, text, created):
    store.db("INSERT INTO turn_queue (session_id, author_id, text, refs, skill, action, created) VALUES (?,?,?,?,?,?,?)",
             (sid, uid, text, "[]", "", "", created))


def test_recover_runs(env, alice):
    s_run, s_idle = env.new_session(alice), env.new_session(alice)
    store.db("INSERT INTO active_runs (session_id,user_id,started) VALUES (?,?,?)", (s_run, alice["id"], 1.0))
    _queue_row(s_run, alice["id"], "被打断后排着的", 2.0)
    _queue_row(s_idle, alice["id"], "Z", 3.0)

    assert runner.recover_runs() == 1
    msgs = env.view(alice, s_run)["messages"]
    errs = [m for m in msgs if m["role"] == "error"]
    assert len(errs) == 1 and errs[0]["content"] == "服务重启，这一轮被中断了，请重新发送。"
    assert errs[0]["meta"]["interrupted"] is True
    evs = [m for m in msgs if m["role"] == "event"]
    assert len(evs) == 1 and "被打断后排着的" in evs[0]["content"]
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0
    assert runner.queue_of(s_run) == [] and [q["text"] for q in runner.queue_of(s_idle)] == ["Z"]
    assert env.view(alice, s_run)["session"]["status"] == "stopped"

    before = store.db("SELECT COUNT(*) AS c FROM messages", one=True)["c"]
    assert runner.recover_runs() == 0   # 第二次什么都不做
    assert store.db("SELECT COUNT(*) AS c FROM messages", one=True)["c"] == before
    assert [q["text"] for q in runner.queue_of(s_idle)] == ["Z"]

    env.on_loop(runner.dispatch_queue)   # 事件循环起来后，没被打断的会话的排队项开始
    env.fake.wait_started("Z")
    assert env.roles(alice, s_idle)[0] == "user"
    env.finish(s_idle, "Z")
    assert runner.queue_of(s_idle) == []


def test_recover_runs_for_deleted_session(alice):
    store.db("INSERT INTO active_runs (session_id,user_id,started) VALUES ('gone',?,1)", (alice["id"],))
    _queue_row("gone", alice["id"], "x", 1.0)
    assert runner.recover_runs() == 1
    assert store.db("SELECT COUNT(*) AS c FROM messages", one=True)["c"] == 0
    assert store.db("SELECT COUNT(*) AS c FROM active_runs", one=True)["c"] == 0
    assert store.db("SELECT COUNT(*) AS c FROM turn_queue", one=True)["c"] == 0


# ---------- 设置 ----------

def test_max_concurrent_setting(env, alice, admin):
    h = admin["headers"]
    assert env.c.get("/api/admin/settings", headers=h).json()["max_concurrent"] == 3
    for bad in (0, -1, 17, 100):
        assert env.c.put("/api/admin/settings", json={"max_concurrent": bad}, headers=h).status_code == 400
    assert env.c.put("/api/admin/settings", json={"max_concurrent": "abc"}, headers=h).status_code == 422
    assert env.c.get("/api/admin/settings", headers=h).json()["max_concurrent"] == 3   # 校验失败不改
    r = env.c.put("/api/admin/settings", json={"max_concurrent": 16}, headers=h)
    assert r.status_code == 200 and r.json()["max_concurrent"] == 16
    assert env.c.put("/api/admin/settings", json={"max_concurrent": 1}, headers=h).json()["max_concurrent"] == 1
    # 只改别的设置不动它
    assert env.c.put("/api/admin/settings", json={"perm_mode": "strict"}, headers=h).json()["max_concurrent"] == 1
    env.c.put("/api/admin/settings", json={"perm_mode": "standard"}, headers=h)
    # 普通用户不能读也不能写
    assert env.c.get("/api/admin/settings", headers=alice["headers"]).status_code == 403
    assert env.c.put("/api/admin/settings", json={"max_concurrent": 5}, headers=alice["headers"]).status_code == 403
    assert runner.max_concurrent() == 1


def test_max_concurrent_env_default_and_clamp(monkeypatch):
    store.db("DELETE FROM settings WHERE key='max_concurrent'")
    assert runner.max_concurrent() == 3
    monkeypatch.setenv("MAX_CONCURRENT", "2")
    assert runner.max_concurrent() == 2
    monkeypatch.setenv("MAX_CONCURRENT", "99")
    assert runner.max_concurrent() == 16
    monkeypatch.setenv("MAX_CONCURRENT", "abc")
    assert runner.max_concurrent() == 3
    store.set_setting("max_concurrent", 5)   # 管理员设置优先于环境变量
    monkeypatch.setenv("MAX_CONCURRENT", "2")
    assert runner.max_concurrent() == 5
    store.db("DELETE FROM settings WHERE key='max_concurrent'")


def test_raising_limit_starts_waiting_turns(env, alice, admin):
    env.set_limit(admin, 1)
    s1, s2 = env.new_session(alice), env.new_session(alice)
    env.send(alice, s1, "A")
    env.fake.wait_started("A")
    assert env.send(alice, s2, "B").json()["queued"] is True
    env.set_limit(admin, 2)
    env.fake.wait_started("B")
    assert runner.RUNS.keys() == {s1, s2}


def test_startup_dispatches_leftover_queue(alice, monkeypatch):
    fake = FakeClaude()
    monkeypatch.setattr(runner, "run_claude", fake)
    monkeypatch.setattr(runner, "find_claude", lambda: "claude")
    monkeypatch.setattr(runner, "build_command", lambda *a, **k: ["claude"])
    runner.RUNS.clear()
    store.db("INSERT INTO sessions (id,title,source,created,updated,user_id) VALUES ('s1','T','web',0,0,?)", (alice["id"],))
    _queue_row("s1", alice["id"], "重启前排的", 1.0)
    with TestClient(server.app) as c:   # 进入 = 触发 lifespan 启动钩子
        fake.wait_started("重启前排的")
        run = runner.RUNS["s1"]
        fake.release("重启前排的")
        c.portal.call(run.done.wait)
    assert store.db("SELECT COUNT(*) AS c FROM turn_queue", one=True)["c"] == 0
    assert [m["role"] for m in store.db("SELECT role FROM messages ORDER BY id")] == ["user", "assistant"]
