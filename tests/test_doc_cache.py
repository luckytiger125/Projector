"""文档 MD 持久缓存：命中/失效、空文本和扫描件状态、不缓存异常和临时转换、清理、管理接口、拒绝规则。"""
import os
import threading
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

import files_api
import kb
import runner
import server
import store

client = TestClient(server.app)
INTERNAL = {"Authorization": f"Bearer {store.INTERNAL_TOKEN}"}

DOCX_XML = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/'
            'wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')


def make_docx(path, *paras):
    body = "".join(f"<w:p><w:r><w:t>{t}</w:t></w:r></w:p>" for t in paras)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", DOCX_XML.format(body=body))
    return path


def make_blank_pdf(path, pages=2):
    from pypdf import PdfWriter
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    with open(path, "wb") as f:
        w.write(f)
    return path


def rows():
    return store.db("SELECT * FROM doc_cache")


def cache_files():
    return sorted(f.name for f in kb.DOC_CACHE_DIR.iterdir())


@pytest.fixture(autouse=True)
def clean_cache():
    def wipe():
        kb._l1.clear()
        store.db("DELETE FROM doc_cache")
        store.db("DELETE FROM settings WHERE key=?", (kb.PRUNE_KEY,))
        for f in kb.DOC_CACHE_DIR.iterdir():
            f.unlink()
    wipe()
    yield
    wipe()


@pytest.fixture
def calls(monkeypatch):
    """包一层 _extract_uncached 数调用次数。"""
    real = kb._extract_uncached
    seen = []

    def counting(p):
        seen.append(p)
        return real(p)
    monkeypatch.setattr(kb, "_extract_uncached", counting)
    return seen


@pytest.fixture
def docx(tmp_path):
    return make_docx(tmp_path / "a.docx", "第一段", "第二段")


def bump_mtime(p):
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))


def test_second_read_uses_cache(docx, calls):
    a = kb.extract_document(docx)
    b = kb.extract_document(docx)
    assert len(calls) == 1
    assert a["text"] == b["text"] and "第一段" in a["text"]
    assert a["cached"] is False and b["cached"] is True
    assert kb.extract_text(docx) == a["text"]
    assert len(rows()) == 1 and rows()[0]["status"] == "ok"


def test_mtime_change_invalidates(docx, calls):
    kb.extract_document(docx)
    bump_mtime(docx)
    d = kb.extract_document(docx)
    assert len(calls) == 2 and d["cached"] is False
    # 大小变化同样失效
    make_docx(docx, "第一段", "第二段", "第三段")
    os.utime(docx, ns=(1, rows()[0]["mtime_ns"]))   # 故意把 mtime 还原，只靠 size 区分
    d = kb.extract_document(docx)
    assert len(calls) == 3 and "第三段" in d["text"]
    assert len(rows()) == 1   # 同一路径只有一行


def test_extractor_version_change_invalidates(docx, calls, monkeypatch):
    kb.extract_document(docx)
    monkeypatch.setattr(kb, "EXTRACTOR_VERSION", kb.EXTRACTOR_VERSION + 1)
    d = kb.extract_document(docx)
    assert len(calls) == 2 and d["cached"] is False
    assert rows()[0]["extractor_version"] == kb.EXTRACTOR_VERSION


def test_empty_text_cached(tmp_path, calls):
    p = tmp_path / "empty.txt"
    p.write_text("", encoding="utf-8")
    d = kb.extract_document(p)
    assert d["text"] == "" and d["status"] == "empty"
    r = rows()[0]
    assert r["status"] == "empty" and r["chars"] == 0 and (kb.DOC_CACHE_DIR / r["md_name"]).is_file()
    kb._l1.clear()   # 走 L2
    d2 = kb.extract_document(p)
    assert d2["status"] == "empty" and d2["cached"] is True and len(calls) == 1


