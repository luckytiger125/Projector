"""登录 cookie：令牌不再放在网址里。cookie 只对 GET/HEAD 生效（防 CSRF），改东西的请求必须带 Authorization 头；
内部令牌（approval_mcp.py 用）只走请求头。"""
import pytest
from fastapi.testclient import TestClient

import auth_api
import store

import server  # noqa: E402  (conftest 已先设好临时目录)

PW = "secret1"


@pytest.fixture
def client():
    c = TestClient(server.app)
    yield c
    c.cookies.clear()


@pytest.fixture
def user():
    store.db("INSERT INTO users (username, display_name, pw_hash, role, created) VALUES (?,?,?,?,?)",
             ("alice", "爱丽丝", store.hash_password(PW), "user", 0))
    return {"username": "alice", "password": PW}


def login(client, user):
    r = client.post("/api/login", json=user)
    assert r.status_code == 200, r.text
    client.cookies.clear()   # 之后每个请求显式指定带什么，免得 cookie 罐子干扰
    return r


def cookie_hdr(token):
    return {"cookie": f"{store.AUTH_COOKIE}={token}"}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_login_sets_httponly_cookie_with_attributes(client, user):
    r = login(client, user)
    token = r.json()["token"]
    sc = r.headers["set-cookie"]
    assert sc.startswith(f"{store.AUTH_COOKIE}={token}")
    low = sc.lower()
    assert "httponly" in low and "samesite=lax" in low and "path=/" in low
    assert f"max-age={store.TOKEN_IDLE_DAYS * 86400}" in low
    assert "secure" not in low   # 局域网明文 HTTP


def test_setup_sets_cookie_too(client, monkeypatch):
    monkeypatch.setattr(auth_api, "is_local", lambda request: True)
    r = client.post("/api/setup", json={"username": "boss", "password": PW})
    assert r.status_code == 200, r.text
    assert f"{store.AUTH_COOKIE}={r.json()['token']}" in r.headers["set-cookie"]


def test_get_with_cookie_only_ok(client, user):
    token = login(client, user).json()["token"]
    assert client.get("/api/me", headers=cookie_hdr(token)).status_code == 200
    assert client.get("/api/sessions", headers=cookie_hdr(token)).status_code == 200


def test_state_changing_with_cookie_only_rejected(client, user):
    token = login(client, user).json()["token"]
    for method, path in (("POST", "/api/sessions"), ("POST", "/api/session-cookie"), ("POST", "/api/logout"),
                         ("PATCH", "/api/me"), ("DELETE", "/api/sessions/x")):
        r = client.request(method, path, json={}, headers=cookie_hdr(token))
        assert r.status_code == 401, (method, path, r.status_code)
    # 登出没生效：令牌还在
    assert client.get("/api/me", headers=bearer(token)).status_code == 200


def test_header_still_works_for_all_methods(client, user):
    token = login(client, user).json()["token"]
    assert client.get("/api/me", headers=bearer(token)).status_code == 200
    assert client.post("/api/sessions", json={}, headers=bearer(token)).status_code == 200


def test_header_wins_over_bad_cookie(client, user):
    token = login(client, user).json()["token"]
    assert client.get("/api/me", headers={**bearer(token), **cookie_hdr("nonsense")}).status_code == 200


def test_query_token_no_longer_authenticates(client, user):
    token = login(client, user).json()["token"]
    assert client.get(f"/api/me?token={token}").status_code == 401
    assert client.get(f"/api/events?token={token}").status_code == 401
    assert client.get(f"/api/files/raw?path=x&token={token}").status_code == 401


def test_bad_or_missing_cookie_rejected(client, user):
    login(client, user)
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers=cookie_hdr("nonsense")).status_code == 401


def test_logout_clears_cookie_and_token(client, user):
    token = login(client, user).json()["token"]
    r = client.post("/api/logout", headers=bearer(token))
    assert r.status_code == 200
    sc = r.headers["set-cookie"].lower()
    assert f"{store.AUTH_COOKIE}=" in sc and ("max-age=0" in sc or "expires=" in sc) and "path=/" in sc
    assert client.get("/api/me", headers=cookie_hdr(token)).status_code == 401   # 令牌也作废了


def test_change_password_clears_cookie_and_logs_out(client, user):
    token = login(client, user).json()["token"]
    r = client.post("/api/me/password", json={"old": PW, "new": "another1"}, headers=bearer(token))
    assert r.status_code == 200
    assert "max-age=0" in r.headers["set-cookie"].lower()
    assert client.get("/api/me", headers=bearer(token)).status_code == 401
    assert client.post("/api/login", json={"username": "alice", "password": "another1"}).status_code == 200


def test_cookie_bootstrap_for_users_logged_in_before_update(client, user):
    token = login(client, user).json()["token"]
    r = client.post("/api/session-cookie", headers=bearer(token))   # 老用户：只有 localStorage 里的令牌
    assert r.status_code == 200 and r.json() == {"ok": True}
    sc = r.headers["set-cookie"]
    assert sc.startswith(f"{store.AUTH_COOKIE}={token}") and "httponly" in sc.lower() and "samesite=lax" in sc.lower()
    assert client.post("/api/session-cookie").status_code == 401   # 没有令牌：不给种
    assert client.post("/api/session-cookie", headers=bearer("bad")).status_code == 401


def test_internal_token_header_works_cookie_does_not(client):
    h = bearer(store.INTERNAL_TOKEN)
    assert client.get("/api/sessions", headers=h).status_code == 200
    assert client.get("/api/sessions", headers=cookie_hdr(store.INTERNAL_TOKEN)).status_code == 401
    assert client.get(f"/api/sessions?token={store.INTERNAL_TOKEN}").status_code == 401
    # approval_mcp.py 走的路径：POST + 请求头
    r = client.post("/api/approvals", json={"session_id": "nope", "tool_name": "Bash", "input": {}}, headers=h)
    assert r.status_code == 200 and r.json()["allow"] is False
    assert client.post("/api/session-cookie", headers=h).status_code == 403   # 内部令牌不能被种进 cookie
