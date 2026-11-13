"""公共部分：配置、数据库、账号和登录校验。server.py 和各个 *_api.py、runner.py 都从这里取。"""
import glob
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
from pathlib import Path

from fastapi import Depends, HTTPException, Request

VERSION = "0.8.1"
BASE = Path(__file__).resolve().parent
# 测试时用环境变量 PROJECTOR_DATA 把数据目录指到临时位置，不碰真实的 data/
DATA = Path(os.environ["PROJECTOR_DATA"]).resolve() if os.environ.get("PROJECTOR_DATA") else BASE / "data"
for _d in ("mcp", "workspaces", "skills/library", "skills/submissions", "skills/versions", "plugins", "preview"):
    (DATA / _d).mkdir(parents=True, exist_ok=True)

WORK_DIR = os.environ.get("CLAUDE_WORK_DIR", "D:\\")
FILE_ROOT = Path(os.environ.get("FILES_ROOT") or WORK_DIR).resolve()
# 每个人的工作区放在文件库（D 盘）里，文件夹名一看就知道是谁的哪个会话：
#   D:\Projector工作区\张三(zhang)\2026-10-24 九月采购合同汇总\
OLD_WS = (DATA / "workspaces").resolve()
if os.environ.get("WORKSPACE_ROOT"):
    WS_ROOT = Path(os.environ["WORKSPACE_ROOT"])
elif FILE_ROOT.is_dir():
    WS_ROOT = FILE_ROOT / "Projector工作区"
else:
    WS_ROOT = OLD_WS
WS_ROOT.mkdir(parents=True, exist_ok=True)
WS_ROOT = WS_ROOT.resolve()
TRASH = WS_ROOT / "回收站"
# 团队知识库：一堆 Markdown 笔记（Obsidian 格式），默认放在 D:\知识库，大家都能看、Claude 帮忙维护
if os.environ.get("KB_ROOT"):
    KB_ROOT = Path(os.environ["KB_ROOT"])
elif FILE_ROOT.is_dir():
    KB_ROOT = FILE_ROOT / "知识库"
else:
    KB_ROOT = DATA / "kb"
KB_ROOT.mkdir(parents=True, exist_ok=True)
KB_ROOT = KB_ROOT.resolve()
TRASH_DAYS = 30
LIBRARY = (DATA / "skills" / "library").resolve()
SUBMISSIONS = (DATA / "skills" / "submissions").resolve()
VERSIONS = (DATA / "skills" / "versions").resolve()
CLAUDE_HOME = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
PORT = int(os.environ.get("CENTER_PORT", "8080"))
DISCOVERY_PORT = int(os.environ.get("DISCOVERY_PORT", "8090"))

TOKEN_IDLE_DAYS = 90


# ---------- 找 claude 命令 ----------

def _claude_candidates() -> list[str]:
    home = Path.home()
    env = os.environ.get
    if sys.platform == "win32":
        appdata = env("APPDATA") or str(home / "AppData" / "Roaming")
        local = env("LOCALAPPDATA") or str(home / "AppData" / "Local")
        pf = env("ProgramFiles") or r"C:\Program Files"
        pats = [
            str(home / ".local" / "bin" / "claude.exe"),            # 官方安装脚本
            str(Path(local) / "Programs" / "claude" / "claude.exe"),
            str(Path(local) / "Microsoft" / "WinGet" / "Links" / "claude.exe"),
            str(Path(appdata) / "npm" / "claude.cmd"),              # npm install -g
            str(Path(pf) / "nodejs" / "claude.cmd"),
            str(Path(env("NVM_SYMLINK") or pf + r"\nodejs") / "claude.cmd"),
            str(Path(env("NVM_HOME") or appdata + r"\nvm") / "*" / "claude.cmd"),
            str(Path(local) / "Volta" / "bin" / "claude.exe"),
            str(home / "scoop" / "shims" / "claude.exe"),
            str(home / ".bun" / "bin" / "claude.exe"),
        ]
    else:
        pats = [
            str(home / ".local" / "bin" / "claude"),
            str(home / ".claude" / "local" / "claude"),
            "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
            str(home / ".npm-global" / "bin" / "claude"),
            str(home / ".nvm" / "versions" / "node" / "*" / "bin" / "claude"),
            str(home / ".volta" / "bin" / "claude"),
            str(home / ".bun" / "bin" / "claude"),
        ]
    return pats