def test_scan_pdf_cached_as_scan(tmp_path, calls):
    p = make_blank_pdf(tmp_path / "scan.pdf")
    d = kb.extract_document(p)
    assert d["status"] == "scan"
    assert "## 第 1 页" in d["text"] and "## 第 2 页" in d["text"]   # 页码骨架保留
    assert "扫描件" not in d["text"] and "OCR" not in d["text"]       # 提示不进正文
    r = rows()[0]
    assert r["status"] == "scan"
    assert "扫描件" not in (kb.DOC_CACHE_DIR / r["md_name"]).read_text(encoding="utf-8")
    kb._l1.clear()
    d2 = kb.extract_document(p)
    assert d2["status"] == "scan" and d2["cached"] is True and d2["text"] == d["text"] and len(calls) == 1


def test_pypdf_missing_not_cached(tmp_path, monkeypatch):
    p = make_blank_pdf(tmp_path / "x.pdf")
    real = kb._pdf

    def broken(_p):
        raise ImportError("no pypdf")
    monkeypatch.setattr(kb, "_pdf", broken)
    with pytest.raises(ImportError):
        kb.extract_document(p)
    assert kb._l1 == {} and rows() == [] and cache_files() == []
    # 真实 _pdf 缺库时抛带安装说明的异常，而不是返回说明文字
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "pypdf":
            raise ImportError("no pypdf")
        return real_import(name, *a, **k)
    monkeypatch.setattr(kb, "_pdf", real)
    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(kb.HTTPException) as ei:
        kb.extract_document(p)
    monkeypatch.setattr(builtins, "__import__", real_import)
    assert "pip install pypdf" in ei.value.detail
    assert kb._l1 == {} and rows() == []
    # 装上之后（这里即恢复 import）同一个文件能重新提取
    assert kb.extract_document(p)["status"] == "scan"


def test_temp_conversion_not_cached(tmp_path, monkeypatch):
    src = tmp_path / "old.doc"
    src.write_bytes(b"not really a doc")
    converted = []

    def fake_run(cmd, **kw):
        outdir = cmd[cmd.index("--outdir") + 1]
        out = make_docx(os.path.join(outdir, "old.docx"), "转换后的内容")
        converted.append(str(out))

    monkeypatch.setattr(files_api, "SOFFICE", "soffice")
    monkeypatch.setattr(kb.subprocess, "run", fake_run)
    d = kb.extract_document(src)
    assert "转换后的内容" in d["text"] and converted
    paths = [r["source_path"] for r in rows()]
    assert paths == [os.path.normcase(str(src.resolve()))]
    assert all(k[0] == paths[0] for k in kb._l1)
    assert not any(c in " ".join(paths) for c in converted)


def test_l1_l2_same_key(docx, calls):
    sp = os.path.normcase(str(docx.resolve()))
    st = docx.stat()
    key = (sp, st.st_size, st.st_mtime_ns, kb.EXTRACTOR_VERSION)
    first = kb.extract_document(docx)
    assert list(kb._l1) == [key]                       # L1 用完整键
    r = rows()[0]
    assert (r["source_path"], r["size"], r["mtime_ns"], r["extractor_version"]) == key   # L2 同一套键
    assert r["md_name"] == kb._md_name(sp) and docx.name not in r["md_name"]
    l1 = kb.extract_document(docx)
    kb._l1.clear()
    l2 = kb.extract_document(docx)
    assert l1["text"] == l2["text"] == first["text"] and l1["status"] == l2["status"] == "ok"
    assert len(calls) == 1 and list(kb._l1) == [key]   # L2 命中会回填 L1
    # 路径写法不同（相对段/多余分隔符）也落到同一个键
    sloppy = docx.parent / "." / docx.name
    kb.extract_document(sloppy)
    assert len(calls) == 1 and len(rows()) == 1


def test_prune_respects_last_run(monkeypatch):
    ran = []
    monkeypatch.setattr(kb, "prune_doc_cache", lambda *a, **k: ran.append(1) or {})
    now = time.time()
    store.set_setting(kb.PRUNE_KEY, now - 6 * 86400)
    assert kb.maybe_prune(now) is False and ran == []
    store.set_setting(kb.PRUNE_KEY, now - 8 * 86400)
    assert kb.maybe_prune(now) is True and ran == [1]
    assert kb.maybe_prune(now + 60) is False and ran == [1]     # 刚清理过，不重复


