"""分区：接口权限、会话归区、知识库归区与筛选、改名回滚、会话视图的状态/耗时/文件数。"""
import json
import time

import pytest
from fastapi.testclient import TestClient

import approvals
import kb
import runner
import sections
import server
import store

client = TestClient(server.app)
INTERNAL = {"Authorization": f"Bearer {store.INTERNAL_TOKEN}"}


@pytest.fixture(autouse=True)
def clean_kb():
    """知识库在临时目录里；每个用例前后清掉笔记、历史和改名标记。"""
    def wipe():
        for p in sorted(store.KB_ROOT.rglob("*"), reverse=True):
            if p.is_file() and p.name != kb.GUIDE_NAME:
                p.unlink()
        store.db("DELETE FROM kb_history")
        store.db("DELETE FROM settings WHERE key=?", (kb.RENAME_KEY,))
        store.db("DELETE FROM links")
        runner.RUNS.clear()
        approvals.APPROVALS.clear()
        kb.invalidate()
    wipe()
    yield
    wipe()


@pytest.fixture
def admin(make_user):
    return make_user("boss", role="admin")


@pytest.fixture
def alice(make_user):
    return make_user("alice")


def mk(admin, name, **kw):
    r = client.post("/api/sections", json={"name": name, **kw}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def new_sess(u, **body):
    r = client.post("/api/sessions", json={"title": "t", **body}, headers=u["headers"])
    return r


def put_note(u, title, section=None, body="正文", path="", type="经验"):
    j = {"title": title, "body": body, "type": type}
    if path:
        j["path"] = path
    if section is not None:
        j["section"] = section
    return client.put("/api/kb/note", json=j, headers=u["headers"])


def note_file(rel):
    return (store.KB_ROOT / rel).read_text(encoding="utf-8")


def fm(rel):
    meta, _ = kb.split_fm(note_file(rel))
    return meta


def user_row(u):
    return store.db("SELECT * FROM users WHERE id=?", (u["id"],), one=True)


# ---------- 分区本身 ----------

def test_admin_can_create_user_cannot(admin, alice):
    r = client.post("/api/sections", json={"name": "合同"}, headers=alice["headers"])
    assert r.status_code == 403
    sec = mk(admin, "合同")
    assert sec["name"] == "合同" and sec["archived"] == 0
    # 所有登录用户都能看列表
    names = [s["name"] for s in client.get("/api/sections", headers=alice["headers"]).json()]
    assert names == ["合同"]
    assert client.patch(f"/api/sections/{sec['id']}", json={"name": "x"}, headers=alice["headers"]).status_code == 403
    assert client.get("/api/sections").status_code == 401


def test_section_name_strip_and_reserved(admin):
    assert mk(admin, "  合同  ")["name"] == "合同"
    for bad in ("", "   ", "__uncategorized__"):
        r = client.post("/api/sections", json={"name": bad}, headers=admin["headers"])
        assert r.status_code == 400, bad
    sid = mk(admin, "采购")["id"]
    for bad in ("", " ", "__uncategorized__"):
        r = client.patch(f"/api/sections/{sid}", json={"name": bad}, headers=admin["headers"])
        assert r.status_code == 400, bad
    r = client.patch(f"/api/sections/{sid}", json={"name": "  采购部 "}, headers=admin["headers"])
    assert r.status_code == 200 and r.json()["name"] == "采购部"


def test_duplicate_archived_name_rejected(admin):
    sec = mk(admin, "合同")
    assert client.post("/api/sections", json={"name": "合同"}, headers=admin["headers"]).status_code == 409
    client.patch(f"/api/sections/{sec['id']}", json={"archived": 1}, headers=admin["headers"])
    r = client.post("/api/sections", json={"name": "合同"}, headers=admin["headers"])
    assert r.status_code == 409 and "恢复" in r.json()["detail"]   # 前端靠这个词识别“需先恢复”
    # 大小写不同也算重名
    assert client.post("/api/sections", json={"name": "合同"}, headers=admin["headers"]).status_code == 409
    r = client.patch(f"/api/sections/{sec['id']}", json={"archived": 0}, headers=admin["headers"])
    assert r.status_code == 200 and r.json()["archived"] == 0
    assert [s["name"] for s in client.get("/api/sections", headers=admin["headers"]).json()] == ["合同"]


def test_list_include_archived_admin_only(admin, alice):
    a = mk(admin, "合同")
    mk(admin, "采购")
    client.patch(f"/api/sections/{a['id']}", json={"archived": True}, headers=admin["headers"])
    assert [s["name"] for s in client.get("/api/sections", headers=admin["headers"]).json()] == ["采购"]
    got = client.get("/api/sections?include_archived=1", headers=admin["headers"]).json()
    assert [(s["name"], s["archived"]) for s in got] == [("采购", 0), ("合同", 1)]
    got = client.get("/api/sections?include_archived=1", headers=alice["headers"]).json()
    assert [s["name"] for s in got] == ["采购"]   # 普通用户拿不到归档分区


def test_list_counts(admin, alice):
    sec = mk(admin, "合同")
    new_sess(alice, section_id=sec["id"])
    new_sess(alice, section_id=sec["id"])
    new_sess(admin, section_id=sec["id"])
    put_note(alice, "笔记A", section="合同")
    put_note(alice, "笔记B")
    mine = client.get("/api/sections", headers=alice["headers"]).json()[0]
    assert mine["session_count"] == 2 and mine["note_count"] == 1   # 普通用户只数自己的会话
    team = client.get("/api/sections", headers=admin["headers"]).json()[0]
    assert team["session_count"] == 3 and team["note_count"] == 1


def test_reorder(admin):
    a, b, c = (mk(admin, n)["id"] for n in ("a", "b", "c"))
    r = client.post("/api/sections/reorder", json={"ids": [c, a, b]}, headers=admin["headers"])
    assert r.status_code == 200
    assert [s["id"] for s in client.get("/api/sections", headers=admin["headers"]).json()] == [c, a, b]
    assert client.post("/api/sections/reorder", json={"ids": [c, 9999]}, headers=admin["headers"]).status_code == 400


# ---------- 会话归区 ----------

def test_session_assign_and_filter(admin, alice):
    sa, sb = mk(admin, "合同"), mk(admin, "采购")
    s1 = new_sess(alice, section_id=sa["id"]).json()
    s2 = new_sess(alice, section_id=sb["id"]).json()
    s3 = new_sess(alice, section_id=0).json()
    assert s1["section_id"] == sa["id"] and s1["section_name"] == "合同" and s1["section_archived"] is False

    def ids(qs):
        return {s["id"] for s in client.get("/api/sessions" + qs, headers=alice["headers"]).json()}
    assert ids("") == {s1["id"], s2["id"], s3["id"]}
    assert ids(f"?section_id={sa['id']}") == {s1["id"]}
    assert ids("?section_id=0") == {s3["id"]}   # 0 是“未分类”，不是“全部”


def test_session_filter_zero_not_dropped(admin, alice):
    sec = mk(admin, "合同")
    a = new_sess(alice, section_id=sec["id"]).json()
    b = new_sess(alice, section_id=0).json()
    got = client.get("/api/sessions?section_id=0", headers=alice["headers"]).json()
    assert [s["id"] for s in got] == [b["id"]] and a["id"] not in [s["id"] for s in got]


def test_new_session_passes_section(admin, alice):
    sec = mk(admin, "合同")
    s = new_sess(alice, section_id=sec["id"]).json()
    assert store.db("SELECT section_id FROM sessions WHERE id=?", (s["id"],), one=True)["section_id"] == sec["id"]
    assert user_row(alice)["last_section_id"] == sec["id"]
    # 不传：沿用上次新建的分区
    assert new_sess(alice).json()["section_id"] == sec["id"]


def test_session_clear_with_zero(admin, alice):
    sec = mk(admin, "合同")
    new_sess(alice, section_id=sec["id"])
    s = new_sess(alice, section_id=0).json()
    assert s["section_id"] is None
    assert user_row(alice)["last_section_id"] is None
    assert new_sess(alice).json()["section_id"] is None   # 没有被上次分区顶替
    # PATCH：0 清空，不传/null 不改
    s = new_sess(alice, section_id=sec["id"]).json()
    r = client.patch(f"/api/sessions/{s['id']}", json={"title": "改名"}, headers=alice["headers"]).json()
    assert r["section_id"] == sec["id"]
    r = client.patch(f"/api/sessions/{s['id']}", json={"section_id": None}, headers=alice["headers"]).json()
    assert r["section_id"] == sec["id"]
    r = client.patch(f"/api/sessions/{s['id']}", json={"section_id": 0}, headers=alice["headers"]).json()
    assert r["section_id"] is None and r["section_name"] == ""


def test_patch_does_not_change_last_section(admin, alice):
    a, b = mk(admin, "合同"), mk(admin, "采购")
    s = new_sess(alice, section_id=a["id"]).json()
    assert user_row(alice)["last_section_id"] == a["id"]
    client.patch(f"/api/sessions/{s['id']}", json={"section_id": b["id"]}, headers=alice["headers"])
    assert user_row(alice)["last_section_id"] == a["id"]
    client.patch(f"/api/sessions/{s['id']}", json={"section_id": 0}, headers=alice["headers"])
    assert user_row(alice)["last_section_id"] == a["id"]


def test_session_archived_not_selectable(admin, alice):
    sec = mk(admin, "合同")
    other = mk(admin, "采购")
    s = new_sess(alice, section_id=sec["id"]).json()
    client.patch(f"/api/sections/{sec['id']}", json={"archived": 1}, headers=admin["headers"])
    assert new_sess(alice, section_id=sec["id"]).status_code == 400
    s2 = new_sess(alice, section_id=0).json()
    assert client.patch(f"/api/sessions/{s2['id']}", json={"section_id": sec["id"]}, headers=alice["headers"]).status_code == 400
    assert client.patch(f"/api/sessions/{s2['id']}", json={"section_id": 9999}, headers=alice["headers"]).status_code == 400
    # 当前值就是归档分区：改标题放行，仍显示原分区名
    r = client.patch(f"/api/sessions/{s['id']}", json={"title": "新标题", "section_id": sec["id"]}, headers=alice["headers"])
    assert r.status_code == 200
    assert r.json()["section_name"] == "合同" and r.json()["section_archived"] is True and r.json()["title"] == "新标题"
    # 失败的请求不能顺带把标题改了
    r = client.patch(f"/api/sessions/{s2['id']}", json={"title": "不该生效", "section_id": sec["id"]}, headers=alice["headers"])
    assert r.status_code == 400
    assert store.db("SELECT title FROM sessions WHERE id=?", (s2["id"],), one=True)["title"] == "t"
    assert client.patch(f"/api/sessions/{s['id']}", json={"section_id": other["id"]}, headers=alice["headers"]).status_code == 200


def test_last_section_fallback(admin, alice):
    sec = mk(admin, "合同")
    new_sess(alice, section_id=sec["id"])
    client.patch(f"/api/sections/{sec['id']}", json={"archived": 1}, headers=admin["headers"])
    assert new_sess(alice).json()["section_id"] is None
    # last_section_id 指向被删掉的分区也回退
    store.db("UPDATE users SET last_section_id=9999 WHERE id=?", (alice["id"],))
    assert new_sess(alice).json()["section_id"] is None


def test_session_section_owner_only(admin, alice, make_user):
    bob = make_user("bob")
    sec = mk(admin, "合同")
    s = new_sess(alice).json()
    assert client.patch(f"/api/sessions/{s['id']}", json={"section_id": sec["id"]}, headers=bob["headers"]).status_code == 404
    # 管理员看得到别人的会话，但不能替别人改分区
    r = client.patch(f"/api/sessions/{s['id']}", json={"section_id": sec["id"]}, headers=admin["headers"])
    assert r.status_code == 403
    assert store.db("SELECT section_id FROM sessions WHERE id=?", (s["id"],), one=True)["section_id"] is None


# ---------- 会话视图：状态、耗时、文件数 ----------

def _msg(sid, role, meta=None):
    store.db("INSERT INTO messages (session_id, role, content, meta, created) VALUES (?,?,?,?,?)",
             (sid, role, "x", json.dumps(meta or {}), time.time()))


def _status(u, sid):
    return client.get(f"/api/sessions/{sid}", headers=u["headers"]).json()["session"]


def test_session_status_derivation(alice):
    sid = new_sess(alice).json()["id"]
    assert _status(alice, sid)["status"] == "idle"          # 还没发过消息
    _msg(sid, "user")
    _msg(sid, "assistant", {"seconds": 5})
    assert _status(alice, sid)["status"] == "done"
    for flag in ("stopped", "timed_out", "error"):
        _msg(sid, "error", {flag: True})
        assert _status(alice, sid)["status"] == "stopped", flag
    _msg(sid, "assistant", {"seconds": 1})
    assert _status(alice, sid)["status"] == "done"          # 最后一轮成功了
    runner.RUNS[sid] = runner.Run(sid, alice["id"])
    assert _status(alice, sid)["status"] == "running"
    approvals.APPROVALS["a1"] = {"session_id": sid}
    assert _status(alice, sid)["status"] == "pending"       # pending 优先于 running
    # 列表接口给出同样的状态
    assert [s["status"] for s in client.get("/api/sessions", headers=alice["headers"]).json()] == ["pending"]


def test_session_duration_file_count(alice):
    sid = new_sess(alice).json()["id"]
    _msg(sid, "user")
    _msg(sid, "assistant", {"seconds": 5})
    _msg(sid, "assistant", {"seconds": 42})
    v = _status(alice, sid)
    assert v["duration_seconds"] == 42 and v["message_count"] == 3 and v["file_count"] == 0
    store.db("INSERT INTO links (id, session_id, user_id, name, created, manifest) VALUES (?,?,?,?,?,?)",
             ("l1", sid, alice["id"], "n", 0, json.dumps({"a.txt": [1, 2], "b.txt": [3, 4]})))
    store.db("INSERT INTO links (id, session_id, user_id, name, created, manifest) VALUES (?,?,?,?,?,?)",
             ("l2", sid, alice["id"], "n", 0, None))
    assert _status(alice, sid)["file_count"] == 2
    # 没有助手消息：退回 updated - created，不造假
    s2 = new_sess(alice).json()["id"]
    store.db("UPDATE sessions SET created=100, updated=130 WHERE id=?", (s2,))
    assert _status(alice, s2)["duration_seconds"] == 30
    store.db("UPDATE sessions SET created=NULL WHERE id=?", (s2,))
    assert _status(alice, s2)["duration_seconds"] is None


# ---------- 知识库：frontmatter、搜索、首页、图谱 ----------

def test_note_frontmatter_section(admin, alice):
    mk(admin, "合同")
    r = put_note(alice, "合同模板", section="合同")
    assert r.status_code == 200
    assert fm(r.json()["path"])["section"] == "合同"
    n = client.get("/api/kb/note", params={"path": r.json()["path"]}, headers=alice["headers"]).json()["note"]
    assert n["section"] == "合同"
    assert any(x["section"] == "合同" for x in client.get("/api/kb", headers=alice["headers"]).json()["notes"])


def test_note_create_without_section_is_uncategorized(admin, alice):
    mk(admin, "合同")
    r = put_note(alice, "无分区")
    assert "section" not in fm(r.json()["path"])


def test_note_update_without_section_keeps_section(admin, alice):
    mk(admin, "合同")
    rel = put_note(alice, "笔记", section="合同").json()["path"]
    assert put_note(alice, "笔记", body="新正文", path=rel).status_code == 200
    assert fm(rel)["section"] == "合同"
    assert client.post("/api/kb/status", json={"path": rel, "status": "过时"}, headers=alice["headers"]).status_code == 200
    assert fm(rel)["section"] == "合同"


def test_note_body_empty_section_clears(admin, alice):
    mk(admin, "合同")
    rel = put_note(alice, "笔记", section="合同").json()["path"]
    assert put_note(alice, "笔记", path=rel, section="").status_code == 200
    assert "section" not in fm(rel)


def test_note_body_section_validated(admin, alice):
    sec = mk(admin, "合同")
    assert put_note(alice, "笔记", section="不存在").status_code == 400
    client.patch(f"/api/sections/{sec['id']}", json={"archived": 1}, headers=admin["headers"])
    assert put_note(alice, "笔记", section="合同").status_code == 400   # 归档的也不能选
    assert not list(store.KB_ROOT.glob("经验/笔记.md"))
    # 校验在改标题之前：分区不对时不会先把文件改名
    mk(admin, "采购")
    rel = put_note(alice, "旧标题", section="采购").json()["path"]
    assert put_note(alice, "新标题", path=rel, section="不存在").status_code == 400
    assert (store.KB_ROOT / rel).exists()


def test_section_name_canonical(admin, alice):
    mk(admin, "HR")
    rel = put_note(alice, "笔记", section="hr").json()["path"]
    assert fm(rel)["section"] == "HR"   # 写库里的原文，不是用户输入的大小写
    sid = client.get("/api/sections", headers=alice["headers"]).json()[0]["id"]
    assert new_sess(alice, section_id=sid).status_code == 200


def test_note_content_section_ignored(admin, alice):
    mk(admin, "合同")
    r = put_note(alice, "笔记", body="---\nsection: 合同\ntags: [a]\n---\n正文")
    assert "section" not in fm(r.json()["path"])
    r = put_note(alice, "笔记二", body="---\nsection: 乱写的\n---\n正文", section="合同")
    assert fm(r.json()["path"])["section"] == "合同"
    # 更新时正文里写别的分区同样无效
    rel = r.json()["path"]
    put_note(alice, "笔记二", path=rel, body="---\nsection: 乱写的\n---\n新正文")
    assert fm(rel)["section"] == "合同"


def _claude_write(sid, title, **kw):
    r = client.post("/api/internal/kb/write", headers=INTERNAL,
                    json={"session_id": sid, "title": title, "content": "内容", "type": "经验", **kw})
    assert r.status_code == 200, r.text
    return r.json()["path"]


def test_internal_write_fills_empty_note(admin, alice):
    sec = mk(admin, "合同")
    old = put_note(alice, "老笔记").json()["path"]       # 原本没有分区
    sid = new_sess(alice, section_id=sec["id"]).json()["id"]
    assert _claude_write(sid, "老笔记", mode="update") == old
    assert fm(old)["section"] == "合同"
    fresh = _claude_write(sid, "新笔记")                   # 新建也补
    assert fm(fresh)["section"] == "合同"
    # Claude 传了 section 也不采用：以会话分区为准
    s0 = new_sess(alice, section_id=0).json()["id"]
    other = mk(admin, "采购")
    p = _claude_write(s0, "第三条", section="采购")
    assert "section" not in fm(p)
    p = _claude_write(sid, "第四条", section="采购")
    assert fm(p)["section"] == "合同"
    assert other["name"] == "采购"


def test_internal_write_keeps_existing_section(admin, alice):
    mk(admin, "采购")
    hetong = mk(admin, "合同")
    rel = put_note(alice, "笔记", section="采购").json()["path"]
    sid = new_sess(alice, section_id=hetong["id"]).json()["id"]
    _claude_write(sid, "笔记", mode="update")
    assert fm(rel)["section"] == "采购"
    _claude_write(sid, "笔记", mode="append")
    assert fm(rel)["section"] == "采购"


def test_internal_write_archived_session_section_not_filled(admin, alice):
    sec = mk(admin, "合同")
    sid = new_sess(alice, section_id=sec["id"]).json()["id"]
    client.patch(f"/api/sections/{sec['id']}", json={"archived": 1}, headers=admin["headers"])
    p = _claude_write(sid, "笔记")
    assert "section" not in fm(p)   # 分区已下架：不再往笔记里补


def _seed_notes(admin, alice):
    mk(admin, "合同")
    mk(admin, "采购")
    return {
        "c1": put_note(alice, "合同流程", section="合同", body="退货 流程 [[采购规则]]").json()["path"],
        "p1": put_note(alice, "采购规则", section="采购", body="退货 流程").json()["path"],
        "u1": put_note(alice, "杂项", body="退货 流程 [[不存在的]]").json()["path"],
    }


def test_search_section_excludes_uncategorized(admin, alice):
    n = _seed_notes(admin, alice)
    got = client.get("/api/kb/search", params={"q": "退货", "section": "合同"}, headers=alice["headers"]).json()["results"]
    assert [r["path"] for r in got] == [n["c1"]]
    all_ = client.get("/api/kb/search", params={"q": "退货"}, headers=alice["headers"]).json()["results"]
    assert {r["path"] for r in all_} == set(n.values())    # 不传 = 全库
    assert all_[0]["section"] in ("合同", "采购", "")


def test_search_uncategorized_only(admin, alice):
    n = _seed_notes(admin, alice)
    got = client.get("/api/kb/search", params={"q": "退货", "section": "__uncategorized__"},
                     headers=alice["headers"]).json()["results"]
    assert [r["path"] for r in got] == [n["u1"]]


def test_internal_search_passes_section(admin, alice):
    n = _seed_notes(admin, alice)
    sid = new_sess(alice).json()["id"]
    r = client.post("/api/internal/kb/search", headers=INTERNAL,
                    json={"session_id": sid, "query": "退货", "section": "采购"}).json()
    assert [x["path"] for x in r["results"]] == [n["p1"]]
    r = client.post("/api/internal/kb/search", headers=INTERNAL, json={"session_id": sid, "query": "退货"}).json()
    assert len(r["results"]) == 3


def test_kb_home_returns_all_notes(admin, alice):
    n = _seed_notes(admin, alice)
    d = client.get("/api/kb", params={"section": "合同"}, headers=alice["headers"]).json()
    assert {x["path"] for x in d["notes"]} == set(n.values()) | {kb.GUIDE_NAME}   # [[链接]] 解析靠全库
    assert d["stats"]["total"] == 1 and d["stats"]["by_type"] == {"经验": 1}
    assert {x["path"] for x in d["recent"]} == {n["c1"]}
    full = client.get("/api/kb", headers=alice["headers"]).json()
    assert full["stats"]["total"] == 4 and {x["path"] for x in full["recent"]} == set(n.values())
    d = client.get("/api/kb", params={"section": "__uncategorized__"}, headers=alice["headers"]).json()
    assert d["stats"]["total"] == 2 and len(d["notes"]) == 4   # 杂项 + 自带的“知识库说明”


def test_kb_home_recent_filtered_by_section(admin, alice):
    n = _seed_notes(admin, alice)
    for _ in range(5):   # 其他分区的修改很多，也不能把合同的挤掉或混进来
        put_note(alice, "采购规则", path=n["p1"], section="采购", body=f"改{time.time()}")
    d = client.get("/api/kb", params={"section": "合同"}, headers=alice["headers"]).json()
    assert {x["path"] for x in d["recent"]} == {n["c1"]}
    d = client.get("/api/kb", params={"section": "采购"}, headers=alice["headers"]).json()
    assert {x["path"] for x in d["recent"]} == {n["p1"]}


def test_kb_home_today_new(admin, alice):
    n = _seed_notes(admin, alice)
    topic = put_note(alice, "某客户", type="主题").json()["path"]
    d = client.get("/api/kb", headers=alice["headers"]).json()
    assert {x["path"] for x in d["today_new"]} == set(n.values())    # 主题不算；经验/卡片才算
    assert topic not in {x["path"] for x in d["today_new"]}
    assert d["stats"]["week"] == 5                                   # week 是另一回事
    # 昨天新建、今天只是修改的不算
    store.db("UPDATE kb_history SET created=created-172800 WHERE path=?", (n["c1"],))
    put_note(alice, "合同流程", path=n["c1"], body="今天改了")
    d = client.get("/api/kb", headers=alice["headers"]).json()
    assert n["c1"] not in {x["path"] for x in d["today_new"]}
    d = client.get("/api/kb", params={"section": "采购"}, headers=alice["headers"]).json()
    assert {x["path"] for x in d["today_new"]} == {n["p1"]}


def test_kb_home_and_graph_filter_same_rule(admin, alice):
    n = _seed_notes(admin, alice)
    home = client.get("/api/kb", params={"section": "合同"}, headers=alice["headers"]).json()
    g = client.get("/api/kb/graph", params={"section": "合同"}, headers=alice["headers"]).json()
    real = [x for x in g["nodes"] if x["type"] != "ghost"]
    assert [x["id"] for x in real] == [n["c1"]] and len(real) == home["stats"]["total"]
    assert g["edges"] == []                    # 合同→采购规则 的另一端被过滤了，边不保留
    assert not [x for x in g["nodes"] if x["type"] == "ghost"]   # “不存在的”只被未分类的笔记提到
    gu = client.get("/api/kb/graph", params={"section": "__uncategorized__"}, headers=alice["headers"]).json()
    assert [x["title"] for x in gu["nodes"] if x["type"] == "ghost"] == ["不存在的"]
    assert {x["id"] for x in gu["nodes"] if x["type"] != "ghost"} == {n["u1"], kb.GUIDE_NAME}
    full = client.get("/api/kb/graph", headers=alice["headers"]).json()
    assert len([x for x in full["nodes"] if x["type"] != "ghost"]) == 4
    assert len(full["edges"]) == 2             # 合同→采购规则、杂项→ghost


# ---------- 改名 ----------

def test_rename_updates_notes(admin, alice):
    sec = mk(admin, "合同")
    a = put_note(alice, "A", section="合同", body="带冒号: 和 [[链接]]").json()["path"]
    b = put_note(alice, "B", section="合同").json()["path"]
    c = put_note(alice, "C").json()["path"]
    r = client.patch(f"/api/sections/{sec['id']}", json={"name": "合同评审"}, headers=admin["headers"])
    assert r.status_code == 200 and r.json()["name"] == "合同评审"
    assert fm(a)["section"] == fm(b)["section"] == "合同评审"
    assert "section" not in fm(c)
    assert "带冒号: 和 [[链接]]" in note_file(a)            # 正文原样保留
    assert fm(a)["author"] == "alice" and fm(a)["type"] == "经验"
    assert store.db("SELECT name FROM sections WHERE id=?", (sec["id"],), one=True)["name"] == "合同评审"
    assert store.db("SELECT value FROM settings WHERE key=?", (kb.RENAME_KEY,), one=True) is None
    assert client.get("/api/sections", headers=admin["headers"]).json()[0]["note_count"] == 2
    # 改名到已存在（含归档）的名字：409，什么都不动
    other = mk(admin, "采购")
    r = client.patch(f"/api/sections/{other['id']}", json={"name": "合同评审"}, headers=admin["headers"])
    assert r.status_code == 409
    # 只改大小写也行
    r = client.patch(f"/api/sections/{sec['id']}", json={"name": "合同评审X"}, headers=admin["headers"])
    assert r.status_code == 200 and fm(a)["section"] == "合同评审X"


def test_rename_failure_rolls_back_files_and_name(admin, alice, monkeypatch):
    sec = mk(admin, "合同")
    paths = [put_note(alice, f"N{i}", section="合同").json()["path"] for i in range(3)]
    before = {p: note_file(p) for p in paths}
    hist_before = store.db("SELECT COUNT(*) AS c FROM kb_history", one=True)["c"]
    real = kb._atomic_write
    calls = {"n": 0}

    def flaky(p, data):
        calls["n"] += 1
        if calls["n"] == 2:   # 第 2 篇只失败一次；回滚时的写入能成功
            raise OSError("磁盘被占用")
        return real(p, data)
    monkeypatch.setattr(kb, "_atomic_write", flaky)
    with pytest.raises(OSError):
        kb.rename_section(sec["id"], "合同", "合同评审", admin | {"display_name": "boss"})
    monkeypatch.setattr(kb, "_atomic_write", real)
    assert {p: note_file(p) for p in paths} == before                    # 第 1 篇已恢复
    assert store.db("SELECT name FROM sections WHERE id=?", (sec["id"],), one=True)["name"] == "合同"
    assert store.db("SELECT COUNT(*) AS c FROM kb_history", one=True)["c"] == hist_before
    assert not store.db("SELECT 1 FROM kb_history WHERE content LIKE '%合同评审%'")
    assert store.db("SELECT value FROM settings WHERE key=?", (kb.RENAME_KEY,), one=True) is None
    assert not list(store.KB_ROOT.rglob("*.saving"))
    assert {n["section"] for n in kb.index(force=True).notes.values() if n["path"] in paths} == {"合同"}


def test_rename_failure_through_api_keeps_name(admin, alice, monkeypatch):
    sec = mk(admin, "合同")
    rel = put_note(alice, "N", section="合同").json()["path"]
    monkeypatch.setattr(kb, "_atomic_write", lambda p, d: (_ for _ in ()).throw(OSError("x")))
    c = TestClient(server.app, raise_server_exceptions=False)
    r = c.patch(f"/api/sections/{sec['id']}", json={"name": "新名"}, headers=admin["headers"])
    assert r.status_code == 500
    monkeypatch.undo()
    assert fm(rel)["section"] == "合同"
    assert client.get("/api/sections", headers=admin["headers"]).json()[0]["name"] == "合同"


def test_rename_recovery_after_crash(admin, alice):
    sec = mk(admin, "合同")
    paths = [put_note(alice, f"N{i}", section="合同").json()["path"] for i in range(3)]
    # 模拟崩溃：标记已写、sections.name 已改、只有第 1 篇改完
    store.set_setting(kb.RENAME_KEY, {"section_id": sec["id"], "old": "合同", "new": "合同评审"})
    store.db("UPDATE sections SET name=? WHERE id=?", ("合同评审", sec["id"]))
    _, new_bytes = kb._retag(paths[0], "合同评审")
    (store.KB_ROOT / paths[0]).write_bytes(new_bytes)
    kb.recover_section_rename()
    assert [fm(p)["section"] for p in paths] == ["合同评审"] * 3
    assert store.get_setting(kb.RENAME_KEY) is None
    kb.recover_section_rename()   # 没有标记：什么都不做


def test_rename_recovery_not_committed_or_missing(admin, alice):
    sec = mk(admin, "合同")
    rel = put_note(alice, "N", section="合同").json()["path"]
    store.set_setting(kb.RENAME_KEY, {"section_id": sec["id"], "old": "合同", "new": "合同评审"})
    kb.recover_section_rename()          # sections.name 还是旧名：只删标记
    assert fm(rel)["section"] == "合同" and store.get_setting(kb.RENAME_KEY) is None
    store.set_setting(kb.RENAME_KEY, {"section_id": 9999, "old": "a", "new": "b"})
    kb.recover_section_rename()          # 分区不存在：删标记
    assert store.get_setting(kb.RENAME_KEY) is None


def test_rename_success_history_written_after_files(admin, alice):
    sec = mk(admin, "合同")
    rel = put_note(alice, "N", section="合同").json()["path"]
    client.patch(f"/api/sections/{sec['id']}", json={"name": "合同评审"}, headers=admin["headers"])
    hist = store.db("SELECT * FROM kb_history WHERE path=? ORDER BY id", (rel,))
    assert "section: 合同评审" in hist[-1]["content"] and hist[-1]["note"].startswith("分区改名")
    assert "section: 合同\n" in hist[0]["content"]
    assert hist[-1]["content"] == note_file(rel)          # 历史里的最新版本就是文件现状
    # 从最新历史版本恢复不会把笔记串回旧分区
    client.post(f"/api/kb/history/{hist[-1]['id']}/restore", headers=alice["headers"])
    assert fm(rel)["section"] == "合同评审"


def test_any_user_can_edit_note_section(admin, alice, make_user):
    bob = make_user("bob")
    mk(admin, "合同")
    mk(admin, "采购")
    rel = put_note(alice, "笔记", section="合同").json()["path"]
    r = put_note(bob, "笔记", path=rel, section="采购")       # bob 不是作者
    assert r.status_code == 200 and fm(rel)["section"] == "采购"
    assert fm(rel)["author"] == "alice" and "bob" in fm(rel)["contributors"]
