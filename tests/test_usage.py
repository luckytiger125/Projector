import json
import sqlite3
import time
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient

import store
import usage

import server  # noqa: E402  (conftest 已先设好临时目录)

client = TestClient(server.app)


def _day_ts(ymd, hour=12):
    y, m, d = map(int, ymd.split("-"))
    return datetime(y, m, d, hour).timestamp()


def _row(uid, mid, model="m1", i=0, o=0, cr=0, cw=0, cost=None, ts=None, sid="s1"):
    store.db("INSERT INTO usage_turns (session_id,user_id,message_id,model,input_tokens,output_tokens,"
             "cache_read_tokens,cache_write_tokens,cost_usd,created,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
             (sid, uid, mid, model, i, o, cr, cw, cost, ts if ts is not None else time.time(), "result"))


def _session(sid="s1", uid=None, title="T"):
    store.db("INSERT INTO sessions (id,title,source,created,updated,user_id) VALUES (?,?,?,?,?,?)",
             (sid, title, "web", 0, 0, uid))


# ---------- normalize ----------

def test_normalize_prefers_model_usage():
    final = {"usage": {"input_tokens": 1, "output_tokens": 1},
             "modelUsage": {"a": {"inputTokens": 10, "outputTokens": 5, "costUSD": 0.1},
                            "b": {"inputTokens": 20, "outputTokens": 6, "cacheReadInputTokens": 7,
                                  "cacheCreationInputTokens": 8, "costUSD": 0.2}}}
    rows = usage.normalize_usage(final)
    assert {r["model"] for r in rows} == {"a", "b"}
    b = next(r for r in rows if r["model"] == "b")
    assert (b["input_tokens"], b["output_tokens"], b["cache_read_tokens"], b["cache_write_tokens"]) == (20, 6, 7, 8)


def test_normalize_model_usage_without_usage():
    rows = usage.normalize_usage({"modelUsage": {"a": {"inputTokens": 3}}})
    assert len(rows) == 1 and rows[0]["input_tokens"] == 3


def test_normalize_missing_usage():
    assert usage.normalize_usage({}) == []


def test_normalize_skips_bad_items_and_names_unknown():
    rows = usage.normalize_usage({"modelUsage": {"a": "oops", "": {"inputTokens": 2}}})
    assert [r["model"] for r in rows] == ["unknown"]


def test_model_usage_cost_not_double_counted():
    rows = usage.normalize_usage({"total_cost_usd": 99,
                                  "modelUsage": {"a": {"inputTokens": 1, "costUSD": 0.1},
                                                 "b": {"inputTokens": 1, "costUSD": 0.2}}})
    assert sum(r["cost_usd"] for r in rows) == pytest.approx(0.3)


def test_fallback_cost_zero_is_kept():
    u = {"usage": {"input_tokens": 5}}
    assert usage.normalize_usage({**u, "total_cost_usd": 0.0})[0]["cost_usd"] == 0.0
    assert usage.normalize_usage({**u, "total_cost_usd": None, "totalCostUSD": 0})[0]["cost_usd"] == 0.0
    assert usage.normalize_usage(u)[0]["cost_usd"] is None


# ---------- 聚合 ----------

def test_summary_turns_distinct_message(make_user):
    u = make_user("a")
    _row(u["id"], 1, "m1", i=1)
    _row(u["id"], 1, "m2", i=2)
    d = usage.usage_summary(u["id"], all_time=True)
    assert d["total"]["turns"] == 1 and d["total"]["input"] == 3


def test_summary_groups_by_day_and_user(make_user):
    a, b = make_user("a", display_name="甲"), make_user("b", display_name="乙")
    _row(a["id"], 1, i=10, o=1, ts=_day_ts("2026-10-01"))
    _row(a["id"], 2, i=20, o=2, ts=_day_ts("2026-10-02"))
    _row(b["id"], 3, i=5, o=3, ts=_day_ts("2026-10-02"))
    d = usage.usage_summary(None, "2026-10-01", "2026-10-31", by_user=True)
    assert d["total"]["input"] == 35 and d["total"]["output"] == 6 and d["total"]["turns"] == 3
    assert [(x["date"], x["input"], x["turns"]) for x in d["daily"]] == [("2026-10-01", 10, 1), ("2026-10-02", 25, 2)]
    users = {x["display_name"]: x for x in d["by_user"]}
    assert users["甲"]["input"] == 30 and users["甲"]["turns"] == 2 and users["乙"]["input"] == 5
    assert "cache_read" in users["甲"]


