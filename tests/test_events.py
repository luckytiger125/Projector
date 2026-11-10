"""事件序号、断线补发、实时快照 seq、扩展思考（thinking）。
补发和权限判断都走 events.py 里的普通函数来测；真正的 SSE 流只做一个有界的小测试（直接迭代 body_iterator，限定帧数和超时），
不用 TestClient 去读无限流（会卡住）。"""
import asyncio
import json
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

import events
import runner
import sessions_api
import store

import server  # noqa: E402  (conftest 已先设好临时目录)

ALICE = {"id": 1, "role": "user"}
BOB = {"id": 2, "role": "user"}
BOSS = {"id": 3, "role": "admin"}


@pytest.fixture(autouse=True)
def fresh_events(monkeypatch):
    """每个用例一个干净的缓冲和订阅表（seq 本身保持单调，所以用例里都按相对值判断）。"""
    events._ring.clear()
    events._subscribers.clear()
    monkeypatch.setattr(events, "RING_MAX", 3000)
    monkeypatch.setattr(events, "RING_TTL", 300)
    yield
    events._ring.clear()
    events._subscribers.clear()


def types(evs):
    return [e["type"] for e in evs]


# ---------- 序号 ----------

def test_seq_strictly_increases_and_is_in_payload():
    a = events.broadcast({"type": "a"}, 1)
    b = events.broadcast({"type": "b"}, 1)
    c = events.broadcast({"type": "c"}, None)
    assert a < b < c
    assert [e[3]["seq"] for e in events._ring] == [a, b, c]
    assert events.current_seq() == c


def test_seq_unique_across_threads():
    out = []

    def work():
        for _ in range(200):
            out.append(events.broadcast({"type": "x"}, 1))
    ts = [threading.Thread(target=work) for _ in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(set(out)) == 800
    assert [e[0] for e in events._ring] == sorted(out)   # 缓冲里的顺序就是 seq 顺序


def test_event_id_roundtrip():
    s = events.broadcast({"type": "a"}, 1)
    assert events.parse_event_id(events.event_id(s)) == (events.BOOT, s)
    for bad in ("", None, "abc", "x-y", "-5"):
        assert events.parse_event_id(bad) is None


# ---------- 补发 ----------

def test_replay_returns_missed_entitled_events_in_order():
    base = events.broadcast({"type": "old"}, 1)
    events.broadcast({"type": "m1"}, 1)
    events.broadcast({"type": "other"}, 2)
    events.broadcast({"type": "everyone"}, None)
    events.broadcast({"type": "m2"}, 1)
    with events.lock:
        got = events.replay_since(ALICE, events.event_id(base))
        bob = events.replay_since(BOB, events.event_id(base))
        boss = events.replay_since(BOSS, events.event_id(base))
    assert types(got) == ["m1", "everyone", "m2"]
    assert types(bob) == ["other", "everyone"]            # 看不到别人的
    assert types(boss) == ["m1", "other", "everyone", "m2"]   # 管理员什么都能看
    assert [e["seq"] for e in got] == sorted(e["seq"] for e in got)


def test_replay_nothing_missed_is_empty_not_resync():
    s = events.broadcast({"type": "a"}, 1)
    with events.lock:
        assert events.replay_since(ALICE, events.event_id(s)) == []


def test_non_owner_never_gets_others_events_via_replay():
    base = events.broadcast({"type": "x"}, 1)
    for i in range(10):
        events.broadcast({"type": "secret", "n": i}, 1)
    with events.lock:
        assert events.replay_since(BOB, events.event_id(base)) == []


def test_unknown_boot_or_garbage_means_resync():
    s = events.broadcast({"type": "a"}, 1)
    events.broadcast({"type": "b"}, 1)
    with events.lock:
        assert events.replay_since(ALICE, f"deadbeef-{s}") is None   # 别的进程
        assert events.replay_since(ALICE, "garbage") is None
        assert events.replay_since(ALICE, events.event_id(events.current_seq() + 5)) is None   # 来自“未来”


def test_too_old_id_means_resync(monkeypatch):
    monkeypatch.setattr(events, "RING_MAX", 5)
    first = events.broadcast({"type": "a"}, 1)
    for _ in range(20):
        events.broadcast({"type": "b"}, 1)
    with events.lock:
        assert events.replay_since(ALICE, events.event_id(first)) is None
        # 刚好挤出缓冲边缘之前一条：还能接上
        oldest = events._ring[0][0]
        assert len(events.replay_since(ALICE, events.event_id(oldest - 1))) == 5


def test_buffer_bounded_by_count_and_age(monkeypatch):
    monkeypatch.setattr(events, "RING_MAX", 10)
    for _ in range(50):
        events.broadcast({"type": "a"}, 1)
    assert len(events._ring) == 10
    s = events.current_seq()
    # 超过 TTL 的事件在补发时也被丢弃：过期后对一个落后的 id 只能 resync
    with events.lock:
        assert events.replay_since(ALICE, events.event_id(s - 3), now=time.time() + events.RING_TTL + 5) is None
        assert len(events._ring) == 0
    # 缓冲空了但客户端已经是最新：不需要 resync
    with events.lock:
        assert events.replay_since(ALICE, events.event_id(s)) == []


def test_ttl_drops_old_events_on_broadcast(monkeypatch):
    monkeypatch.setattr(events, "RING_TTL", 0.05)
    events.broadcast({"type": "a"}, 1)
    time.sleep(0.1)
    events.broadcast({"type": "b"}, 1)
    assert [e[3]["type"] for e in events._ring] == ["b"]


# ---------- 订阅和广播：不漏、不重 ----------

def test_subscribe_replay_plus_live_has_no_gap_or_duplicate():
    async def main():
        loop = asyncio.get_running_loop()
        base = events.broadcast({"type": "base"}, None)
        raw = events.event_id(base)

        def producer():
            for i in range(400):   # 3 x 400 < RING_MAX：缓冲不会溢出，补发一定接得上
                events.broadcast({"type": "p"}, None)
                if i % 10 == 0:
                    time.sleep(0.001)
        ts = [threading.Thread(target=producer) for _ in range(3)]
        [t.start() for t in ts]
        await asyncio.sleep(0.02)
        q, replay, now_seq = events.subscribe(ALICE, loop, raw)   # 生产者还在广播时订阅
        [t.join() for t in ts]
        await asyncio.sleep(0.05)   # 让 call_soon_threadsafe 的投递都跑完
        got = [e["seq"] for e in replay]
        assert replay is not None and got[-1] <= now_seq
        while not q.empty():
            got.append(q.get_nowait()["seq"])
        events.unsubscribe(q)
        assert got == list(range(base + 1, events.current_seq() + 1))
    asyncio.run(asyncio.wait_for(main(), 20))


def test_broadcast_delivers_only_to_entitled_subscribers():
    async def main():
        loop = asyncio.get_running_loop()
        qa, _, _ = events.subscribe(ALICE, loop)
        qb, _, _ = events.subscribe(BOB, loop)
        qs, _, _ = events.subscribe(BOSS, loop)
        events.broadcast({"type": "mine"}, 1)
        await asyncio.sleep(0.02)
        assert qa.qsize() == 1 and qb.qsize() == 0 and qs.qsize() == 1
        for q in (qa, qb, qs):
            events.unsubscribe(q)
    asyncio.run(asyncio.wait_for(main(), 10))


class FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}

    async def is_disconnected(self):
        return False