def test_prune_uses_store_db(docx, monkeypatch):
    kb.extract_document(docx)
    assert not hasattr(kb, "_db_lock")                       # 清理没有自己的锁
    seen = []
    real = kb.db
    monkeypatch.setattr(kb, "db", lambda *a, **k: seen.append(a[0]) or real(*a, **k))
    out = {}
    t = threading.Thread(target=lambda: out.update(kb.prune_doc_cache(max_bytes=0)), daemon=True)
    t.start()
    t.join(10)
    assert not t.is_alive(), "prune 死锁了"
    assert seen and out["removed_rows"] == 1 and rows() == [] and cache_files() == []


def test_prune_orders_by_used_and_removes_orphans(tmp_path):
    ps = [make_docx(tmp_path / f"d{i}.docx", f"内容{i}" * 50) for i in range(3)]
    for p in ps:
        kb.extract_document(p)
    for i, p in enumerate(ps):   # d0 最旧
        store.db("UPDATE doc_cache SET used=? WHERE source_path=?", (1000 + i, os.path.normcase(str(p.resolve()))))
    orphan = kb.DOC_CACHE_DIR / ("f" * 32 + ".md")
    orphan.write_text("孤儿", encoding="utf-8")
    os.utime(orphan, (1, 1))
    gone = rows()[2]
    (kb.DOC_CACHE_DIR / gone["md_name"]).unlink()            # 索引在、文件丢了
    r = kb.prune_doc_cache(max_bytes=1 << 30)
    assert r["removed_orphans"] == 1 and r["removed_rows"] == 1 and not orphan.exists()
    assert len(rows()) == 2
    keep = sum(x["bytes"] for x in rows()) - 1
    kb.prune_doc_cache(max_bytes=keep)                        # 超量：先删 used 最旧的
    left = rows()
    assert len(left) == 1 and kb.DOC_CACHE_DIR.joinpath(left[0]["md_name"]).is_file()
    assert store.get_setting(kb.PRUNE_KEY) > 0


def test_index_failure_deletes_new_md(docx, monkeypatch):
    real = kb.db

    def flaky(sql, *a, **k):
        if sql.lstrip().startswith("INSERT INTO doc_cache"):
            raise RuntimeError("disk full")
        return real(sql, *a, **k)
    monkeypatch.setattr(kb, "db", flaky)
    d = kb.extract_document(docx)                              # 不抛、仍返回正文
    assert "第一段" in d["text"] and d["cached"] is False
    assert cache_files() == [] and rows() == []


def test_hit_checks_size_and_counts_hits(docx, calls):
    kb.extract_document(docx)
    kb._l1.clear()
    assert kb.extract_document(docx)["cached"] is True
    kb._l1.clear()
    assert kb.extract_document(docx)["cached"] is True
    assert rows()[0]["hits"] == 2
    # MD 被改动、大小对不上：未命中，重新提取并修复
    md = kb.DOC_CACHE_DIR / rows()[0]["md_name"]
    md.write_text(md.read_text(encoding="utf-8") + "被篡改", encoding="utf-8")
    kb._l1.clear()
    d = kb.extract_document(docx)
    assert d["cached"] is False and len(calls) == 2 and "被篡改" not in d["text"]
    assert rows()[0]["bytes"] == md.stat().st_size


def _session_for(make_user):
    u = make_user("alice")
    sid = client.post("/api/sessions", json={"title": "t"}, headers=u["headers"]).json()["id"]
    return u, sid


def _doc(sid, path, offset=0):
    r = client.post("/api/internal/kb/doc", headers=INTERNAL, json={"session_id": sid, "path": str(path), "offset": offset})
    assert r.status_code == 200, r.text
    return r.json()


def _read_document(monkeypatch, sid, path, offset=0):
    """用真实的 internal_doc 结果驱动 approval_mcp.read_document（只替换 HTTP 调用）。"""
    import asyncio
    monkeypatch.setenv("CENTER_URL", "http://x")
    monkeypatch.setenv("CENTER_TOKEN", "t")
    monkeypatch.setenv("CENTER_SESSION", sid)
    import approval_mcp

    async def fake_post(_path, body, timeout=60):
        return _doc(sid, body["path"], body["offset"])
    monkeypatch.setattr(approval_mcp, "_post", fake_post)
    return asyncio.run(approval_mcp.read_document(str(path), offset))


