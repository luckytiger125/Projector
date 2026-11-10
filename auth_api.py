"""登录和账号：首次创建管理员、登录退出、个人资料，管理员的用户管理和权限档位设置。"""
import asyncio
import re
import shutil
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

import files_api
from runner import DEFAULT_ASK_CMDS, DEFAULT_BASH_ALLOW, RUNS, SAFE_BASH, dispatch_queue, max_concurrent, perm_mode
from store import (AVATARS, DATA, PORT, VERSION, adopt_orphans, can_bypass, check_password, current_user, db, first_admin,
                   get_setting, get_user, hash_password, is_local, issue_token, require_admin, set_auth_cookie, set_setting,
                   user_public, user_ws_dir, clear_auth_cookie, _token_from)

router = APIRouter()


# ---------- 登录和账号 ----------

class Credentials(BaseModel):
    username: str
    password: str
    display_name: str = ""


class MePatch(BaseModel):
    avatar: str | None = None
    display_name: str | None = None


class ChangePassword(BaseModel):
    old: str
    new: str


def _check_new_password(pw: str) -> None:
    if len(pw) < 6:
        raise HTTPException(400, "密码至少 6 位")


def me_view(u: dict) -> dict:
    return {**user_public(u), "can_bypass": can_bypass(u)}


@router.get("/api/setup")
def setup_state(request: Request):
    return {"needed": first_admin() is None, "local": is_local(request), "version": VERSION}


@router.post("/api/setup")
def setup_admin(body: Credentials, request: Request, response: Response):
    """第一次运行：只能在台式机本机上创建第一个管理员。"""
    if first_admin():
        raise HTTPException(409, "已经有管理员了")
    if not is_local(request):
        raise HTTPException(403, "请在台式机本机上打开 http://localhost:%d 创建管理员" % PORT)
    _check_new_password(body.password)
    username = body.username.strip()
    if not username or db("SELECT 1 FROM users WHERE username=?", (username,), one=True):
        raise HTTPException(400, "用户名不能为空或已存在")
    db("INSERT INTO users (username, display_name, pw_hash, role, created) VALUES (?,?,?,?,?)",
       (username, body.display_name.strip() or username, hash_password(body.password), "admin", time.time()))
    adopt_orphans()
    u = db("SELECT * FROM users WHERE username=?", (username,), one=True)
    token = issue_token(u["id"])
    set_auth_cookie(response, token)
    return {"token": token, "user": me_view(u)}


@router.post("/api/login")
async def login(body: Credentials, response: Response):
    u = db("SELECT * FROM users WHERE username=?", (body.username.strip(),), one=True)
    if not u or u["disabled"] or u["role"] not in ("admin", "user") or not check_password(body.password, u["pw_hash"]):
        await asyncio.sleep(1)  # 放慢猜密码
        raise HTTPException(401, "用户名或密码不对")
    token = issue_token(u["id"])
    set_auth_cookie(response, token)
    return {"token": token, "user": me_view(u)}


@router.post("/api/logout")
def logout(request: Request, response: Response, user: dict = Depends(current_user)):
    token, _ = _token_from(request)   # 登出是 POST，只会拿到请求头里的令牌
    db("DELETE FROM tokens WHERE token=?", (token,))
    clear_auth_cookie(response)
    return {"ok": True}


@router.post("/api/session-cookie")
def session_cookie(request: Request, response: Response, user: dict = Depends(current_user)):
    """升级前就已经登录的人：浏览器里有令牌（localStorage）但没有 cookie。页面启动时带着请求头调一次，补种 cookie，不用重新登录。"""
    if user["role"] == "internal":
        raise HTTPException(403, "只供内部使用")
    token, _ = _token_from(request)
    set_auth_cookie(response, token)
    return {"ok": True}


@router.get("/api/me")
def me(user: dict = Depends(current_user)):
    return me_view(user)


@router.patch("/api/me")
def update_me(body: MePatch, user: dict = Depends(current_user)):
    if body.avatar is not None:
        if body.avatar not in AVATARS:
            raise HTTPException(400, "只能从预设头像里选")
        db("UPDATE users SET avatar=? WHERE id=?", (body.avatar, user["id"]))
    if body.display_name is not None and body.display_name.strip():
        db("UPDATE users SET display_name=? WHERE id=?", (body.display_name.strip()[:32], user["id"]))
    return me_view(get_user(user["id"]))