def _read_frames(user, headers=None, last_id="", n=3, then=None):
    """直接调接口函数，取前 n 个 SSE 帧，限时 5 秒，然后关掉流。"""
    async def main():
        resp = await events.events(FakeRequest(headers), last_id=last_id, user=user)
        it = resp.body_iterator
        out = []
        for _ in range(n):
            out.append(await asyncio.wait_for(it.__anext__(), 5))
        if then:
            then()
            out.append(await asyncio.wait_for(it.__anext__(), 5))
        await it.aclose()
        return out
    return asyncio.run(asyncio.wait_for(main(), 10))


def test_stream_frames_replay_and_ids():
    base = events.broadcast({"type": "old"}, 1)
    events.broadcast({"type": "m1", "session_id": "s"}, 1)
    events.broadcast({"type": "other"}, 2)
    frames = _read_frames(ALICE, headers={"last-event-id": events.event_id(base)}, n=3)
    assert frames[0].startswith(": connected")
    assert frames[1].startswith("id: ") and "data:" not in frames[1]     # 只有 id，用来让浏览器记住位置
    assert frames[2].startswith(f"id: {events.BOOT}-{base + 1}\ndata: ")
    ev = json.loads(frames[2].split("data: ", 1)[1])
    assert ev["type"] == "m1" and ev["seq"] == base + 1


def test_stream_query_param_and_resync():
    events.broadcast({"type": "a"}, 1)
    frames = _read_frames(ALICE, last_id="deadbeef-1", n=3)
    assert frames[2].endswith('data: {"type": "resync"}\n\n')
    assert frames[2].startswith(f"id: {events.BOOT}-")
    # 首次连接（没带 id）不发 resync
    frames = _read_frames(ALICE, n=2, then=lambda: events.broadcast({"type": "live"}, 1))
    assert all("resync" not in f for f in frames) and '"live"' in frames[-1]


# ---------- 会话快照的 seq ----------

@pytest.fixture
def client():
    runner.RUNS.clear()
    with TestClient(server.app) as c:
        yield c
    runner.RUNS.clear()


def test_snapshot_has_seq_matching_latest(client, make_user):
    u = make_user("alice")
    sid = sessions_api.create_session("t", store.get_user(u["id"]))["id"]
    r = client.get(f"/api/sessions/{sid}", headers=u["headers"]).json()
    assert r["seq"] == events.current_seq()
    events.add_message(sid, "event", "hi")
    r2 = client.get(f"/api/sessions/{sid}", headers=u["headers"]).json()
    assert r2["seq"] > r["seq"] and r2["seq"] == events.current_seq()
    assert any(m["content"] == "hi" for m in r2["messages"])


