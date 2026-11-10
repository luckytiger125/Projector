"""老数据迁移：板子账号停用、语音会话归管理员且只读；可重复执行。"""
from fastapi.testclient import TestClient

import server
import store

client = TestClient(server.app)


def _session(sid, source, user_id):
    store.db("INSERT INTO sessions (id, title, source, created, updated, user_id) VALUES (?,?,?,?,?,?)",
             (sid, sid, source, 1, 1, user_id))


def _owner(sid):
    return store.db("SELECT user_id FROM sessions WHERE id=?", (sid,), one=True)["user_id"]


def test_device_accounts_disabled_and_tokens_cleared(make_user):
    admin = make_user("boss", role="admin")
    dev = make_user("board1", role="device")
    store.migrate_legacy()
    store.migrate_legacy()
    row = store.get_user(dev["id"])
    assert row["disabled"] == 1 and row["role"] == "device"  # 停用但不删
    assert store.db("SELECT COUNT(*) AS n FROM tokens WHERE user_id=?", (dev["id"],), one=True)["n"] == 0
    assert client.get("/api/me", headers=dev["headers"]).status_code == 401
    assert store.get_user(admin["id"])["disabled"] == 0
    assert client.get("/api/me", headers=admin["headers"]).status_code == 200


def test_voice_sessions_go_to_first_admin_and_are_read_only(make_user):
    admin = make_user("boss", role="admin")
    dev = make_user("board1", role="device")
    user = make_user("u1")
    _session("v1", "voice", dev["id"])
    _session("v2", "voice", None)
    _session("w1", "web", dev["id"])      # 非语音会话不动
    _session("w2", "web", user["id"])
    store.migrate_legacy()
    first = [_owner("v1"), _owner("v2"), _owner("w1"), _owner("w2")]
    store.migrate_legacy()
    assert [_owner("v1"), _owner("v2"), _owner("w1"), _owner("w2")] == first
    assert first == [admin["id"], admin["id"], dev["id"], user["id"]]
    assert store.db("SELECT COUNT(*) AS n FROM sessions", one=True)["n"] == 4
    r = client.post("/api/sessions/v1/messages", json={"text": "hi"}, headers=admin["headers"])
    assert r.status_code == 400 and "历史记录" in r.json()["detail"]


def test_voice_sessions_untouched_without_admin_then_handled_later(make_user):
    dev = make_user("board1", role="device")
    _session("v1", "voice", dev["id"])
    store.migrate_legacy()
    assert _owner("v1") == dev["id"]
    assert store.get_user(dev["id"])["disabled"] == 1
    admin = make_user("boss", role="admin")
    store.migrate_legacy()
    assert _owner("v1") == admin["id"]
