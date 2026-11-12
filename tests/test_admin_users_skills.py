"""后台建用户的报错文案；管理员看技能详情不受分配限制。"""
from fastapi.testclient import TestClient

import server
import store

client = TestClient(server.app)


def _create(admin, **body):
    return client.post("/api/admin/users", json={"username": "", "password": "", **body}, headers=admin["headers"])


def test_create_user_messages(make_user):
    admin = make_user("boss", role="admin")
    cases = [
        ({"username": "  ", "password": "abcdef"}, "请填写用户名"),
        ({"username": "a b", "password": "abcdef"}, "用户名不能有空格"),
        ({"username": "x" * 33, "password": "abcdef"}, "用户名最多 32 个字"),
        ({"username": "ok", "password": "123"}, "密码至少 6 位"),
    ]
    for body, msg in cases:
        r = _create(admin, **body)
        assert r.status_code == 400 and r.json()["detail"] == msg, (body, r.text)
    assert _create(admin, username="ok", password="abcdef").status_code == 200
    r = _create(admin, username="ok", password="abcdef")
    assert r.status_code == 400 and r.json()["detail"] == "这个用户名已经有了"


def test_skill_detail_access(make_user):
    admin, user = make_user("boss", role="admin"), make_user("wang")
    store.db("INSERT INTO library (name, description, everyone, updated) VALUES (?,?,0,0)", ("only-li", "只给别人的技能"))
    try:
        # 管理员没被分配也能看；普通用户没被分配看不到
        assert client.get("/api/skills/only-li", headers=admin["headers"]).status_code == 200
        assert client.get("/api/skills/only-li", headers=user["headers"]).status_code == 404
        assert client.get("/api/skills/no-such", headers=admin["headers"]).status_code == 404
    finally:
        store.db("DELETE FROM library WHERE name=?", ("only-li",))