def test_session_list_has_seq_header(client, make_user):
    u = make_user("alice")
    r = client.get("/api/sessions", headers=u["headers"])
    assert int(r.headers["X-Event-Seq"]) == events.current_seq()


def test_snapshot_live_is_consistent_with_seq(client, make_user):
    """快照里的 live 恰好包含 seq 及之前的所有增量：客户端忽略 seq<=快照的事件，就不会重复也不会丢。"""
    u = make_user("alice")
    sid = sessions_api.create_session("t", store.get_user(u["id"]))["id"]
    run = runner.RUNS[sid] = runner.Run(sid, u["id"])
    try:
        def pump():
            for i in range(1500):   # < RING_MAX：缓冲里一定有快照之前的全部事件
                runner._on_event(run, {"type": "delta", "text": f"[{i}]"})
                if i % 20 == 0:
                    time.sleep(0.001)
        t = threading.Thread(target=pump)
        t.start()
        try:
            for _ in range(30):
                snap = client.get(f"/api/sessions/{sid}", headers=u["headers"]).json()
                text, seq = snap["live"]["text"], snap["seq"]
                # 快照文本恰好等于 seq 及之前所有 delta 的拼接：不多（会重复）也不少（会丢）
                evs = [e[3] for e in events._ring if e[3].get("session_id") == sid and e[3]["seq"] <= seq]
                assert "".join(e["text"] for e in evs) == text
        finally:
            t.join()
    finally:
        runner.RUNS.pop(sid, None)


# ---------- 扩展思考 ----------

def test_run_claude_forwards_thinking_deltas():
    lines = [
        {"type": "system", "session_id": "cs1"},
        {"type": "stream_event", "event": {"type": "message_start"}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "先想"}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "一下"}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "signature_delta", "signature": "x"}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "答案"}}},
        {"type": "result", "result": "答案", "is_error": False},
    ]
    script = "import sys,json\nsys.stdin.read()\nfor l in json.loads(sys.argv[1]): print(json.dumps(l, ensure_ascii=False), flush=True)\n"
    run = runner.Run("thinksid", 1)
    got = []
    final = runner.run_claude(run, "hi", [sys.executable, "-c", script, json.dumps(lines)], str(store.DATA), got.append)
    assert [e["type"] for e in got] == ["delta_reset", "thinking", "thinking", "delta"]
    assert [e.get("text") for e in got[1:3]] == ["先想", "一下"]
    assert final["result"] == "答案"


def test_thinking_in_live_snapshot_reset_and_not_persisted(client, make_user, monkeypatch):
    u = make_user("alice")
    sid = sessions_api.create_session("t", store.get_user(u["id"]))["id"]
    gate = threading.Event()
    seen_emit = threading.Event()

    def fake(run, prompt, cmd, cwd, emit):
        run.proc = type("P", (), {"poll": staticmethod(lambda: None), "kill": staticmethod(gate.set)})()
        emit({"type": "delta_reset"})
        emit({"type": "thinking", "text": "想想"})
        emit({"type": "thinking", "text": "再想"})
        seen_emit.set()
        assert gate.wait(10)
        return {"result": "完成"}
    monkeypatch.setattr(runner, "run_claude", fake)
    monkeypatch.setattr(runner, "find_claude", lambda: "claude")
    monkeypatch.setattr(runner, "build_command", lambda *a, **k: ["claude"])
    assert client.post(f"/api/sessions/{sid}/messages", json={"text": "问"}, headers=u["headers"]).status_code == 200
    assert seen_emit.wait(10)
    live = None
    for _ in range(100):   # 事件经 call_soon_threadsafe 进事件循环，轮询等它落地（有上限）
        live = client.get(f"/api/sessions/{sid}", headers=u["headers"]).json()["live"]
        if live and live["thinking"] == "想想再想":
            break
        time.sleep(0.05)
    assert live["thinking"] == "想想再想" and live["text"] == ""
    ev = [e[3] for e in events._ring if e[3]["type"] == "thinking" and e[3]["session_id"] == sid]
    assert [e["text"] for e in ev] == ["想想", "再想"] and all("seq" in e for e in ev)
    run = runner.RUNS[sid]
    runner._on_event(run, {"type": "delta_reset"})      # 新一条消息开始：思考清空
    assert run.thinking == "" and runner.live_snapshot(run)["thinking"] == ""
    gate.set()
    client.portal.call(run.done.wait)
    view = client.get(f"/api/sessions/{sid}", headers=u["headers"]).json()
    assert view["live"] is None
    assert [m["role"] for m in view["messages"]] == ["user", "assistant"]
    assert all("想想" not in m["content"] and "thinking" not in json.dumps(m["meta"]) for m in view["messages"])
