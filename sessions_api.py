"""会话：列表/详情的视图拼装、新建、改名、删除、发消息、聊天记录。"""
import json
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import files_api
import sections
import skills_api
from approvals import approval_public, pending_for, questions_for
from events import broadcast, push_session
from runner import KB_ACTIONS, RUNS, submit_turn
from store import (CLAUDE_HOME, DATA, FILE_ROOT, avatar_of, can_bypass, current_user, db, get_user, require_admin,
                   session_for, session_workspace)

router = APIRouter()


# ---------- 会话 ----------

def session_stats(sids: list[str]) -> dict[str, dict]:
    """一次查询补齐一批会话的消息数、最后一轮结果、文件数、排队中的消息（列表里不能逐会话查库）。"""
    out = {sid: {"message_count": 0, "last": None, "file_count": 0, "queue": []} for sid in sids}
    for i in range(0, len(sids), 500):
        chunk = sids[i:i + 500]
        ph = ",".join("?" * len(chunk))
        for r in db(f"SELECT session_id, COUNT(*) AS c FROM messages WHERE session_id IN ({ph}) GROUP BY session_id", chunk):
            out[r["session_id"]]["message_count"] = r["c"]
        for r in db(f"SELECT m.session_id, m.role, m.meta FROM messages m WHERE m.session_id IN ({ph}) AND m.id IN "
                    "(SELECT MAX(id) FROM messages WHERE role IN ('assistant','error') GROUP BY session_id)", chunk):
            try:
                meta = json.loads(r["meta"] or "{}")
            except ValueError:
                meta = {}
            out[r["session_id"]]["last"] = {"role": r["role"], "meta": meta if isinstance(meta, dict) else {}}
        for r in db("SELECT q.id, q.session_id, q.text, q.created, u.display_name FROM turn_queue q "
                    f"LEFT JOIN users u ON u.id=q.author_id WHERE q.session_id IN ({ph}) ORDER BY q.created, q.id", chunk):
            out[r["session_id"]]["queue"].append({"id": r["id"], "text": r["text"],
                                                  "author_name": r["display_name"] or "", "created": r["created"]})
        for r in db(f"SELECT session_id, manifest FROM links WHERE session_id IN ({ph})", chunk):
            try:
                m = json.loads(r["manifest"] or "{}")
            except ValueError:
                m = {}
            out[r["session_id"]]["file_count"] += len(m) if isinstance(m, (dict, list)) else 0
    return out


def session_view(s: dict, stats: dict | None = None) -> dict:
    owner = get_user(s.get("user_id")) or {}
    st = stats if stats is not None else session_stats([s["id"]])[s["id"]]
    pending = len(pending_for(s["id"])) + len(questions_for(s["id"]))
    running = s["id"] in RUNS
    last = st["last"]
    if pending:
        status = "pending"
    elif running:
        status = "running"
    elif st["queue"]:
        status = "queued"   # 没在运行，但有消息在排队（等空位）
    elif not st["message_count"]:
        status = "idle"   # 还没发过消息；前端据此显示“未开始”
    elif last and (last["role"] == "error" or any(last["meta"].get(k) for k in ("stopped", "timed_out", "error"))):
        status = "stopped"
    else:
        status = "done"
    duration = (last["meta"].get("seconds") if last else None)
    if duration is None and s.get("created") and s.get("updated"):
        duration = max(0, round(s["updated"] - s["created"]))
    return {**s, "running": running, "pending": pending,
            "owner": owner.get("display_name", ""), "owner_avatar": avatar_of(owner) if owner else "orange",
            "work_dir": s.get("work_dir") or str(FILE_ROOT),
            "section_name": sections.section_name(s.get("section_id")),
            "section_archived": bool((sections.get_section(s.get("section_id")) or {}).get("archived")),
            "status": status, "duration_seconds": duration,
            "message_count": st["message_count"], "file_count": st["file_count"], "queue": st["queue"]}


def session_views(rows: list[dict]) -> list[dict]:
    stats = session_stats([r["id"] for r in rows])
    return [session_view(r, stats[r["id"]]) for r in rows]