@router.post("/api/me/password")
def change_password(body: ChangePassword, response: Response, user: dict = Depends(current_user)):
    if not check_password(body.old, user["pw_hash"]):
        raise HTTPException(400, "原密码不对")
    _check_new_password(body.new)
    db("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(body.new), user["id"]))
    db("DELETE FROM tokens WHERE user_id=?", (user["id"],))   # 和管理员重置密码一致：改了密码，所有设备都要重新登录
    clear_auth_cookie(response)
    return {"ok": True}


# ---------- 管理员：用户 ----------

class UserPatch(BaseModel):
    display_name: str | None = None
    avatar: str | None = None
    password: str | None = None
    role: str | None = None
    can_bypass: bool | None = None
    disabled: bool | None = None


def _target_user(uid: int) -> dict:
    u = get_user(uid)
    if not u:
        raise HTTPException(404, "用户不存在")
    return u


@router.get("/api/admin/users")
def admin_users(admin: dict = Depends(require_admin)):
    rows = db("SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id) AS sessions, "
              "(SELECT MAX(last_used) FROM tokens t WHERE t.user_id=u.id) AS last_seen FROM users u ORDER BY u.id")
    return [{**user_public(r), "sessions": r["sessions"], "last_seen": r["last_seen"]} for r in rows]


@router.post("/api/admin/users")
def admin_create_user(body: Credentials, admin: dict = Depends(require_admin)):
    username = body.username.strip()
    if not re.fullmatch(r"\S{1,32}", username):
        raise HTTPException(400, "用户名不能有空格，最多 32 个字")
    if db("SELECT 1 FROM users WHERE username=?", (username,), one=True):
        raise HTTPException(400, "这个用户名已经有了")
    _check_new_password(body.password)
    db("INSERT INTO users (username, display_name, pw_hash, role, created) VALUES (?,?,?,?,?)",
       (username, body.display_name.strip() or username, hash_password(body.password), "user", time.time()))
    return user_public(db("SELECT * FROM users WHERE username=?", (username,), one=True))


@router.patch("/api/admin/users/{uid}")
def admin_update_user(uid: int, body: UserPatch, admin: dict = Depends(require_admin)):
    u = _target_user(uid)
    if body.display_name is not None:
        db("UPDATE users SET display_name=? WHERE id=?", (body.display_name.strip()[:32] or u["username"], uid))
    if body.avatar is not None:
        if body.avatar not in AVATARS:
            raise HTTPException(400, "只能从预设头像里选")
        db("UPDATE users SET avatar=? WHERE id=?", (body.avatar, uid))
    if body.password:
        _check_new_password(body.password)
        db("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(body.password), uid))
        db("DELETE FROM tokens WHERE user_id=?", (uid,))  # 重置密码后要重新登录
    if body.role in ("admin", "user") and body.role != u["role"]:
        admins = db("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0", one=True)["n"]
        if u["role"] == "admin" and admins <= 1:
            raise HTTPException(400, "至少要保留一个管理员")
        db("UPDATE users SET role=? WHERE id=?", (body.role, uid))
    if body.can_bypass is not None:
        db("UPDATE users SET can_bypass=? WHERE id=?", (int(body.can_bypass), uid))
        if not body.can_bypass:
            db("UPDATE sessions SET bypass=0 WHERE user_id=?", (uid,))
    if body.disabled is not None:
        if body.disabled and uid == admin["id"]:
            raise HTTPException(400, "不能停用自己")
        db("UPDATE users SET disabled=? WHERE id=?", (int(body.disabled), uid))
        if body.disabled:
            db("DELETE FROM tokens WHERE user_id=?", (uid,))
    return user_public(get_user(uid))


@router.delete("/api/admin/users/{uid}")
def admin_delete_user(uid: int, admin: dict = Depends(require_admin)):
    u = _target_user(uid)
    if uid == admin["id"]:
        raise HTTPException(400, "不能删除自己")
    if any(r.owner_id == uid for r in RUNS.values()):
        raise HTTPException(409, "这个用户还有任务在进行")
    ud = user_ws_dir(u, create=False)  # 删账号记录之前先定位工作区
    for s in db("SELECT id FROM sessions WHERE user_id=?", (uid,)):
        db("DELETE FROM messages WHERE session_id=?", (s["id"],))
    for sql in ("DELETE FROM sessions WHERE user_id=?", "DELETE FROM links WHERE user_id=?",
                "DELETE FROM tokens WHERE user_id=?", "DELETE FROM skill_access WHERE user_id=?",
                "DELETE FROM users WHERE id=?"):
        db(sql, (uid,))
    if ud.exists():
        files_api.move_to_trash(ud, admin, f"删除用户 {u['display_name']}")
    shutil.rmtree(DATA / "plugins" / str(uid), ignore_errors=True)
    return {"ok": True}


class SettingsBody(BaseModel):
    perm_mode: str | None = None
    bash_allow: list[str] | None = None
    ask_cmds: list[str] | None = None
    max_concurrent: int | None = None   # 同时运行的 Claude 进程数，1~16


def _clean_cmds(cmds: list[str]) -> list[str]:
    out = []
    for c in cmds:
        c = " ".join(c.split())[:60]
        if c and not any(x in c for x in "()") and c not in out:
            out.append(c)
    return out[:100]


@router.get("/api/admin/settings")
def admin_get_settings(admin: dict = Depends(require_admin)):
    return {"perm_mode": perm_mode(), "bash_allow": get_setting("bash_allow", DEFAULT_BASH_ALLOW),
            "ask_cmds": get_setting("ask_cmds", DEFAULT_ASK_CMDS), "safe": [r[5:-1] for r in SAFE_BASH],
            "default_ask": DEFAULT_ASK_CMDS, "default_allow": DEFAULT_BASH_ALLOW,
            "max_concurrent": max_concurrent()}


@router.put("/api/admin/settings")
async def admin_put_settings(body: SettingsBody, admin: dict = Depends(require_admin)):
    if body.max_concurrent is not None and not 1 <= body.max_concurrent <= 16:
        raise HTTPException(400, "同时运行的任务数要在 1 到 16 之间")
    if body.perm_mode in ("standard", "strict"):
        set_setting("perm_mode", body.perm_mode)
    if body.bash_allow is not None:
        set_setting("bash_allow", _clean_cmds(body.bash_allow))
    if body.ask_cmds is not None:
        set_setting("ask_cmds", _clean_cmds(body.ask_cmds))
    if body.max_concurrent is not None:
        set_setting("max_concurrent", body.max_concurrent)
        dispatch_queue()   # 调大上限后，排着的消息马上有位置
    return admin_get_settings(admin)