def test_me_only_returns_own_rows(make_user):
    a, b = make_user("a"), make_user("b")
    _row(a["id"], 1, i=1)
    _row(b["id"], 2, i=100)
    r = client.get("/api/usage/me?all=true", headers=a["headers"])
    assert r.status_code == 200 and r.json()["total"]["input"] == 1
    r = client.get("/api/usage/me/turns", headers=a["headers"])
    assert [t["message_id"] for t in r.json()] == [1]


def test_recent_turns_groups_by_message(make_user):
    u = make_user("a")
    _session(uid=u["id"])
    _row(u["id"], 1, "m1", i=1, ts=100)
    _row(u["id"], 1, "m2", i=2, ts=100)
    _row(u["id"], 2, "m1", i=4, ts=200)
    turns = usage.recent_turns(u["id"], 20)
    assert [t["message_id"] for t in turns] == [2, 1]
    assert turns[1]["input"] == 3 and turns[1]["models"] == ["m1", "m2"]
    assert turns[0]["session_title"] == "T"


def test_recent_turns_preview_skips_events(make_user):
    u = make_user("a")
    _session(uid=u["id"])
    server.add_message("s1", "user", "请汇总九月合同")
    server.add_message("s1", "event", "已同意")
    m = server.add_message("s1", "assistant", "好的")
    _row(u["id"], m["id"], i=1)
    assert usage.recent_turns(u["id"])[0]["preview"] == "请汇总九月合同"


def test_me_turns_rejects_user_id(make_user):
    a, b = make_user("a"), make_user("b")
    _row(b["id"], 1, i=1)
    r = client.get(f"/api/usage/me/turns?user_id={b['id']}", headers=a["headers"])
    assert r.status_code == 400


def test_admin_turns_requires_user_id(make_user):
    adm = make_user("adm", role="admin")
    assert client.get("/api/admin/usage/turns", headers=adm["headers"]).status_code in (400, 422)
    u = make_user("a")
    _row(u["id"], 1, i=1)
    r = client.get(f"/api/admin/usage/turns?user_id={u['id']}", headers=adm["headers"])
    assert r.status_code == 200 and len(r.json()) == 1


def test_admin_endpoints_require_admin(make_user):
    u = make_user("a")
    assert client.get("/api/admin/usage", headers=u["headers"]).status_code == 403
    assert client.get(f"/api/admin/usage/turns?user_id={u['id']}", headers=u["headers"]).status_code == 403
    assert client.get("/api/usage/me").status_code == 401


# ---------- record_turn ----------

