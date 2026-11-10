"""事件推送（SSE）和消息写入：订阅者登记、broadcast、add_message、push_session，以及 /api/events。
最底层的一块（只依赖 store）：runner、approvals、sessions_api 都从这里取 broadcast / add_message / push_session。
"""
import asyncio
import json
import secrets
import threading
import time
from collections import deque

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from store import _db, _db_lock, current_user, db, is_admin, jdump

router = APIRouter()


# ---------- 事件推送（SSE）：每个人只收到自己会话的事件，管理员收到所有人的 ----------
#
# 序号与断线重连：
# - 每个事件在 broadcast 里领一个进程内单调递增的 seq，SSE 帧的 id 是 "<BOOT>-<seq>"（BOOT 每次进程启动随机生成）。
# - 最近的事件放进内存环形缓冲（条数和时间都有上限），连接带着 Last-Event-ID 回来时，把错过的、且这个人有权看的事件按顺序补发。
# - 线程安全：broadcast 可能在事件循环线程（runner 的 call_soon_threadsafe）里调，也可能在线程池里（同步接口的 add_message）调，
#   所以“领序号 + 入缓冲 + 投递给订阅者”整体放在同一把 lock 里；订阅（登记队列 + 取补发列表）也在这把锁里。
#   这样每个事件要么在订阅前已进缓冲（走补发），要么在订阅后才广播（走队列），不会漏也不会重。
#   投递一律用 loop.call_soon_threadsafe(q.put_nowait, …)，在锁内按 seq 顺序排进事件循环，队列里的顺序就是 seq 顺序。

BOOT = secrets.token_hex(4)
RING_MAX = 3000        # 缓冲最多保留的事件数
RING_TTL = 300         # 缓冲里超过这么多秒的事件丢弃
lock = threading.RLock()   # 可重入：runner 里“改状态 + broadcast”也要持这把锁
_seq = 0
_ring: deque = deque()      # 元素 (seq, 时间, owner_id, 事件)；owner_id 就是 broadcast 的接收规则
_subscribers: dict[asyncio.Queue, tuple[dict, asyncio.AbstractEventLoop]] = {}


def entitled(user: dict, owner_id) -> bool:
    """这个人能不能收到 owner_id 名下的事件。实时投递和断线补发共用这一条规则。"""
    return owner_id is None or is_admin(user) or user["id"] == owner_id


def _trim(now: float) -> None:
    while _ring and (len(_ring) > RING_MAX or now - _ring[0][1] > RING_TTL):
        _ring.popleft()


def current_seq() -> int:
    with lock:
        return _seq


def broadcast(event: dict, owner_id) -> int:
    global _seq
    with lock:
        _seq += 1
        ev = {**event, "seq": _seq}
        now = time.time()
        _ring.append((_seq, now, owner_id, ev))
        _trim(now)
        for q, (u, loop) in list(_subscribers.items()):
            if entitled(u, owner_id):
                try:
                    loop.call_soon_threadsafe(q.put_nowait, ev)
                except RuntimeError:   # 事件循环已关闭：这个订阅者已经没人读了
                    _subscribers.pop(q, None)
        return _seq


def event_id(seq: int) -> str:
    return f"{BOOT}-{seq}"


def parse_event_id(raw) -> tuple[str, int] | None:
    try:
        boot, _, n = str(raw or "").strip().rpartition("-")
        return (boot, int(n)) if boot and int(n) >= 0 else None
    except ValueError:
        return None


def replay_since(user: dict, raw_id, now: float | None = None) -> list[dict] | None:
    """某人带着 raw_id 回来时该补发的事件（按 seq 顺序）；补不了（别的进程、缓冲已丢了他错过的部分、id 无效）返回 None，调用方发 resync。
    必须在持有 lock 时调用，才能和订阅登记保持原子。"""
    parsed = parse_event_id(raw_id)
    if not parsed or parsed[0] != BOOT or parsed[1] > _seq:
        return None
    last = parsed[1]
    _trim(now if now is not None else time.time())
    if last == _seq:
        return []
    if not _ring or last < _ring[0][0] - 1:   # 他错过的第一个事件已经被挤出缓冲
        return None
    return [ev for seq, _, owner, ev in _ring if seq > last and entitled(user, owner)]


def subscribe(user: dict, loop: asyncio.AbstractEventLoop, raw_id="") -> tuple[asyncio.Queue, list[dict] | None, int]:
    """登记订阅并（如果带了 id）取补发列表，两步在同一把锁里。返回 (队列, 补发列表或 None=需要 resync, 此刻的 seq)。
    没带 id 的首次连接：补发列表是 []，不发 resync（客户端自己拉一次全量）。"""
    q: asyncio.Queue = asyncio.Queue()
    with lock:
        replay = replay_since(user, raw_id) if raw_id else []
        _subscribers[q] = (user, loop)
        return q, replay, _seq


def unsubscribe(q: asyncio.Queue) -> None:
    with lock:
        _subscribers.pop(q, None)


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


def _frame(ev: dict) -> str:
    return f"id: {event_id(ev['seq'])}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"


@router.get("/api/events")
async def events(request: Request, last_id: str = "", user: dict = Depends(current_user)):
    """SSE。Last-Event-ID（EventSource 自动重连时浏览器自带）或 ?last_id=（手动重连）能对上就补发错过的事件；
    对不上（进程重启过、缓冲里已经没有了）先发一个 {"type":"resync"}，客户端据此重新拉全量。"""
    raw = request.headers.get("last-event-id") or last_id
    q, replay, now_seq = subscribe(user, asyncio.get_running_loop(), raw)

    async def stream():
        try:
            yield ": connected\n\n"
            # 只有 id、没有 data 的帧不会触发 onmessage，但浏览器会记住这个 id：之后断线重连带的就是它（哪怕还没收到过任何事件）
            yield f"id: {event_id(now_seq)}\n\n"
            last_sent = 0
            if replay is None:
                yield f"id: {event_id(now_seq)}\ndata: {json.dumps({'type': 'resync'})}\n\n"
                last_sent = now_seq   # 订阅之前的事件都不用再发了，客户端会重新拉全量
            for ev in replay or []:
                yield _frame(ev)
                last_sent = ev["seq"]
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(q.get(), 15)
                    if ev["seq"] > last_sent:
                        last_sent = ev["seq"]
                        yield _frame(ev)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
