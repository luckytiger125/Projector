"""台式机中心服务：账号、多会话、权限确认、调用 Claude Code；供局域网网页端和桌面软件使用。

运行：python server.py              （配置见 config.bat 里的环境变量）
重置密码：python server.py reset-password 用户名 新密码

本文件只负责组装：创建 app、挂载各模块的路由、静态文件、启动钩子、局域网发现。业务在这些模块里：
  events.py       SSE 订阅、broadcast、add_message、push_session
  approvals.py    权限确认和 Claude 提问（内存状态 + 接口）
  runner.py       调用 Claude Code（Run / RUNS / start_turn / _drive）
  sessions_api.py 会话视图和接口
  auth_api.py     登录、账号、权限档位设置
"""
import asyncio
import json
import socket
import sys
import threading
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import approvals
import auth_api
import events
import files_api
import housekeeping
import kb
import runner
import sdk_runner
import sections
import sessions_api
import skills_api
import usage
from store import BASE, DISCOVERY_PORT, FILE_ROOT, KB_ROOT, PORT, VERSION, current_user, db, find_claude, first_admin, hash_password


async def _sdk_idle_loop() -> None:
    while True:
        await asyncio.sleep(30)
        try:
            await sdk_runner.close_idle()
        except Exception:
            usage.log_failure("-", "sdk_idle")


async def _housekeeping_loop() -> None:
    """定期清理过期的回收站、令牌、预览缓存、日志（见 housekeeping.py）。放线程里跑，不占事件循环。"""
    await asyncio.sleep(housekeeping.FIRST_DELAY)
    while True:
        try:
            await asyncio.to_thread(housekeeping.run_all, set(runner.RUNS))
        except Exception:
            usage.log_failure("-", "housekeeping")
        await asyncio.sleep(housekeeping.INTERVAL)


@asynccontextmanager
async def lifespan(_app):
    runner.dispatch_queue()   # 事件循环起来了：把重启前还排着的消息接着开始
    tasks = [asyncio.create_task(_sdk_idle_loop()),   # sdk 模式：定期关掉空闲的常驻客户端
             asyncio.create_task(_housekeeping_loop())]
    yield
    for t in tasks:
        t.cancel()
    for t in tasks:
        try:
            await t
        except asyncio.CancelledError:
            pass
    try:
        await sdk_runner.close_all()
    except Exception:
        usage.log_failure("-", "sdk_close_all")


app = FastAPI(lifespan=lifespan)
app.include_router(files_api.router)
app.include_router(skills_api.router)
app.include_router(kb.router)
app.include_router(usage.router)
app.include_router(sections.router)
app.include_router(auth_api.router)
app.include_router(sessions_api.router)
app.include_router(runner.router)
app.include_router(approvals.router)
app.include_router(events.router)

kb.start_prune_thread()   # 文档缓存每 7 天清理一次，放后台线程，不拖慢启动
try:
    kb.recover_section_rename()   # 上次分区改名中途崩溃的话，把没改完的笔记补上
except Exception:
    kb._log_section("启动时恢复分区改名失败")


try:
    runner.recover_runs()   # 上次重启时还在跑的轮次：记一条中断消息；排队的消息等事件循环起来后再开始
except Exception:
    usage.log_failure("-", "recover_runs")


def lan_urls() -> list[str]:
    """台式机在局域网里的地址，给手机扫码用。"""
    ips = []
    try:  # 找默认出口网卡的地址（不会真的发数据）
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith(("127.", "169.254.")) and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    def rank(ip):  # 家里和公司常见的局域网网段排前面，代理软件的虚拟网卡（198.18.x）排最后
        if ip.startswith(("192.168.", "10.")) or (ip.startswith("172.") and 16 <= int(ip.split(".")[1]) <= 31):
            return 0
        return 2 if ip.startswith(("198.18.", "198.19.")) else 1
    return [f"http://{ip}:{PORT}" for ip in sorted(ips, key=rank)]


@app.get("/api/lan")
def lan(user: dict = Depends(current_user)):
    return {"urls": lan_urls(), "host": f"http://{socket.gethostname()}:{PORT}"}


@app.get("/manifest.webmanifest")
def manifest():
    """手机“添加到主屏幕”用"""
    from fastapi.responses import JSONResponse
    return JSONResponse({
        "name": "Projector · Claude 工作台", "short_name": "Projector", "start_url": "/", "scope": "/",
        "display": "standalone", "background_color": "#f4efe6", "theme_color": "#f4efe6", "lang": "zh-CN",
        "icons": [{"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png"},
                  {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
    }, media_type="application/manifest+json")


def _index_page():
    return FileResponse(BASE / "static" / "app" / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
def index():
    return _index_page()


# 前端路由回退：这些前缀下的网址都交给前端处理。用明确清单，不做“其余全部”的兜底，
# 这样 /api/ 下打错的路径仍然是 404。
SPA_PREFIXES = ("s", "board", "files", "kb", "skills", "usage", "mobile", "admin")
for _p in SPA_PREFIXES:
    app.add_api_route(f"/{_p}", _index_page, methods=["GET"], include_in_schema=False)
    app.add_api_route(f"/{_p}/{{rest:path}}", _index_page, methods=["GET"], include_in_schema=False)


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


# ---------- 局域网自动发现：桌面软件广播询问，这里回复自己的名字和端口 ----------

def discovery_responder() -> None:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", DISCOVERY_PORT))
    except OSError as e:
        print(f"  自动发现端口 {DISCOVERY_PORT} 被占用，同事的软件需要手动填地址：{e}")
        return
    reply = json.dumps({"app": "projector", "name": socket.gethostname(), "port": PORT, "version": VERSION},
                       ensure_ascii=False).encode()
    while True:
        try:
            data, addr = sock.recvfrom(256)
            if data.startswith(b"PROJECTOR_DISCOVER"):
                sock.sendto(reply, addr)
        except OSError:
            time.sleep(1)


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "reset-password":
        if len(sys.argv) != 4:
            sys.exit("用法：python server.py reset-password 用户名 新密码")
        u = db("SELECT * FROM users WHERE username=?", (sys.argv[2],), one=True)
        if not u:
            sys.exit("没有这个用户")
        db("UPDATE users SET pw_hash=?, disabled=0 WHERE id=?", (hash_password(sys.argv[3]), u["id"]))
        db("DELETE FROM tokens WHERE user_id=?", (u["id"],))
        print(f"已重置 {u['username']} 的密码")
        return
    host = socket.gethostname()
    claude_bin = find_claude()
    print(f"Projector 中心服务 v{VERSION}")
    print(f"  本机打开：http://localhost:{PORT}    其他电脑：http://{host}:{PORT}（或在桌面软件里自动查找）")
    if not first_admin():
        print(f"  还没有管理员：请在本机浏览器打开 http://localhost:{PORT} 创建")
    print(f"  工作目录 {FILE_ROOT}")
    print(f"  知识库 {KB_ROOT}")
    print(f"  claude：{claude_bin or '没找到！请安装 Claude Code，或在 config.bat 里设置 CLAUDE_BIN'}")
    if runner.runner_mode() == "sdk":
        reason = sdk_runner.availability()
        print("  运行方式：sdk（常驻会话）" + (f"    不可用：{reason}" if reason else ""))
    else:
        print("  运行方式：cli")
    print(f"  Office 预览：{files_api.SOFFICE or '没装 LibreOffice，PPT 等只能用本机程序打开'}")
    threading.Thread(target=discovery_responder, daemon=True).start()
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