def test_record_turn_failure_does_not_raise(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("db down")
    monkeypatch.setattr(usage, "db_many", boom)
    assert usage.record_turn("s1", 1, 1, {"usage": {"input_tokens": 1}}) == 0
    assert (store.DATA / "logs" / "usage.log").exists()


def test_record_turn_unique_conflict_keeps_other_rows():
    _row(1, 7, "a", i=1)
    n = usage.record_turn("s1", 1, 7, {"modelUsage": {"a": {"inputTokens": 5}, "b": {"inputTokens": 6}}})
    assert n == 1
    rows = store.db("SELECT model, input_tokens FROM usage_turns WHERE message_id=7 ORDER BY model")
    assert [(r["model"], r["input_tokens"]) for r in rows] == [("a", 1), ("b", 6)]


def test_record_turn_not_null_rolls_back():
    # message_id NOT NULL：整批回滚，一行不留，且不抛
    n = usage.record_turn("s1", 1, None, {"modelUsage": {"a": {"inputTokens": 5}, "b": {"inputTokens": 6}}})
    assert n == 0
    assert store.db("SELECT COUNT(*) AS c FROM usage_turns", one=True)["c"] == 0


def test_record_turn_sets_created_and_source():
    usage.record_turn("s1", 1, 1, {"is_error": True, "usage": {"input_tokens": 1}})
    r = store.db("SELECT created, source, date(created,'unixepoch','localtime') AS d FROM usage_turns", one=True)
    assert r["created"] and r["d"] == date.today().isoformat() and r["source"] == "error"


# ---------- 区间 ----------

def test_usage_all_ignores_from_to(make_user):
    u = make_user("a")
    _row(u["id"], 1, i=1, ts=_day_ts("2020-01-01"))
    r = client.get("/api/usage/me?all=true&from=&to=", headers=u["headers"])
    assert r.status_code == 200 and r.json()["total"]["input"] == 1
    r = client.get("/api/usage/me?all=true&from=2000-01-01&to=2030-01-01", headers=u["headers"])
    assert r.status_code == 200 and r.json()["total"]["input"] == 1


def test_usage_date_validation(make_user):
    u = make_user("a")
    h = u["headers"]
    for q in ("from=2026-10-01", "to=2026-10-01", "from=abc&to=2026-10-01", "from=2026-02-30&to=2026-03-01",
              "from=2026-10-05&to=2026-10-01", "from=2025-01-01&to=2026-10-01"):
        assert client.get("/api/usage/me?" + q, headers=h).status_code == 400, q
    # 12 月默认区间到 12-31，不会算到次年
    assert usage._month_range(date(2026, 12, 15)) == (date(2026, 12, 1), date(2026, 12, 31))
    assert usage._month_range(date(2026, 2, 3)) == (date(2026, 2, 1), date(2026, 2, 28))


def test_usage_has_data_independent_of_range(make_user):
    u = make_user("a")
    _row(u["id"], 1, i=9, ts=_day_ts("2020-01-01"))
    d = client.get("/api/usage/me?from=2026-10-01&to=2026-10-31", headers=u["headers"]).json()
    assert d["has_data"] is True and d["total"]["input"] == 0 and d["daily"] == []
    other = make_user("b")
    assert client.get("/api/usage/me", headers=other["headers"]).json()["has_data"] is False


def test_usage_cost_null_vs_zero(make_user):
    u = make_user("a")
    _row(u["id"], 1, i=1, cost=None)
    assert usage.usage_summary(u["id"], all_time=True)["total"]["cost"] is None
    _row(u["id"], 2, i=1, cost=0.0)
    assert usage.usage_summary(u["id"], all_time=True)["total"]["cost"] == 0


# ---------- add_message / _drive ----------

def test_add_message_returns_inserted_id():
    _session()
    import threading
    stop = threading.Event()

    def spam():
        while not stop.is_set():
            store.db("INSERT INTO messages (session_id,role,content,meta,created) VALUES ('s1','event','e','{}',0)")

    t = threading.Thread(target=spam)
    t.start()
    try:
        for i in range(50):
            m = server.add_message("s1", "assistant", f"reply{i}")
            row = store.db("SELECT role, content FROM messages WHERE id=?", (m["id"],), one=True)
            assert row["role"] == "assistant" and row["content"] == f"reply{i}"
    finally:
        stop.set()
        t.join()


def test_drive_records_usage_and_cleans_runs(make_user, monkeypatch):
    import asyncio
    u = make_user("a")
    _session(uid=u["id"])
    monkeypatch.setattr(server, "run_claude", lambda *a, **k: {
        "result": "ok", "usage": {"input_tokens": 3, "output_tokens": 4}, "total_cost_usd": 0.0, "model": "m"})
    run = server.Run("s1", u["id"])
    server.RUNS["s1"] = run
    asyncio.run(server._drive(run, "p", [], "."))
    assert "s1" not in server.RUNS and run.done.is_set()
    r = store.db("SELECT * FROM usage_turns", one=True)
    msg = store.db("SELECT id FROM messages WHERE role='assistant'", one=True)
    assert r["message_id"] == msg["id"] and r["user_id"] == u["id"] and r["input_tokens"] == 3


def test_drive_cleans_runs_even_if_add_message_fails(make_user, monkeypatch):
    import asyncio
    u = make_user("a")
    _session(uid=u["id"])
    monkeypatch.setattr(server, "run_claude", lambda *a, **k: {"result": "ok", "usage": {"input_tokens": 1}})

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk full")
    monkeypatch.setattr(server, "add_message", boom)
    run = server.Run("s1", u["id"])
    server.RUNS["s1"] = run
    asyncio.run(server._drive(run, "p", [], "."))
    assert "s1" not in server.RUNS and run.done.is_set()


def test_drive_stopped_meta_flag(make_user, monkeypatch):
    import asyncio
    u = make_user("a")
    _session(uid=u["id"])
    run = server.Run("s1", u["id"])
    run.stopped = True
    monkeypatch.setattr(server, "run_claude", lambda *a, **k: {})
    server.RUNS["s1"] = run
    asyncio.run(server._drive(run, "p", [], "."))
    meta = json.loads(store.db("SELECT meta FROM messages WHERE role='error'", one=True)["meta"])
    assert meta["stopped"] is True
    assert store.db("SELECT COUNT(*) AS c FROM usage_turns", one=True)["c"] == 0