def create_session(title: str, owner: dict, work_dir: str | None = None, section_id: int | None = None) -> dict:
    """section_id：None=用上次新建记住的分区（已不存在或已归档则未分类）；0=未分类（同时清掉记住的分区）；
    其他=必须存在且未归档，并记住。注意不能先把 0 收成 None，否则又回退到上次的分区。"""
    if section_id is None:
        last = (get_user(owner["id"]) or {}).get("last_section_id")
        sec = last if sections.is_active(last) else None
    elif section_id == 0:
        sec = None
        db("UPDATE users SET last_section_id=NULL WHERE id=?", (owner["id"],))
    else:
        sec = sections.require_active(section_id)["id"]
        db("UPDATE users SET last_section_id=? WHERE id=?", (sec, owner["id"]))
    now = time.time()
    sid = uuid.uuid4().hex[:12]
    db("INSERT INTO sessions (id, title, source, claude_session, created, updated, bypass, created_by, user_id, work_dir, "
       "section_id) VALUES (?,?,?,?,?,?,0,?,?,?,?)",
       (sid, title, "web", None, now, now, owner["display_name"], owner["id"], work_dir, sec))
    push_session(sid)
    return db("SELECT * FROM sessions WHERE id=?", (sid,), one=True)


class NewSession(BaseModel):
    title: str = "新会话"
    work_dir: str | None = None
    section_id: int | None = None   # 不传=用上次的分区；0=未分类


class UpdateSession(BaseModel):
    title: str | None = None
    bypass: bool | None = None
    work_dir: str | None = None
    section_id: int | None = None   # 不传（或 null）=不改；0=清空为未分类


class Send(BaseModel):
    text: str = ""
    refs: list[str] = []
    skill: str = ""
    action: str = ""   # distill 沉淀经验 / organize 整理进知识库


def _check_work_dir(path: str, user: dict) -> str:
    p = files_api.resolve_path(path, user)
    if not p.is_dir():
        raise HTTPException(400, "工作文件夹要选一个文件夹")
    return str(p)


def _owner_only(sess: dict, user: dict) -> None:
    if sess["user_id"] != user["id"]:
        raise HTTPException(403, "这是别人的会话，只能查看")


@router.get("/api/admin/sessions")
def admin_sessions(admin: dict = Depends(require_admin)):
    return session_views(db("SELECT * FROM sessions ORDER BY updated DESC"))


# ---------- 会话接口 ----------


@router.get("/api/sessions")
def list_sessions(section_id: int | None = None, user: dict = Depends(current_user)):
    # 判断必须用 is None / == 0：0 是假值，“未分类”不能被当成“全部”
    if section_id is None:
        rows = db("SELECT * FROM sessions WHERE user_id=? ORDER BY updated DESC", (user["id"],))
    elif section_id == 0:
        rows = db("SELECT * FROM sessions WHERE user_id=? AND section_id IS NULL ORDER BY updated DESC", (user["id"],))
    else:
        rows = db("SELECT * FROM sessions WHERE user_id=? AND section_id=? ORDER BY updated DESC", (user["id"], section_id))
    return session_views(rows)


@router.post("/api/sessions")
def new_session(body: NewSession, user: dict = Depends(current_user)):
    work_dir = _check_work_dir(body.work_dir, user) if body.work_dir else None
    return session_view(create_session(body.title.strip()[:40] or "新会话", user, work_dir, body.section_id))


@router.get("/api/sessions/{sid}")
def read_session(sid: str, user: dict = Depends(current_user)):
    s = session_for(sid, user)
    msgs = db("SELECT * FROM messages WHERE session_id=? ORDER BY id", (sid,))
    for m in msgs:
        m["meta"] = json.loads(m["meta"])
    run = RUNS.get(sid)
    live = {"text": run.text, "tools": run.tools} if run else None
    return {
        "session": session_view(s),
        "messages": msgs,
        "live": live,
        "approvals": [approval_public(a) for a in pending_for(sid)],
        "questions": [approval_public(q) for q in questions_for(sid)],
    }


@router.patch("/api/sessions/{sid}")
def update_session(sid: str, body: UpdateSession, user: dict = Depends(current_user)):
    s = session_for(sid, user)
    _owner_only(s, user)
    new_section = False
    if body.section_id is not None:   # 先校验，免得改了标题才发现分区不对
        if body.section_id == 0:
            new_section = None
        elif body.section_id == s.get("section_id"):
            new_section = False   # 没变（即使当前分区已归档）：放行，不动
        else:
            new_section = sections.require_active(body.section_id)["id"]
    if body.title is not None:
        db("UPDATE sessions SET title=? WHERE id=?", (body.title.strip()[:40] or "未命名", sid))
    if body.bypass is not None:
        if body.bypass and not can_bypass(user):
            raise HTTPException(403, "你没有“完全放行”的权限，请找管理员开通")
        db("UPDATE sessions SET bypass=? WHERE id=?", (int(body.bypass), sid))
    if body.work_dir is not None:
        if s["claude_session"]:
            raise HTTPException(409, "会话开始后不能换工作文件夹（Claude 的记忆跟着文件夹走），请新建一个会话")
        db("UPDATE sessions SET work_dir=? WHERE id=?", (_check_work_dir(body.work_dir, user), sid))
    if new_section is not False:   # PATCH 不改 users.last_section_id
        db("UPDATE sessions SET section_id=? WHERE id=?", (new_section, sid))
    push_session(sid)
    return session_view(session_for(sid, user))