def find_claude() -> str | None:
    """先看环境变量 CLAUDE_BIN 和 PATH；找不到再去常用安装位置找（开机自启时 PATH 常常不全）。"""
    if env := os.environ.get("CLAUDE_BIN"):
        return env if Path(env).is_file() else shutil.which(env)
    if found := shutil.which("claude"):
        return found
    for pat in _claude_candidates():
        hits = sorted(glob.glob(pat), reverse=True)  # nvm 多个版本时取版本号最大的
        for h in hits:
            if Path(h).is_file():
                return h
    return None


# ---------- 数据库 ----------

# 读写分开，免得一个人的慢查询让所有人排队：
# - 写：全进程共用一个连接 _db，由 _db_lock 串行（SQLite 本来也只允许一个写者）。
# - 读：每个线程各有一个只读连接（_reader），不拿 _db_lock。WAL 模式下读不挡写、写不挡读，
#   每次写都在放锁前提交，所以写完紧接着的读（哪怕在别的线程、别的连接上）一定能看到。
DB_PATH = DATA / "center.db"
_db = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
_db.row_factory = sqlite3.Row
_db_lock = threading.Lock()
try:
    _db.execute("PRAGMA journal_mode=WAL")      # 会多出 center.db-wal / center.db-shm 两个文件，备份时要一起拷
    _db.execute("PRAGMA synchronous=NORMAL")
except sqlite3.OperationalError:
    pass   # 放在不支持 WAL 的位置（比如网络盘）时退回默认模式，读写仍然正确，只是读会等写
_readers = threading.local()


def _reader() -> sqlite3.Connection:
    conn = getattr(_readers, "conn", None)
    if conn is None:
        # isolation_level=None：不让 Python 替我们偷偷开事务，否则一次出错就可能停在旧快照上，之后一直读到旧数据
        conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        _readers.conn = conn
    return conn


