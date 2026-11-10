"""按用户统计 token 用量：采集（record_turn）和聚合接口。

不 import server，避免循环导入；server.py 在 _drive() 里调用 record_turn，并挂载本文件的 router。
"""
import calendar
import time
import traceback
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

import store
from store import current_user, db, db_many, require_admin

router = APIRouter()

SOURCE_COLS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd")


# ---------- 归一化 ----------

def _int(v):
    if v is None or isinstance(v, bool):
        return 0
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _num(v):
    """费用：None 保持 None，0 保持 0.0（不能用 or 丢掉）。"""
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def normalize_usage(final: dict) -> list[dict]:
    """把 Claude Code 的 result 事件拆成按模型的用量行。

    有 modelUsage 时只按模型拆行，费用只取各模型的 costUSD，不叠加 total_cost_usd；
    没有 modelUsage、但有 usage 时，才退化成单行。thinkingTokens 已含在 outputTokens 里，不再另加。
    """
    final = final or {}
    models = final.get("modelUsage") or {}
    rows = []
    if models and isinstance(models, dict):
        for model, u in models.items():
            if not isinstance(u, dict):
                continue
            rows.append({
                "model": model or "unknown",
                "input_tokens": _int(u.get("inputTokens", u.get("input_tokens"))),
                "output_tokens": _int(u.get("outputTokens", u.get("output_tokens"))),
                "cache_read_tokens": _int(u.get("cacheReadInputTokens", u.get("cache_read_input_tokens"))),
                "cache_write_tokens": _int(u.get("cacheCreationInputTokens", u.get("cache_creation_input_tokens"))),
                "cost_usd": _num(u.get("costUSD", u.get("cost_usd"))),
            })
    else:
        usage = final.get("usage")
        if usage and isinstance(usage, dict):
            cost = final.get("total_cost_usd")
            if cost is None:
                cost = final.get("totalCostUSD")
            rows.append({
                "model": final.get("model") or "unknown",
                "input_tokens": _int(usage.get("input_tokens")),
                "output_tokens": _int(usage.get("output_tokens")),
                "cache_read_tokens": _int(usage.get("cache_read_input_tokens")),
                "cache_write_tokens": _int(usage.get("cache_creation_input_tokens")),
                "cost_usd": _num(cost),
            })
    return [r for r in rows if any(r[k] for k in SOURCE_COLS)]


# ---------- 采集 ----------

def log_failure(sid, where: str) -> None:
    """写 DATA/logs/usage.log；自己吞掉所有异常。"""
    try:
        logs = store.DATA / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        with open(logs / "usage.log", "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] session={sid} where={where}\n{traceback.format_exc()}\n")
    except Exception:
        pass


_INSERT = ("INSERT INTO usage_turns (session_id, user_id, message_id, model, input_tokens, output_tokens, "
           "cache_read_tokens, cache_write_tokens, cost_usd, created, source) "
           "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id, model) DO NOTHING")


def record_turn(session_id, user_id, message_id, final: dict) -> int:
    """把本轮用量写入 usage_turns，返回实际写入的行数。绝不向外抛异常。"""
    try:
        rows = normalize_usage(final)
        if not rows:
            return 0
        now = time.time()
        source = "error" if (final or {}).get("is_error") else "result"
        args = [(session_id, user_id, message_id, r["model"], r["input_tokens"], r["output_tokens"],
                 r["cache_read_tokens"], r["cache_write_tokens"], r["cost_usd"], now, source) for r in rows]
        return db_many(_INSERT, args)
    except Exception:
        log_failure(session_id, "record_turn")
        return 0


# ---------- 聚合 ----------

def _parse_day(s: str) -> date:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise HTTPException(400, f"日期格式不对或日期不存在：{s}，应为 YYYY-MM-DD")


def _month_range(today: date) -> tuple[date, date]:
    first = today.replace(day=1)
    last = today.replace(day=calendar.monthrange(today.year, today.month)[1])
    return first, last


def _resolve_range(date_from: str, date_to: str, all_time: bool):
    """返回 (from, to) 或 (None, None)（全部）。all=True 时忽略 from/to。"""
    if all_time:
        return None, None
    if not date_from and not date_to:
        return _month_range(date.today())
    if not date_from or not date_to:
        raise HTTPException(400, "from 和 to 必须同时提供")
    d1, d2 = _parse_day(date_from), _parse_day(date_to)
    if d1 > d2:
        raise HTTPException(400, "from 不能晚于 to")
    if (d2 - d1).days + 1 > 366:
        raise HTTPException(400, "自定义区间最多 366 天")
    return d1, d2


DAY = "date(created, 'unixepoch', 'localtime')"
AGG = ("COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, "
       "COALESCE(SUM(cache_read_tokens),0) AS cache_read, COALESCE(SUM(cache_write_tokens),0) AS cache_write, "
       "SUM(cost_usd) AS cost, COUNT(DISTINCT message_id) AS turns")


