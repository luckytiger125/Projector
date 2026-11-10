"""会话消息分页：详情只给最近一页（+has_more），更早的用 /messages?before= 往前翻。"""
import pytest
from fastapi.testclient import TestClient

import server
import sessions_api
import store
from events import add_message

client = TestClient(server.app)


def _session(user, n):
    """给 user 建一个会话并写 n 条消息，返回 (sid, 升序的消息 id 列表)。"""
    s = sessions_api.create_session("分页", store.get_user(user["id"]))
    ids = [add_message(s["id"], "user" if i % 2 == 0 else "assistant", f"m{i}", {"i": i})["id"] for i in range(n)]
    return s["id"], ids


@pytest.fixture
def alice(make_user):
    return make_user("alice")


def detail(sid, user, **params):
    return client.get(f"/api/sessions/{sid}", headers=user["headers"], params=params)


def older(sid, user, **params):
    return client.get(f"/api/sessions/{sid}/messages", headers=user["headers"], params=params)


def test_default_page_is_latest_ascending(alice):
    sid, ids = _session(alice, 130)
    r = detail(sid, alice).json()
    got = [m["id"] for m in r["messages"]]
    assert got == ids[-100:]
    assert r["has_more"] is True
    assert "seq" in r and "live" in r and "approvals" in r and "questions" in r and r["session"]["id"] == sid
    assert r["messages"][0]["meta"] == {"i": 30}   # meta 已解码成对象


def test_has_more_boundary(alice):
    sid, ids = _session(alice, 100)
    r = detail(sid, alice).json()
    assert len(r["messages"]) == 100 and r["has_more"] is False
    sid2, ids2 = _session(alice, 101)
    r = detail(sid2, alice).json()
    assert [m["id"] for m in r["messages"]] == ids2[1:] and r["has_more"] is True


def test_before_walks_whole_history_without_gap_or_dup(alice):
    sid, ids = _session(alice, 237)
    r = detail(sid, alice, limit=50).json()
    seen = [m["id"] for m in r["messages"]]
    pages = 1
    while r["has_more"]:
        r = older(sid, alice, before=seen[0], limit=50).json()
        page = [m["id"] for m in r["messages"]]
        assert page == sorted(page) and page[-1] < seen[0]
        seen = page + seen
        pages += 1
    assert seen == ids
    assert pages == 5


def test_both_endpoints_same_row_shape(alice):
    sid, ids = _session(alice, 5)
    a = detail(sid, alice).json()["messages"]
    b = older(sid, alice, before=ids[-1] + 1).json()["messages"]
    assert a == b and set(a[0]) == {"id", "session_id", "role", "content", "meta", "created"}


def test_limit_clamping(alice):
    sid, ids = _session(alice, 520)
    assert len(detail(sid, alice, limit=1000).json()["messages"]) == 500
    assert len(detail(sid, alice, limit=0).json()["messages"]) == 1
    assert len(detail(sid, alice, limit=-5).json()["messages"]) == 1
    r = older(sid, alice, before=ids[-1] + 1, limit=9999).json()
    assert len(r["messages"]) == 500 and r["has_more"] is True
    r = older(sid, alice, before=ids[-1] + 1, limit=0).json()
    assert [m["id"] for m in r["messages"]] == [ids[-1]] and r["has_more"] is True


def test_permissions(alice, make_user):
    sid, ids = _session(alice, 3)
    bob = make_user("bob")
    admin = make_user("boss", role="admin")
    r1, r2 = detail(sid, bob), older(sid, bob, before=ids[-1])
    assert r1.status_code == r2.status_code == 404
    assert r1.json() == r2.json()
    assert len(older(sid, admin, before=ids[-1] + 1).json()["messages"]) == 3
    assert older("nope", alice, before=1).status_code == 404
    assert client.get(f"/api/sessions/{sid}/messages", params={"before": 1}).status_code in (401, 403)


def test_empty_session(alice):
    sid, _ = _session(alice, 0)
    r = detail(sid, alice).json()
    assert r["messages"] == [] and r["has_more"] is False
    assert older(sid, alice, before=10**6).json() == {"messages": [], "has_more": False}


def test_before_smaller_than_first_id(alice):
    sid, ids = _session(alice, 5)
    assert older(sid, alice, before=ids[0]).json() == {"messages": [], "has_more": False}
    assert older(sid, alice, before=1).json() == {"messages": [], "has_more": False}


def test_before_is_required_and_isolated_between_sessions(alice):
    sid, ids = _session(alice, 3)
    other, oids = _session(alice, 3)
    assert older(sid, alice).status_code == 422
    assert [m["id"] for m in older(sid, alice, before=oids[-1] + 1).json()["messages"]] == ids


def test_post_on_same_path_still_works(alice, monkeypatch):
    sid, _ = _session(alice, 1)
    monkeypatch.setattr(sessions_api, "submit_turn", lambda *a, **k: {"queued": False})
    r = client.post(f"/api/sessions/{sid}/messages", headers=alice["headers"], json={"text": ""})
    assert r.status_code == 400   # 到了发送逻辑（内容为空），而不是 405
    r = client.post(f"/api/sessions/{sid}/messages", headers=alice["headers"], json={"text": "hi"})
    assert r.status_code == 200