_db.executescript(
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT, source TEXT,
        claude_session TEXT, created REAL, updated REAL);
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
        content TEXT, meta TEXT, created REAL);
    CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT,
        pw_hash TEXT, role TEXT, can_bypass INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0, created REAL);
    CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, user_id INTEGER, created REAL, last_used REAL);
    CREATE TABLE IF NOT EXISTS links (
        id TEXT PRIMARY KEY, session_id TEXT, user_id INTEGER, name TEXT, created REAL, manifest TEXT);
    CREATE TABLE IF NOT EXISTS library (
        name TEXT PRIMARY KEY, description TEXT, everyone INTEGER DEFAULT 0, submitted_by INTEGER, updated REAL);
    CREATE TABLE IF NOT EXISTS skill_access (name TEXT, user_id INTEGER, PRIMARY KEY (name, user_id));
    CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT, submitted_by INTEGER,
        created REAL, reviewed_by INTEGER, reviewed_at REAL, note TEXT);
    CREATE TABLE IF NOT EXISTS skill_versions (
        name TEXT, version INTEGER, submission_id TEXT, submitted_by INTEGER, approved_by INTEGER,
        changelog TEXT, created REAL, PRIMARY KEY (name, version));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS trash (
        id TEXT PRIMARY KEY, name TEXT, orig_path TEXT, trash_path TEXT, is_dir INTEGER, size INTEGER,
        deleted_by INTEGER, deleted_at REAL, reason TEXT);
    CREATE TABLE IF NOT EXISTS file_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, path TEXT, detail TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS usage_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        message_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_usd REAL,
        created REAL,
        source TEXT DEFAULT 'result');
    CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_turn_model ON usage_turns(message_id, model);
    CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_turns(user_id, created);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_turns(session_id);
    CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT DEFAULT '',
        sort INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        created REAL);
    CREATE INDEX IF NOT EXISTS idx_sections_active ON sections(archived, sort, id);
    CREATE TABLE IF NOT EXISTS doc_cache (
        source_path TEXT PRIMARY KEY,
        size INTEGER,
        mtime_ns INTEGER,
        extractor_version INTEGER,
        md_name TEXT,
        chars INTEGER,
        bytes INTEGER,
        status TEXT,
        hits INTEGER DEFAULT 0,
        created REAL,
        used REAL);
    CREATE TABLE IF NOT EXISTS active_runs (
        session_id TEXT PRIMARY KEY, user_id INTEGER, started REAL);
    CREATE TABLE IF NOT EXISTS turn_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, author_id INTEGER, text TEXT,
        refs TEXT, skill TEXT, action TEXT, created REAL);
    CREATE INDEX IF NOT EXISTS idx_turn_queue_session ON turn_queue(session_id);
    """
)
for _table, _col in (("sessions", "bypass INTEGER DEFAULT 0"), ("sessions", "created_by TEXT DEFAULT ''"),
                     ("sessions", "user_id INTEGER"), ("sessions", "work_dir TEXT"), ("users", "avatar TEXT"),
                     ("library", "version INTEGER DEFAULT 1"), ("submissions", "changelog TEXT"),
                     ("users", "ws_name TEXT"), ("sessions", "ws_dir TEXT"),
                     ("sessions", "section_id INTEGER"), ("users", "last_section_id INTEGER")):
    try:
        _db.execute(f"ALTER TABLE {_table} ADD COLUMN {_col}")
    except sqlite3.OperationalError:
        pass  # 列已存在
_db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_section ON sessions(section_id)")
_db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated)")
_db.commit()


def db(sql: str, args=(), one=False):
    if sql.lstrip()[:6].upper() == "SELECT":
        rows = [dict(r) for r in _reader().execute(sql, args).fetchall()]   # 只读：走本线程的连接，不排队
    else:
        with _db_lock:
            try:
                cur = _db.execute(sql, args)
                _db.commit()
            except Exception:
                _db.rollback()
                raise
            rows = [dict(r) for r in cur.fetchall()]
    return (rows[0] if rows else None) if one else rows


def db_insert(sql: str, args=()) -> int:
    """执行一条 INSERT，在同一把锁里取回 lastrowid，避免并发写入时取到别人的 id。"""
    with _db_lock:
        try:
            cur = _db.execute(sql, args)
            _db.commit()
        except Exception:
            _db.rollback()
            raise
        return cur.lastrowid


def db_many(sql: str, rows) -> int:
    """一次锁、一次提交写完多行；任何一行失败整批回滚。返回实际写入的行数（ON CONFLICT 跳过的不算）。"""
    with _db_lock:
        before = _db.total_changes
        try:
            _db.executemany(sql, rows)
            _db.commit()
        except Exception:
            _db.rollback()
            raise
        return _db.total_changes - before


def db_tx(statements) -> None:
    """一次锁、一次提交执行多条写语句 [(sql, args), ...]；任何一条失败整批回滚。"""
    with _db_lock:
        try:
            for sql, args in statements:
                _db.execute(sql, args)
            _db.commit()
        except Exception:
            _db.rollback()
            raise


def get_setting(key: str, default=None):
    row = db("SELECT value FROM settings WHERE key=?", (key,), one=True)
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value) -> None:
    db("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))


# ---------- 账号 ----------

# 预设头像（图案在 static/ui.js 里），只能从这些里选，不能上传
AVATARS = ["orange", "lemon", "lime", "grapefruit", "peach", "cherry", "grape", "blueberry",
           "kiwi", "avocado", "watermelon", "pineapple", "strawberry", "coconut", "pear", "plum"]


def avatar_of(u: dict) -> str:
    if u.get("avatar") in AVATARS:
        return u["avatar"]
    return AVATARS[(u.get("id") or 0) % len(AVATARS)]

def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, salt, h = stored.split("$")
    except (ValueError, AttributeError):
        return False
    got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1)
    return secrets.compare_digest(got.hex(), h)


def user_public(u: dict) -> dict:
    out = {k: u[k] for k in ("id", "username", "display_name", "role", "can_bypass", "disabled", "created")}
    out["avatar"] = avatar_of(u)
    return out


def get_user(uid) -> dict | None:
    return db("SELECT * FROM users WHERE id=?", (uid,), one=True)


def first_admin() -> dict | None:
    return db("SELECT * FROM users WHERE role='admin' AND disabled=0 ORDER BY id LIMIT 1", one=True)


def adopt_orphans() -> None:
    """升级前没有账号的老会话：统一归到第一个管理员。"""
    if admin := first_admin():
        db("UPDATE sessions SET user_id=? WHERE user_id IS NULL", (admin["id"],))


adopt_orphans()


def migrate_legacy() -> None:
    """ESP32 / 语音模块已移除，升级时处理老数据（可重复执行，不删任何数据）：
    - role='device' 的“板子”账号设为停用并清掉令牌（登录和令牌校验本来就拒绝停用账号）；
    - source='voice' 的历史语音会话保留为只读记录，归到第一个管理员名下；还没有管理员就先不动，下次启动再处理。"""
    db("UPDATE users SET disabled=1 WHERE role='device' AND disabled=0")
    db("DELETE FROM tokens WHERE user_id IN (SELECT id FROM users WHERE role='device')")
    if admin := first_admin():
        db("UPDATE sessions SET user_id=? WHERE source='voice' AND (user_id IS NULL OR user_id NOT IN "
           "(SELECT id FROM users WHERE role='admin'))", (admin["id"],))


migrate_legacy()


def _load_internal_token() -> str:
    """给 approval_mcp.py 用的内部令牌，不给人用。"""
    path = DATA / "internal_token.txt"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(24), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


INTERNAL_TOKEN = _load_internal_token()
INTERNAL = {"id": 0, "username": "internal", "display_name": "系统", "role": "internal", "can_bypass": 0}


def issue_token(uid: int) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    db("INSERT INTO tokens (token, user_id, created, last_used) VALUES (?,?,?,?)", (token, uid, now, now))
    return token


def purge_tokens(now: float | None = None) -> int:
    """删掉已经过了空闲有效期的令牌（本来也登录不了，只是不让表一直变大）。"""
    cutoff = (now if now is not None else time.time()) - TOKEN_IDLE_DAYS * 86400
    n = db("SELECT COUNT(*) AS c FROM tokens WHERE last_used < ?", (cutoff,), one=True)["c"]
    if n:
        db("DELETE FROM tokens WHERE last_used < ?", (cutoff,))
    return n


AUTH_COOKIE = "projector_token"
COOKIE_MAX_AGE = TOKEN_IDLE_DAYS * 86400   # 和令牌的空闲有效期一致


def set_auth_cookie(response, token: str) -> None:
    """登录后顺带种一个 HttpOnly cookie，给 EventSource、<img>、<iframe>、下载链接这些带不了请求头的 GET 用，
    这样令牌就不用再拼进网址（网址会进浏览器历史、访问日志、被复制走）。局域网里是明文 HTTP，所以不加 Secure。"""
    response.set_cookie(AUTH_COOKIE, token, max_age=COOKIE_MAX_AGE, path="/", httponly=True, samesite="lax")


def clear_auth_cookie(response) -> None:
    response.delete_cookie(AUTH_COOKIE, path="/", httponly=True, samesite="lax")


def _token_from(request: Request) -> tuple[str, bool]:
    """返回 (令牌, 是否来自 cookie)。请求头永远可用；cookie 只对 GET/HEAD 生效。
    这是防 CSRF 的关键：别的网站能让浏览器带着 cookie 发请求，但加不上自定义的 Authorization 头，
    所以所有会改东西的请求（POST/PUT/PATCH/DELETE）必须带请求头，cookie 对它们不算数。不再接受网址里的 ?token=。"""
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if given:
        return given, False
    if request.method in ("GET", "HEAD"):
        return request.cookies.get(AUTH_COOKIE, "").strip(), True
    return "", False


def current_user(request: Request) -> dict:
    token, from_cookie = _token_from(request)
    if not token:
        raise HTTPException(401, "请先登录")
    if secrets.compare_digest(token, INTERNAL_TOKEN):
        if from_cookie:   # 内部令牌只走请求头（approval_mcp.py），不接受 cookie
            raise HTTPException(401, "请先登录")
        return INTERNAL
    row = db("SELECT u.*, t.last_used FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?", (token,), one=True)
    now = time.time()
    if not row or row["disabled"] or now - row["last_used"] > TOKEN_IDLE_DAYS * 86400:
        raise HTTPException(401, "登录已失效，请重新登录")
    if now - row["last_used"] > 600:
        db("UPDATE tokens SET last_used=? WHERE token=?", (now, token))
    return row


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return user


def require_internal(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "internal":
        raise HTTPException(403, "只供内部使用")
    return user


def is_admin(user: dict) -> bool:
    return user["role"] in ("admin", "internal")


def can_bypass(user: dict) -> bool:
    return user.get("role") == "admin" or bool(user.get("can_bypass"))


def is_local(request: Request) -> bool:
    try:
        return ipaddress.ip_address(request.client.host).is_loopback
    except (ValueError, AttributeError):
        return False


def can_see_session(user: dict, sess: dict) -> bool:
    return is_admin(user) or sess.get("user_id") == user["id"]


def jdump(x) -> str:
    return json.dumps(x, ensure_ascii=False)


def posix_rule_path(p: Path) -> str:
    """Claude Code 权限规则里的绝对路径写法：Windows 的 D:\\a\\b 写成 //d/a/b。"""
    s = p.as_posix()
    if len(s) > 1 and s[1] == ":":
        s = "/" + s[0].lower() + s[2:]
    return "/" + s