def usage_summary(user_id, date_from: str = "", date_to: str = "", all_time: bool = False, by_user: bool = False) -> dict:
    d1, d2 = _resolve_range(date_from, date_to, all_time)
    where, args = [], []
    if user_id is not None:
        where.append("user_id=?")
        args.append(user_id)
    if d1:
        where.append(f"{DAY} BETWEEN ? AND ?")
        args += [d1.isoformat(), d2.isoformat()]
    w = ("WHERE " + " AND ".join(where)) if where else ""

    # has_data 与查询区间无关：看这个范围（个人/全库）有没有采集过
    if user_id is not None:
        has = db("SELECT 1 AS x FROM usage_turns WHERE user_id=? LIMIT 1", (user_id,), one=True)
    else:
        has = db("SELECT 1 AS x FROM usage_turns LIMIT 1", one=True)

    total = db(f"SELECT {AGG} FROM usage_turns {w}", args, one=True)

    daily_sql = f"SELECT {DAY} AS date, {AGG} FROM usage_turns {w} GROUP BY date ORDER BY date DESC"
    if all_time:
        daily_sql += " LIMIT 366"
    daily = sorted(db(daily_sql, args), key=lambda r: r["date"])

    by_model = db(f"SELECT model, {AGG} FROM usage_turns {w} GROUP BY model ORDER BY output DESC, model", args)

    out = {
        "range": {"from": d1.isoformat() if d1 else "", "to": d2.isoformat() if d2 else "", "all": bool(all_time)},
        "has_data": bool(has),
        "total": total,
        "daily": daily,
        "by_model": by_model,
    }
    if by_user:
        out["by_user"] = db(
            "SELECT t.user_id AS user_id, COALESCE(u.display_name, '') AS display_name, "
            "COALESCE(SUM(t.input_tokens),0) AS input, COALESCE(SUM(t.output_tokens),0) AS output, "
            "COALESCE(SUM(t.cache_read_tokens),0) AS cache_read, COALESCE(SUM(t.cache_write_tokens),0) AS cache_write, "
            "SUM(t.cost_usd) AS cost, COUNT(DISTINCT t.message_id) AS turns "
            f"FROM (SELECT * FROM usage_turns {w}) t LEFT JOIN users u ON u.id=t.user_id "
            "GROUP BY t.user_id ORDER BY output DESC, t.user_id", args)
    return out


def recent_turns(user_id: int, limit: int = 20) -> list[dict]:
    """按 message_id 聚合成“轮”，最新的在前。"""
    rows = db(
        "SELECT t.message_id AS message_id, t.session_id AS session_id, "
        "COALESCE(s.title,'') AS session_title, MAX(t.created) AS created, "
        "GROUP_CONCAT(t.model, char(10)) AS models, "
        "COALESCE(SUM(t.input_tokens),0) AS input, COALESCE(SUM(t.output_tokens),0) AS output, "
        "COALESCE(SUM(t.cache_read_tokens),0) AS cache_read, COALESCE(SUM(t.cache_write_tokens),0) AS cache_write, "
        "SUM(t.cost_usd) AS cost "
        "FROM usage_turns t LEFT JOIN sessions s ON s.id=t.session_id "
        "WHERE t.user_id=? GROUP BY t.message_id ORDER BY created DESC, t.message_id DESC LIMIT ?",
        (user_id, limit))
    for r in rows:
        r["models"] = sorted(set(m for m in (r["models"] or "").split("\n") if m))
        r["preview"] = _preview(r["session_id"], r["message_id"])
    return rows


def _preview(session_id: str, message_id: int) -> str:
    """取这条助手消息之前最近的用户消息（跳过“已同意”之类的 event）；没有再退回助手/错误消息本身。"""
    row = db("SELECT content FROM messages WHERE session_id=? AND id<? AND role='user' ORDER BY id DESC LIMIT 1",
             (session_id, message_id), one=True)
    if not row:
        row = db("SELECT content FROM messages WHERE id=? AND role IN ('assistant','error')", (message_id,), one=True)
    return ((row or {}).get("content") or "")[:80]


# ---------- 路由 ----------

@router.get("/api/usage/me")
def my_usage(from_: str = Query("", alias="from"), to: str = "", all: bool = False,
             user: dict = Depends(current_user)):
    return usage_summary(user_id=user["id"], date_from=from_, date_to=to, all_time=all)


@router.get("/api/admin/usage")
def all_usage(from_: str = Query("", alias="from"), to: str = "", all: bool = False,
              admin: dict = Depends(require_admin)):
    return usage_summary(user_id=None, date_from=from_, date_to=to, all_time=all, by_user=True)


@router.get("/api/usage/me/turns")
def my_turns(limit: int = 20, user_id: int | None = None, user: dict = Depends(current_user)):
    # 个人接口永远只看自己；多传 user_id 直接 400，不静默忽略
    if user_id is not None:
        raise HTTPException(400, "个人用量接口不能指定 user_id")
    return recent_turns(user_id=user["id"], limit=max(1, min(limit, 100)))


@router.get("/api/admin/usage/turns")
def admin_turns(user_id: int, limit: int = 20, admin: dict = Depends(require_admin)):
    return recent_turns(user_id=user_id, limit=max(1, min(limit, 100)))
