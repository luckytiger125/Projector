"""加固：上传的网页不能以本站身份运行、文本预览不整读大文件、上传中断不留临时文件、登录限次、
会话列表分页、“最后一轮”只查本批会话、完整过程只给最后几步、删会话/删用户清干净、定期清理。"""
import json
import os
import time

from fastapi.testclient import TestClient

import auth_api
import files_api
import housekeeping
import sessions_api
import store

import server  # noqa: E402  (conftest 已先设好临时目录)


def _session(sid, uid, updated=None, section_id=None):
    now = updated or time.time()
    store.db("INSERT INTO sessions (id, title, source, created, updated, bypass, user_id, section_id) VALUES (?,?,?,?,?,0,?,?)",
             (sid, sid, "web", now, now, uid, section_id))


# ---------- 文件 ----------

def test_uploaded_html_and_svg_are_never_rendered_as_pages(make_user):
    alice = make_user("alice")
    for name in ("evil.html", "evil.svg", "evil.xhtml"):
        (store.FILE_ROOT / name).write_text("<script>alert(1)</script>", encoding="utf-8")
    (store.FILE_ROOT / "a.png").write_bytes(b"\x89PNG")
    (store.FILE_ROOT / "a.pdf").write_bytes(b"%PDF-1.4")
    c = TestClient(server.app)
    c.cookies.set(store.AUTH_COOKIE, alice["token"])   # 别人发来的链接，浏览器就是这样只带 cookie 打开的
    for name in ("evil.html", "evil.svg", "evil.xhtml"):
        r = c.get(f"/api/files/raw?path={name}")
        assert r.status_code == 200
        assert r.headers["content-disposition"].startswith("attachment"), name
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["content-security-policy"] == "sandbox"
    png = c.get("/api/files/raw?path=a.png")
    assert png.headers["content-disposition"].startswith("inline") and png.headers["x-content-type-options"] == "nosniff"
    pdf = c.get("/api/files/raw?path=a.pdf")
    assert pdf.headers["content-disposition"].startswith("inline") and "content-security-policy" not in pdf.headers
    assert c.get("/api/files/raw?path=a.png&download=1").headers["content-disposition"].startswith("attachment")


def test_text_preview_reads_only_the_first_megabyte(make_user, monkeypatch):
    alice = make_user("alice")
    (store.FILE_ROOT / "big.log").write_bytes(b"a" * (files_api.TEXT_LIMIT + 5000))
    (store.FILE_ROOT / "adir").mkdir(exist_ok=True)
    from pathlib import Path
    monkeypatch.setattr(Path, "read_bytes", lambda self: (_ for _ in ()).throw(AssertionError("不该整个读进来")))
    c = TestClient(server.app)
    d = c.get("/api/files/text?path=big.log", headers=alice["headers"]).json()
    assert d["truncated"] is True and len(d["text"]) == files_api.TEXT_LIMIT
    assert c.get("/api/files/text?path=adir", headers=alice["headers"]).status_code == 400


def test_upload_writes_file_and_too_big_leaves_no_temp(make_user, monkeypatch):
    alice = make_user("alice")
    c = TestClient(server.app)
    r = c.put("/api/files/upload?dir=&name=up/a.txt", content=b"hello", headers=alice["headers"])
    assert r.status_code == 200 and (store.FILE_ROOT / "up" / "a.txt").read_bytes() == b"hello"
    monkeypatch.setattr(files_api, "MAX_UPLOAD", 10)

    def body():   # 分块发、不带 Content-Length：只能在收的过程中发现超了
        yield b"12345678"
        yield b"12345678"
    r = c.put("/api/files/upload?dir=&name=up/b.txt", content=body(), headers=alice["headers"])
    assert r.status_code == 413
    assert sorted(p.name for p in (store.FILE_ROOT / "up").iterdir()) == ["a.txt"]


# ---------- 登录 ----------

def _real_user(name, pw="secret1"):
    store.db("INSERT INTO users (username, display_name, pw_hash, role, created) VALUES (?,?,?,?,0)",
             (name, name, store.hash_password(pw), "user"))


def test_login_locks_after_repeated_failures(monkeypatch):
    async def no_sleep(_):
        return None
    monkeypatch.setattr(auth_api.asyncio, "sleep", no_sleep)
    _real_user("alice")
    c = TestClient(server.app)
    for _ in range(auth_api.LOGIN_MAX_FAILS):
        assert c.post("/api/login", json={"username": "alice", "password": "wrong"}).status_code == 401
    # 锁住以后，对的密码也不行；不存在的用户名同样计数
    assert c.post("/api/login", json={"username": "alice", "password": "secret1"}).status_code == 429
    # 过了时间窗就恢复
    for k in list(auth_api._fails):
        auth_api._fails[k] = [t - auth_api.LOGIN_WINDOW - 1 for t in auth_api._fails[k]]
    assert c.post("/api/login", json={"username": "alice", "password": "secret1"}).status_code == 200