def session_for(sid: str, user: dict) -> dict:
    """取会话并检查权限：只能看自己的，管理员能看所有人的。"""
    s = db("SELECT * FROM sessions WHERE id=?", (sid,), one=True)
    if not s or not can_see_session(user, s):
        raise HTTPException(404, "会话不存在")
    return s


_ws_lock = threading.Lock()


def safe_name(name: str, limit: int = 60) -> str:
    """能当 Windows 文件夹名的字符串"""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "").strip(" .")
    return name[:limit].strip(" .") or "未命名"


def user_ws_dir(u: dict, create: bool = True) -> Path:
    """某个人的工作区文件夹：显示名(用户名)，第一次用到时定下来，之后改显示名也不变"""
    with _ws_lock:
        name = (db("SELECT ws_name FROM users WHERE id=?", (u["id"],), one=True) or {}).get("ws_name")
        if not name:
            base = safe_name(f"{u['display_name']}({u['username']})")
            name, n = base, 2
            while (WS_ROOT / name).exists() or db("SELECT 1 FROM users WHERE ws_name=?", (name,), one=True):
                name, n = f"{base}-{n}", n + 1
            db("UPDATE users SET ws_name=? WHERE id=?", (name, u["id"]))
    d = WS_ROOT / name
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def ws_owner(folder: str) -> int | None:
    """工作区第一层文件夹名 → 用户 id"""
    row = db("SELECT id FROM users WHERE ws_name=?", (folder,), one=True)
    return row["id"] if row else None


