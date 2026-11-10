"""分区（团队统一分类）：增删改查、归档与恢复、权限。

分区是组织和检索维度，不是权限边界。会话用 sessions.section_id 归区，知识库笔记用 frontmatter 的 section（存分区名）。
顶层只 import store，不 import kb（kb 要 import 本文件）；统计笔记数和改名时在函数内延迟 import kb。
"""
import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from store import current_user, db, db_insert, db_many, is_admin, require_admin

router = APIRouter()

UNCATEGORIZED = "__uncategorized__"   # API 保留值：知识库筛选“未分类”，不能当分区名
MAX_NAME = 40


# ---------- 查询和校验（server.py、kb.py 复用） ----------

def get_section(section_id) -> dict | None:
    if section_id in (None, "", 0):
        return None
    try:
        return db("SELECT * FROM sections WHERE id=?", (int(section_id),), one=True)
    except (TypeError, ValueError):
        return None


def section_name(section_id, include_archived: bool = True) -> str:
    """分区名；没有分区、查不到返回空串。老会话/老笔记显示已归档分区的名字时 include_archived 必须为 True。"""
    row = get_section(section_id)
    if not row or (row["archived"] and not include_archived):
        return ""
    return row["name"]


def require_active(section_id) -> dict:
    """分区必须存在且未归档，否则 400；返回数据库里的那一行。"""
    row = get_section(section_id)
    if not row:
        raise HTTPException(400, "分区不存在")
    if row["archived"]:
        raise HTTPException(400, f"分区“{row['name']}”已下架，请换一个")
    return row


def require_active_name(name: str, current: str = "") -> str:
    """按名字校验分区；返回数据库里的名字原文（NOCASE 下传 hr、库里是 HR 时返回 HR）。
    current 与该分区名相同则放行（笔记原来就在这个已归档分区里，改别的字段不该被连带拒绝）。"""
    name = (name or "").strip()
    row = db("SELECT * FROM sections WHERE name=?", (name,), one=True)
    if not row:
        raise HTTPException(400, f"没有“{name}”这个分区")
    if row["archived"] and row["name"] != (current or ""):
        raise HTTPException(400, f"分区“{row['name']}”已下架，请换一个")
    return row["name"]


def active_name_for_session(sess: dict | None) -> str:
    """会话的未归档分区名；会话没有分区或分区已归档时返回空串（Claude 写笔记时用它补空分区）。"""
    if not sess:
        return ""
    return section_name(sess.get("section_id"), include_archived=False)


def is_active(section_id) -> bool:
    row = get_section(section_id)
    return bool(row) and not row["archived"]


def clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "分区名不能为空")
    if name == UNCATEGORIZED:
        raise HTTPException(400, f"“{UNCATEGORIZED}”是保留值，不能当分区名")
    if len(name) > MAX_NAME:
        raise HTTPException(400, f"分区名最多 {MAX_NAME} 个字")
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise HTTPException(400, "分区名里不能有换行等控制字符")
    return name


def duplicate_error(name: str, exclude_id: int | None = None) -> HTTPException | None:
    """重名（含已归档）返回 409 异常对象，没重名返回 None。"""
    row = db("SELECT id, name, archived FROM sections WHERE name=? AND id<>?", (name, exclude_id or -1), one=True)
    if not row:
        return None
    if row["archived"]:
        return HTTPException(409, f"分区“{row['name']}”已归档，请先恢复它，不能重名新建")
    return HTTPException(409, f"已经有叫“{row['name']}”的分区了")


def _public(row: dict) -> dict:
    return {k: row[k] for k in ("id", "name", "color", "sort", "archived", "created")}


def list_sections(user: dict, include_archived: bool = False) -> list[dict]:
    """未归档分区（管理员传 include_archived 时连归档的一起）+ 会话数、笔记数。
    普通用户的 session_count 只数自己的会话；管理员数全团队；note_count 数全团队笔记。"""
    show_archived = include_archived and is_admin(user)
    rows = db("SELECT * FROM sections" + ("" if show_archived else " WHERE archived=0") +
              " ORDER BY archived, sort, id")
    if is_admin(user):
        counts = db("SELECT section_id, COUNT(*) AS c FROM sessions WHERE section_id IS NOT NULL GROUP BY section_id")
    else:
        counts = db("SELECT section_id, COUNT(*) AS c FROM sessions WHERE section_id IS NOT NULL AND user_id=? "
                    "GROUP BY section_id", (user["id"],))
    sess_n = {r["section_id"]: r["c"] for r in counts}
    import kb   # 延迟 import，避免循环
    note_n: dict[str, int] = {}
    for n in kb.index().notes.values():
        if n["section"]:
            note_n[n["section"]] = note_n.get(n["section"], 0) + 1
    return [{**_public(r), "session_count": sess_n.get(r["id"], 0), "note_count": note_n.get(r["name"], 0)}
            for r in rows]


# ---------- 接口 ----------

class SectionCreate(BaseModel):
    name: str
    color: str = ""
    sort: int | None = None


class SectionPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    sort: int | None = None
    archived: bool | None = None


class Reorder(BaseModel):
    ids: list[int]


@router.get("/api/sections")
def api_list(include_archived: bool = False, user: dict = Depends(current_user)):
    return list_sections(user, include_archived)


@router.post("/api/sections")
def api_create(body: SectionCreate, admin: dict = Depends(require_admin)):
    name = clean_name(body.name)
    if err := duplicate_error(name):
        raise err
    sort = body.sort
    if sort is None:
        sort = (db("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM sections", one=True) or {"n": 1})["n"]
    try:
        sid = db_insert("INSERT INTO sections (name, color, sort, archived, created) VALUES (?,?,?,0,?)",
                        (name, (body.color or "").strip()[:20], sort, time.time()))
    except sqlite3.IntegrityError:   # 并发下两个人同时建同名分区
        raise duplicate_error(name) or HTTPException(409, "分区名重复")
    return _public(get_section(sid))


@router.post("/api/sections/reorder")
def api_reorder(body: Reorder, admin: dict = Depends(require_admin)):
    ids = list(dict.fromkeys(body.ids))
    known = {r["id"] for r in db("SELECT id FROM sections")}
    if any(i not in known for i in ids):
        raise HTTPException(400, "排序里有不存在的分区")
    db_many("UPDATE sections SET sort=? WHERE id=?", [(n, i) for n, i in enumerate(ids, 1)])
    return {"ok": True}


@router.patch("/api/sections/{section_id}")
def api_update(section_id: int, body: SectionPatch, admin: dict = Depends(require_admin)):
    row = get_section(section_id)
    if not row:
        raise HTTPException(404, "分区不存在")
    name = clean_name(body.name) if body.name is not None else None
    if name is not None and name != row["name"]:
        # 重名预检、sections.name 更新和笔记文件修改整体交给 kb.rename_section（失败会整体回滚）
        import kb
        kb.rename_section(section_id, row["name"], name, admin)
    sets, args = [], []
    if body.color is not None:
        sets.append("color=?")
        args.append(body.color.strip()[:20])
    if body.sort is not None:
        sets.append("sort=?")
        args.append(body.sort)
    if body.archived is not None:
        sets.append("archived=?")
        args.append(int(body.archived))
    if sets:
        db(f"UPDATE sections SET {', '.join(sets)} WHERE id=?", (*args, section_id))
    return _public(get_section(section_id))