def test_login_success_clears_the_account_counter(monkeypatch):
    async def no_sleep(_):
        return None
    monkeypatch.setattr(auth_api.asyncio, "sleep", no_sleep)
    _real_user("alice")
    c = TestClient(server.app)
    for _ in range(3):
        c.post("/api/login", json={"username": "alice", "password": "wrong"})
    assert c.post("/api/login", json={"username": "ALICE", "password": "secret1"}).status_code == 200
    assert "u:alice" not in auth_api._fails
    assert c.post("/api/login", json={"username": "nobody", "password": "x"}).status_code == 401


def test_purge_tokens_removes_only_expired(make_user):
    alice = make_user("alice")
    old = store.issue_token(alice["id"])
    store.db("UPDATE tokens SET last_used=? WHERE token=?", (time.time() - (store.TOKEN_IDLE_DAYS + 1) * 86400, old))
    assert store.purge_tokens() == 1
    assert [r["token"] for r in store.db("SELECT token FROM tokens")] == [alice["token"]]


# ---------- 会话 ----------

def test_session_list_pages_cover_everything_once(make_user):
    alice, bob = make_user("alice"), make_user("bob")
    for i in range(7):
        _session(f"s{i}", alice["id"], updated=1000.0 + i // 2)   # 故意有相同的更新时间
    _session("other", bob["id"], updated=5000.0)
    c = TestClient(server.app)
    everything = [s["id"] for s in c.get("/api/sessions", headers=alice["headers"]).json()]
    assert len(everything) == 7 and "other" not in everything
    seen, before = [], ""
    for _ in range(10):
        r = c.get("/api/sessions", params={"limit": 3, **({"before": before} if before else {})}, headers=alice["headers"])
        seen += [s["id"] for s in r.json()]
        before = r.headers.get("x-next-before", "")
        if not before:
            break
    assert seen == everything
    assert c.get("/api/sessions", params={"limit": 3, "before": "abc"}, headers=alice["headers"]).status_code == 400


def test_admin_session_list_pages(make_user):
    boss, alice = make_user("boss", role="admin"), make_user("alice")
    for i in range(5):
        _session(f"s{i}", alice["id"], updated=1000.0 + i)
    c = TestClient(server.app)
    r = c.get("/api/admin/sessions", params={"limit": 2}, headers=boss["headers"])
    assert [s["id"] for s in r.json()] == ["s4", "s3"] and r.headers["x-next-before"]
    assert len(c.get("/api/admin/sessions", headers=boss["headers"]).json()) == 5


def test_last_turn_only_looks_at_the_requested_sessions(make_user):
    alice = make_user("alice")
    _session("a", alice["id"])
    _session("b", alice["id"])
    for sid, role in (("a", "assistant"), ("a", "error"), ("b", "assistant"), ("b", "user")):
        store.db("INSERT INTO messages (session_id, role, content, meta, created) VALUES (?,?,?,?,0)", (sid, role, "x", "{}"))
    st = sessions_api.session_stats(["a", "b"])
    assert st["a"]["last"]["role"] == "error" and st["b"]["last"]["role"] == "assistant"
    assert st["a"]["message_count"] == 2
    plan = store.db("EXPLAIN QUERY PLAN SELECT MAX(id) FROM messages WHERE session_id IN (?) AND role IN ('assistant','error') "
                    "GROUP BY session_id", ("a",))
    assert any("idx_msg_session" in r["detail"] for r in plan)   # 走索引，不是整表扫


def test_transcript_returns_only_the_tail(make_user, tmp_path, monkeypatch):
    alice = make_user("alice")
    _session("t1", alice["id"])
    store.db("UPDATE sessions SET claude_session='cs-tail' WHERE id='t1'")
    monkeypatch.setattr(sessions_api, "CLAUDE_HOME", tmp_path)   # 不碰真实的 ~/.claude
    d = tmp_path / "projects" / "p"
    d.mkdir(parents=True)
    (d / "cs-tail.jsonl").write_text(
        "\n".join(json.dumps({"type": "user", "message": {"content": f"第{i}步"}}, ensure_ascii=False) for i in range(10)),
        encoding="utf-8")
    c = TestClient(server.app)
    d1 = c.get("/api/sessions/t1/transcript?limit=3", headers=alice["headers"]).json()
    assert [s["text"] for s in d1["steps"]] == ["第7步", "第8步", "第9步"] and d1["truncated"] and "3" in d1["note"]
    d2 = c.get("/api/sessions/t1/transcript", headers=alice["headers"]).json()
    assert len(d2["steps"]) == 10 and not d2["truncated"] and not d2.get("note")


def test_delete_session_and_user_remove_config_and_logs(make_user):
    boss, alice = make_user("boss", role="admin"), make_user("alice")
    _session("d1", alice["id"])
    _session("d2", alice["id"])
    logs = store.DATA / "logs"
    logs.mkdir(exist_ok=True)
    made = []
    for sid in ("d1", "d2"):
        for p in (store.DATA / "mcp" / f"hint_{sid}.txt", store.DATA / "mcp" / f"{sid}.json", logs / f"claude_{sid}.log"):
            p.write_text("x", encoding="utf-8")
            made.append(p)
    c = TestClient(server.app)
    assert c.delete("/api/sessions/d1", headers=alice["headers"]).status_code == 200
    assert not any(p.exists() for p in made if "d1" in p.name) and all(p.exists() for p in made if "d2" in p.name)
    assert c.delete(f"/api/admin/users/{alice['id']}", headers=boss["headers"]).status_code == 200
    assert not any(p.exists() for p in made)
    assert store.db("SELECT COUNT(*) AS c FROM sessions", one=True)["c"] == 0


def test_db_tx_rolls_back_everything_on_error(make_user):
    alice = make_user("alice")
    _session("x1", alice["id"])
    try:
        store.db_tx([("DELETE FROM sessions WHERE id=?", ("x1",)), ("DELETE FROM no_such_table", ())])
    except Exception:
        pass
    assert store.db("SELECT 1 FROM sessions WHERE id='x1'", one=True)


# ---------- 定期清理 ----------

def test_prune_preview_drops_old_and_oversize():
    cache = store.DATA / "preview"
    for p in cache.glob("*.pdf"):
        p.unlink()
    now = time.time()
    old, a, b = cache / "old.pdf", cache / "a.pdf", cache / "b.pdf"
    for p, age in ((old, 40 * 86400), (a, 200), (b, 100)):
        p.write_bytes(b"x" * 100)
        os.utime(p, (now - age, now - age))
    assert housekeeping.prune_preview(now) == 1 and not old.exists() and a.exists() and b.exists()
    assert housekeeping.prune_preview(now, max_bytes=150) == 1 and not a.exists() and b.exists()   # 超量：先删更久没用的
    b.unlink()


def test_prune_logs_deletes_orphans_trims_big_and_skips_running(make_user, monkeypatch):
    alice = make_user("alice")
    _session("live1", alice["id"])
    logs = store.DATA / "logs"
    logs.mkdir(exist_ok=True)
    monkeypatch.setattr(housekeeping, "LOG_MAX_BYTES", 1000)
    monkeypatch.setattr(housekeeping, "LOG_KEEP_BYTES", 200)
    orphan, running, big = logs / "claude_gone1.log", logs / "claude_gone2.log", logs / "claude_live1.log"
    orphan.write_text("x", encoding="utf-8")
    running.write_text("x", encoding="utf-8")
    big.write_text("".join(f"第{i}行\n" for i in range(500)), encoding="utf-8")
    out = housekeeping.prune_logs(running={"gone2"})
    assert not orphan.exists() and running.exists() and out["deleted"] >= 1 and out["trimmed"] >= 1
    text = big.read_text(encoding="utf-8")
    assert len(text.encode()) < 400 and text.endswith("第499行\n") and text.splitlines()[1].startswith("第")
    running.unlink()
    big.unlink()


def test_prune_file_ops_keeps_newest(make_user):
    alice = make_user("alice")
    store.db("DELETE FROM file_ops")
    for i in range(10):
        store.log_file_op(alice, "上传", f"f{i}")
    assert housekeeping.prune_file_ops(keep=4) == 6
    assert [r["path"] for r in store.db("SELECT path FROM file_ops ORDER BY id")] == ["f6", "f7", "f8", "f9"]
    assert housekeeping.prune_file_ops(keep=4) == 0
    store.db("DELETE FROM file_ops")


def test_run_all_survives_a_failing_job(monkeypatch):
    monkeypatch.setattr(files_api, "purge_trash", lambda: 1 / 0)
    out = housekeeping.run_all()
    assert out["trash"] == "出错" and isinstance(out["tokens"], int) and isinstance(out["file_ops"], int)