def session_workspace(sess: dict, create: bool = True) -> Path | None:
    """会话的工作区文件夹：日期 会话标题；第一次用到时才建，之后会话改名也不变（免得路径失效）"""
    row = db("SELECT id, user_id, title, created, ws_dir FROM sessions WHERE id=?", (sess["id"],), one=True) or sess
    owner = get_user(row["user_id"])
    if not owner:
        return None
    base = user_ws_dir(owner, create)
    name = row.get("ws_dir")
    if not name:
        if not create:
            return None
        with _ws_lock:
            name = (db("SELECT ws_dir FROM sessions WHERE id=?", (row["id"],), one=True) or {}).get("ws_dir")
            if not name:
                day = time.strftime("%Y-%m-%d", time.localtime(row.get("created") or time.time()))
                stem = safe_name(f"{day} {row.get('title') or '会话'}")
                name, n = stem, 2
                while (base / name).exists():
                    name, n = f"{stem} ({n})", n + 1
                db("UPDATE sessions SET ws_dir=? WHERE id=?", (name, row["id"]))
    d = base / name
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def _migrate_workspaces() -> None:
    """老版本的工作区（data/workspaces/用户id/会话id）搬到新位置"""
    if OLD_WS == WS_ROOT or not OLD_WS.is_dir():
        return
    import shutil
    for udir in OLD_WS.iterdir():
        if not (udir.is_dir() and udir.name.isdigit()):
            continue
        for sdir in udir.iterdir():
            sess = db("SELECT * FROM sessions WHERE id=?", (sdir.name,), one=True)
            if not sess or not sdir.is_dir():
                continue
            dest = session_workspace(sess)
            for child in sdir.iterdir():
                target = dest / child.name
                if not target.exists():
                    shutil.move(str(child), str(target))
            try:
                sdir.rmdir()
            except OSError:
                pass
        try:
            udir.rmdir()  # 搬空了就删掉
        except OSError:
            pass


def log_file_op(user: dict, action: str, path, detail: str = "") -> None:
    db("INSERT INTO file_ops (user_id, action, path, detail, created) VALUES (?,?,?,?,?)",
       (user.get("id"), action, str(path), detail[:500], time.time()))


_migrate_workspaces()
