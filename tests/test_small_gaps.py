"""几处小缺口：分区条只数自己的会话、删用户清掉排队和运行记录、首个管理员建好后语音会话立刻归他。"""
import time

from fastapi.testclient import TestClient

import sections
import store

import server  # noqa: E402  (conftest 已先设好临时目录)


def _session(sid, uid, section_id=None, source="web"):
    store.db("INSERT INTO sessions (id, title, source, created, updated, bypass, user_id, section_id) VALUES (?,?,?,?,?,0,?,?)",
             (sid, sid, source, time.time(), time.time(), uid, section_id))


def test_admin_gets_own_and_team_section_counts(make_user):
    boss, alice = make_user("boss", role="admin"), make_user("alice")
    sec = store.db_insert("INSERT INTO sections (name, color, sort, archived, created) VALUES ('合同','',1,0,0)")
    _session("a1", alice["id"], sec)
    _session("a2", alice["id"], sec)
    _session("b1", boss["id"], sec)
    with TestClient(server.app) as c:
        admin_view = c.get("/api/sections", headers=boss["headers"]).json()[0]
        user_view = c.get("/api/sections", headers=alice["headers"]).json()[0]
    assert admin_view["session_count"] == 3 and admin_view["my_session_count"] == 1   # 后台看全队，左栏看自己
    assert user_view["session_count"] == 2 and user_view["my_session_count"] == 2


def test_delete_user_clears_queue_and_active_runs(make_user):
    boss, alice = make_user("boss", role="admin"), make_user("alice")
    _session("a1", alice["id"])
    store.db("INSERT INTO turn_queue (session_id, author_id, text, refs, skill, action, created) VALUES ('a1',?,?,?,?,?,?)",
             (alice["id"], "排着的", "[]", "", "", 1.0))
    store.db("INSERT INTO active_runs (session_id, user_id, started) VALUES ('a1',?,1)", (alice["id"],))
    c = TestClient(server.app)   # 不用 with：不触发启动钩子，排着的那条不会真的开始跑
    assert c.delete(f"/api/admin/users/{alice['id']}", headers=boss["headers"]).status_code == 200
    for table in ("turn_queue", "active_runs", "messages", "sessions"):
        assert store.db(f"SELECT COUNT(*) AS c FROM {table}", one=True)["c"] == 0, table


def test_voice_sessions_move_to_first_admin_on_setup():
    store.db("INSERT INTO sessions (id, title, source, created, updated, bypass, user_id) VALUES ('v1','语音','voice',0,0,0,NULL)")
    with TestClient(server.app, client=("127.0.0.1", 50000)) as c:   # 只有本机能创建第一个管理员
        r = c.post("/api/setup", json={"username": "boss", "password": "pw-for-test-123", "display_name": "老板"})
    assert r.status_code == 200, r.text
    uid = r.json()["user"]["id"]
    assert store.db("SELECT user_id FROM sessions WHERE id='v1'", one=True)["user_id"] == uid   # 不用等重启