def test_scan_hint_not_in_pagination(tmp_path, make_user, monkeypatch):
    _, sid = _session_for(make_user)
    p = store.FILE_ROOT / "scan2.pdf"
    make_blank_pdf(p, pages=3)
    try:
        d = _doc(sid, p)
        assert d["status"] == "scan" and d["cached"] is False
        assert "扫描件" not in d["text"] and d["total"] == len(d["text"]) == d["chars"]
        assert d["end"] == len(d["text"]) and d["more"] is False
        assert _doc(sid, p)["cached"] is True
        # 分页：total/offset 只算正文
        part = _doc(sid, p, offset=5)
        assert part["start"] == 5 and part["total"] == d["total"] and part["text"] == d["text"][5:]
        # read_document：首段带提示，翻页不重复
        first = _read_document(monkeypatch, sid, p)
        assert first.startswith(d["text"]) and "扫描件" in first and f"共 {d['total']} 字" in first
        later = _read_document(monkeypatch, sid, p, offset=5)
        assert "扫描件" not in later and later.startswith(d["text"][5:])
    finally:
        p.unlink(missing_ok=True)


def test_read_document_hints_by_status(make_user, monkeypatch):
    _, sid = _session_for(make_user)
    e = store.FILE_ROOT / "e.txt"
    e.write_text("", encoding="utf-8")
    ok = make_docx(store.FILE_ROOT / "ok.docx", "正常内容")
    try:
        assert "没有文字" in _read_document(monkeypatch, sid, e)
        t = _read_document(monkeypatch, sid, ok)
        assert t == "正常内容" and "扫描件" not in t
        # 失败：原样给原因，且说明没被缓存
        monkeypatch.setattr(kb, "_pdf", lambda _p: (_ for _ in ()).throw(kb.HTTPException(400, "没装 pypdf")))
        bad = store.FILE_ROOT / "bad.pdf"
        bad.write_bytes(b"%PDF")
        try:
            msg = _read_document(monkeypatch, sid, bad)
        finally:
            bad.unlink(missing_ok=True)
        assert "读不了" in msg and "没装 pypdf" in msg
    finally:
        e.unlink(missing_ok=True)
        ok.unlink(missing_ok=True)


def test_deny_rules_blocks_doc_cache(make_user):
    u = make_user("bob")
    row = store.db("SELECT * FROM users WHERE id=?", (u["id"],), one=True)
    rules = runner._deny_rules(row)
    pat = store.posix_rule_path(kb.DOC_CACHE_DIR) + "/**"
    for tool in ("Read", "Edit", "Write"):
        assert f"{tool}({pat})" in rules
    assert kb.DOC_CACHE_DIR.parent == store.DATA   # 缓存目录跟着 PROJECTOR_DATA 走


def test_admin_endpoints(docx, make_user):
    admin, user = make_user("boss", role="admin"), make_user("carol")
    for path, method in (("/api/admin/doc-cache", "get"), ("/api/admin/doc-cache/prune", "post")):
        assert getattr(client, method)(path).status_code == 401
        assert getattr(client, method)(path, headers=user["headers"]).status_code == 403
    r = client.get("/api/admin/doc-cache", headers=admin["headers"]).json()
    assert r["count"] == 0 and r["bytes"] == 0 and r["hits"] == 0
    kb.extract_document(docx)
    kb._l1.clear()
    kb.extract_document(docx)
    r = client.get("/api/admin/doc-cache", headers=admin["headers"]).json()
    assert r["count"] == 1 and r["bytes"] > 0 and r["hits"] == 1 and r["last_used"] and r["by_status"] == {"ok": 1}
    p = client.post("/api/admin/doc-cache/prune", headers=admin["headers"])
    assert p.status_code == 200 and p.json()["removed_rows"] == 0 and p.json()["total_bytes"] == r["bytes"]