@router.delete("/api/sessions/{sid}")
def delete_session(sid: str, user: dict = Depends(current_user)):
    s = session_for(sid, user)
    if sid in RUNS:
        raise HTTPException(409, "任务进行中，请先停止")
    db("DELETE FROM messages WHERE session_id=?", (sid,))
    db("DELETE FROM sessions WHERE id=?", (sid,))
    db("DELETE FROM links WHERE session_id=?", (sid,))
    db("DELETE FROM turn_queue WHERE session_id=?", (sid,))
    ws = session_workspace(s, create=False)
    if ws and ws.exists():
        files_api.move_to_trash(ws, user, f"删除会话 {s['title']}")
    for f in (f"{sid}.json", f"hint_{sid}.txt", f"settings_{sid}.json"):
        (DATA / "mcp" / f).unlink(missing_ok=True)
    broadcast({"type": "session_deleted", "session_id": sid}, s["user_id"])
    return {"ok": True}


@router.post("/api/sessions/{sid}/messages")
async def send_message(sid: str, body: Send, user: dict = Depends(current_user)):
    s = session_for(sid, user)
    _owner_only(s, user)
    if s.get("source") == "voice":
        raise HTTPException(400, "这是语音功能留下的历史记录，只能查看，不能继续对话；请新建会话")
    text = body.text.strip()
    refs = [str(files_api.resolve_path(r, user)) for r in body.refs[:30]]
    if body.action:
        if body.action not in KB_ACTIONS:
            raise HTTPException(400, "不支持的操作")
        if body.action == "organize" and not refs:
            raise HTTPException(400, "请先选要整理的文件或文件夹")
        if body.action == "distill" and not s["claude_session"]:
            raise HTTPException(400, "这个会话还没有内容可以沉淀")
        text = KB_ACTIONS[body.action][0].format(name="、".join(Path(r).name for r in refs[:3]) + ("等" if len(refs) > 3 else ""))
    if not text:
        raise HTTPException(400, "内容为空")
    skill = body.skill.strip()
    if skill and skill not in skills_api.user_skill_names(user):
        raise HTTPException(403, "你没有这个技能的使用权限")
    if s["title"] == "新会话":
        db("UPDATE sessions SET title=? WHERE id=?", (text[:20], sid))
    res = submit_turn(s, text, user, refs, skill, body.action)
    if res["queued"]:
        return {"queued": True, "queue_id": res["queue_id"], "position": res["position"]}
    return {"ok": True}


@router.get("/api/sessions/{sid}/transcript")
def transcript(sid: str, user: dict = Depends(current_user)):
    """读取 Claude Code 自己保存的完整记录（每一步思考、工具调用和返回）。"""
    s = session_for(sid, user)
    if not s["claude_session"]:
        return {"steps": [], "note": "这个会话还没有记录"}
    files = list((CLAUDE_HOME / "projects").glob(f"*/{s['claude_session']}.jsonl"))
    if not files:
        return {"steps": [], "note": "找不到 Claude Code 的记录文件"}
    steps = []
    with files[0].open(encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("type") not in ("user", "assistant") or e.get("isMeta"):
                continue
            content = e.get("message", {}).get("content")
            if isinstance(content, str):
                steps.append({"kind": e["type"], "text": content})
                continue
            for b in content or []:
                t = b.get("type")
                if t == "text":
                    steps.append({"kind": e["type"], "text": b.get("text", "")})
                elif t == "thinking" and b.get("thinking"):
                    steps.append({"kind": "thinking", "text": b["thinking"]})
                elif t == "tool_use":
                    steps.append({"kind": "tool_use", "name": b.get("name"),
                                  "text": json.dumps(b.get("input"), ensure_ascii=False, indent=1)})
                elif t == "tool_result":
                    c = b.get("content")
                    if isinstance(c, list):
                        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                    text = str(c or "")
                    steps.append({"kind": "tool_result", "error": bool(b.get("is_error")),
                                  "text": text[:3000] + ("……（已截断）" if len(text) > 3000 else "")})
    return {"steps": steps}
