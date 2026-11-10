"""事件推送（SSE）和消息写入：订阅者登记、broadcast、add_message、push_session，以及 /api/events。
最底层的一块（只依赖 store）：runner、approvals、sessions_api 都从这里取 broadcast / add_message / push_session。
"""
import asyncio
import json
import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from store import _db, _db_lock, current_user, db, is_admin, jdump

router = APIRouter()


# ---------- 事件推送（SSE）：每个人只收到自己会话的事件，管理员收到所有人的 ----------

_subscribers: dict[asyncio.Queue, dict] = {}


def broadcast(event: dict, owner_id) -> None:
    for q, u in list(_subscribers.items()):
        if owner_id is None or is_admin(u) or u["id"] == owner_id:
            q.put_nowait(event)


def push_session(sid: str) -> None:
    # 晚导入：session_view 在 sessions_api，而 sessions_api 要用本文件的 broadcast（循环依赖），所以只能在调用时再取
    from sessions_api import session_view
    s = db("SELECT * FROM sessions WHERE id=?", (sid,), one=True)
    if s:
        broadcast({"type": "session", "session": session_view(s)}, s["user_id"])


def add_message(sid: str, role: str, content: str, meta: dict | None = None) -> dict:
    now = time.time()
    # INSERT、UPDATE、按 lastrowid 取回在同一把锁里完成，避免并发的 event 消息插队导致取错 id。
    # 持锁期间不能再调用 db() / push_session() / session_view()（_db_lock 不可重入）。
    with _db_lock:
        try:
            cur = _db.execute("INSERT INTO messages (session_id, role, content, meta, created) VALUES (?,?,?,?,?)",
                              (sid, role, content, jdump(meta or {}), now))
            mid = cur.lastrowid
            _db.execute("UPDATE sessions SET updated=? WHERE id=?", (now, sid))
            _db.commit()
        except Exception:
            _db.rollback()
            raise
        row = _db.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        msg = dict(row)
    msg["meta"] = json.loads(msg["meta"])
    owner = (db("SELECT user_id FROM sessions WHERE id=?", (sid,), one=True) or {}).get("user_id")
    broadcast({"type": "message", "session_id": sid, "message": msg}, owner)
    push_session(sid)
    return msg


@router.get("/api/events")
async def events(request: Request, user: dict = Depends(current_user)):
    q: asyncio.Queue = asyncio.Queue()
    _subscribers[q] = user

    async def stream():
        try:
            yield ": connected\n\n"
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(q.get(), 15)
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            _subscribers.pop(q, None)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
