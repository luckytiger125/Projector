"""定期清理：只增不减的东西在这里统一收拾。server.py 启动一分钟后跑第一次，之后每 6 小时一次。

每一项各管各的，一项出错只记日志（data/logs/usage.log），不影响别的项，也不影响服务。
  - 回收站里过了 30 天的文件（以前只在有人打开回收站页面时才清）
  - 过了空闲有效期的登录令牌
  - Office 转 PDF 的预览缓存：30 天没用过的删掉，总量超过 2 GB 时从最久没用的删起
  - 日志：已删除会话的 claude_<会话id>.log 删掉；单个日志超过 5 MB 时只留最后 1 MB
  - 文件操作记录：只留最近 5 万条
"""
import time
from pathlib import Path

import files_api
import store
import usage

PREVIEW_DAYS = 30
PREVIEW_MAX_BYTES = 2 * 1024 ** 3
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_KEEP_BYTES = 1024 * 1024
FILE_OPS_KEEP = 50000
FIRST_DELAY = 60
INTERVAL = 6 * 3600


def prune_preview(now: float | None = None, max_bytes: int = PREVIEW_MAX_BYTES) -> int:
    """预览缓存丢了没关系，下次预览会重新转。返回删掉的文件数。"""
    now = now if now is not None else time.time()
    cache = store.DATA / "preview"
    items = []
    for p in cache.glob("*.pdf"):
        try:
            st = p.stat()
            items.append((max(st.st_atime, st.st_mtime), st.st_size, p))
        except OSError:
            continue
    items.sort()   # 最久没用的在前
    total, removed = sum(size for _, size, _ in items), 0
    for used, size, p in items:
        if now - used <= PREVIEW_DAYS * 86400 and total <= max_bytes:
            break
        try:
            p.unlink()
            total -= size
            removed += 1
        except OSError:
            continue
    return removed


def _trim_log(p: Path) -> bool:
    """日志太大时原地只留最后一段（不换文件：别的进程可能正开着它往后追加）。"""
    if p.stat().st_size <= LOG_MAX_BYTES:
        return False
    with open(p, "r+b") as f:
        f.seek(-LOG_KEEP_BYTES, 2)
        tail = f.read()
        cut = tail.find(b"\n")   # 从完整的一行开始
        tail = tail[cut + 1:] if cut >= 0 else tail
        f.seek(0)
        f.write("（前面的日志太长，已清掉）\n".encode("utf-8") + tail)
        f.truncate()
    return True


def prune_logs(running: set[str] | None = None) -> dict:
    """running：正在运行的会话号，它们的日志这次不动。"""
    running = running or set()
    logs = store.DATA / "logs"
    alive = {r["id"] for r in store.db("SELECT id FROM sessions")}
    deleted = trimmed = 0
    for p in logs.glob("*.log"):
        try:
            sid = p.stem[len("claude_"):] if p.stem.startswith("claude_") else None
            if sid is not None and sid in running:
                continue
            if sid is not None and sid not in alive:
                p.unlink()
                deleted += 1
            elif _trim_log(p):
                trimmed += 1
        except OSError:
            continue   # 被别的程序占着：下次再说
    return {"deleted": deleted, "trimmed": trimmed}


def prune_file_ops(keep: int = FILE_OPS_KEEP) -> int:
    row = store.db("SELECT id FROM file_ops ORDER BY id DESC LIMIT 1 OFFSET ?", (keep,), one=True)
    if not row:
        return 0
    n = store.db("SELECT COUNT(*) AS c FROM file_ops WHERE id <= ?", (row["id"],), one=True)["c"]
    store.db("DELETE FROM file_ops WHERE id <= ?", (row["id"],))
    return n


def run_all(running: set[str] | None = None) -> dict:
    out = {}
    for name, job in (("trash", files_api.purge_trash), ("tokens", store.purge_tokens), ("preview", prune_preview),
                      ("logs", lambda: prune_logs(running)), ("file_ops", prune_file_ops)):
        try:
            out[name] = job()
        except Exception:
            usage.log_failure("-", f"housekeeping_{name}")
            out[name] = "出错"
    return out
