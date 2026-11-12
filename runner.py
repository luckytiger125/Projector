"""调用 Claude Code：权限档位和提示词、命令行拼装、run_claude 子进程、每个会话的 Run 状态（RUNS）、start_turn / _drive、停止和超时。
以后换别的 agent 工具，主要改这个文件。
"""
import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

import guard
import kb
import sections
import sdk_runner
import skills_api
import usage
from approvals import APPROVAL_TIMEOUT, pending_for, questions_for
from events import lock as events_lock
from events import add_message, broadcast, push_session
from store import (BASE, DATA, FILE_ROOT, INTERNAL_TOKEN, KB_ROOT, PORT, TRASH, WS_ROOT, can_bypass, current_user, db, db_insert,
                   find_claude, get_setting, get_user, jdump, posix_rule_path, session_for, session_workspace, user_ws_dir)

router = APIRouter()

LOGS = DATA / "logs"
LOGS.mkdir(exist_ok=True)
TASK_TIMEOUT = float(os.environ.get("CLAUDE_TASK_TIMEOUT", "3600"))


# 自动放行的操作；其余操作（删除、移动、运行程序、其他命令等）都要有人确认。
# 用 DeepSeek 等第三方模型时 WebSearch 不可用，所以不放进来。
READ_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "Skill"]
SAFE_BASH = [
    "Bash(ls:*)", "Bash(pwd)", "Bash(cd:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
]
EDIT_TOOLS = ["Edit", "Write"]
# 技能工具：提交的技能要管理员审核才生效，所以自动放行
SKILL_TOOLS = ["mcp__center__skill_list", "mcp__center__skill_checkout", "mcp__center__skill_submit",
               "mcp__center__ask_user",  # ask_user：弹出选项让用户点选
               # 知识库：写入会留历史版本、可以恢复；read_document 只读
               "mcp__center__kb_search", "mcp__center__kb_read", "mcp__center__kb_write", "mcp__center__read_document"]
DEFAULT_BASH_ALLOW = ["python", "py", "pip", "unzip", "tar"]  # 严格档下额外自动放行的命令
# 标准档下仍要确认的危险命令（删除、移动、格式化、改系统、强制推送等）
DEFAULT_ASK_CMDS = ["rm", "rmdir", "del", "erase", "rd", "mv", "move", "Remove-Item", "ri", "Move-Item",
                    "format", "diskpart", "shutdown", "reboot", "reg", "taskkill", "chmod", "chown", "icacls", "takeown",
                    "git push", "git reset", "git clean", "git checkout --", "net user", "sc"]


def perm_mode() -> str:
    """权限档位：standard 标准（默认，只有危险命令要确认）/ strict 严格（只读命令以外都要确认）"""
    return get_setting("perm_mode", "standard")


def _cmd_rules(cmds) -> list[str]:
    rules = []
    for cmd in cmds:
        cmd = cmd.strip()
        if cmd and not any(c in cmd for c in "()\n"):
            rules += [f"Bash({cmd})", f"Bash({cmd}:*)"]
    return rules


def runner_mode() -> str:
    """运行方式：cli（每轮起一个 claude 进程，默认）/ sdk（claude-agent-sdk 常驻会话）。管理员设置 > 环境变量 RUNNER_MODE > cli；其他值按 cli。"""
    raw = get_setting("runner_mode", None)
    if raw is None:
        raw = os.environ.get("RUNNER_MODE")
    mode = str(raw or "").strip().lower()
    return mode if mode in ("cli", "sdk") else "cli"


def sdk_idle_seconds() -> int:
    """sdk 常驻客户端空闲多久后关掉：管理员设置 > 环境变量 SDK_IDLE_SECONDS > 600；限制在 30~86400。"""
    try:
        default = int(os.environ.get("SDK_IDLE_SECONDS") or 600)
    except ValueError:
        default = 600
    try:
        n = int(get_setting("sdk_idle_seconds", default))
    except (TypeError, ValueError):
        n = default
    return max(30, min(86400, n))


def bash_allow_rules() -> list[str]:
    """严格档：管理员设置的自动放行命令 → Claude Code 规则，比如 python → Bash(python:*)"""
    return _cmd_rules(get_setting("bash_allow", DEFAULT_BASH_ALLOW))

WEB_HINT = (
    "用户在电脑上和你对话，用户名：{user}。工作目录是团队共用的文件库，回答用中文。"
    "删除、移动文件和执行命令会弹窗让用户确认；被拒绝时不要换个方式重试同样的操作，先问用户。"
    "用户上传的本机文件在“工作区”里（消息里会给出完整路径），处理结果如果要还给用户，直接改那些文件或在同一文件夹里新建，"
    "用户可以一键同步回自己的电脑。不要访问其他用户的工作区。"
    "需要用户在几个方案里做选择、或确认关键信息时，调用 ask_user 弹出选项让用户点选："
    "一次最多 4 个问题，每题 2~4 个选项，推荐的选项放第一个并在 label 末尾加“（推荐）”；"
    "不要在回答里列出选项等用户打字回复，也不要为显而易见的事情提问。"
    "团队知识库在 {kb}：经验（以前怎么做的）、文件卡片（重要文件的摘要和位置）、主题（项目、客户等）。"
    "问题涉及公司业务、项目、客户、以前做过的事，或者要在文件库里找资料时，先用 kb_search 查一下，"
    "查到的文件卡片里有原文件路径，可以直接去读；回答里提到知识库笔记时写成 [[笔记名]]，用户能点开。"
    "知识库只能用 kb_write 修改（会自动记作者和历史），用户没要求时不要往里写；"
    "做完一件费了功夫、以后还会用到的事，可以在回答末尾提一句“可以点‘沉淀经验’把这次的做法存进知识库”。"
    "读 Word、Excel、PPT、PDF 的内容用 read_document。"
    "用户想新建或修改团队技能（skill）时：先用 skill_checkout 取出（新建时 name 留空拿到草稿文件夹），"
    "在工作区里改好，再用 skill_submit 提交并写清更新说明；提交后要管理员审核才生效，不要直接改技能库或插件目录。"
    "这台电脑是 Windows，命令通过 Git Bash 执行：python 不能用时试 py；没有 unzip 时用 tar -xf 文件.zip 或 "
    "powershell -Command \"Expand-Archive 文件.zip 目标文件夹\"；文件路径用正斜杠或加引号。"
)
# 聊天里的两个快捷动作：给 Claude 的完整指令；用户看到的是简短的一句
KB_ACTIONS = {
    "distill": (
        "把这次对话沉淀成团队经验",
        "【沉淀经验】请把这次对话里值得团队以后复用的经验，整理进团队知识库：\n"
        "1. 先用 kb_search 查有没有相关的经验笔记：有就 kb_read 后用 kb_write 的 mode=update 合并进去（保留原来有用的内容），"
        "没有再新建（type=经验）。一条经验只讲一件事，内容多就拆成几条。\n"
        "2. 标题写成以后别人会搜的样子，比如“供应商对账单的核对方法”；summary 用一句话说清楚这条经验解决什么问题。\n"
        "3. 正文用这几节：## 什么时候用（遇到什么情况）／## 做法（步骤，具体到文件夹、工具、命令、技能）／"
        "## 用到的文件（完整路径）／## 注意（踩过的坑、容易出错的地方）。\n"
        "4. 提到的项目、客户、供应商、产品、部门、人名用 [[名字]] 链接；重要文件已有文件卡片的，链接到卡片。\n"
        "5. 不要写进密码、身份证号、银行卡号这类敏感信息，也不要照抄大段原文。\n"
        "6. 如果这次对话没有值得沉淀的内容，直接告诉我，不要硬写。\n"
        "写完用一两句话告诉我存了哪几条，笔记名写成 [[笔记名]]。"),
    "organize": (
        "把「{name}」整理进知识库",
        "【整理进知识库】请为上面引用的文件或文件夹制作“文件卡片”，存进团队知识库，方便以后快速找到和理解：\n"
        "1. 先用 kb_search 看是否已有这些文件的卡片：有就更新（原文件改过的按新内容改），没有就新建（type=文件卡片，"
        "source 填原文件或文件夹的完整路径）。卡片标题用能看懂的名字，比如“2026 年 3 月 客户A 采购合同”，不要只写文件名。\n"
        "2. 文件夹：先看整体结构，为文件夹本身写一张卡片（放了什么、怎么组织、重要文件有哪些）；"
        "再为里面重要的文件（合同、报价、方案、制度、汇总表、报告等）各写一张。临时文件、重复的旧版本、图片素材不用单独写。"
        "重要文件超过 30 个时先做最重要的 30 个，并在文件夹卡片里说明还有哪些没做。\n"
        "3. 读 Word、Excel、PPT、PDF 用 read_document。\n"
        "4. 每张卡片：summary 一句话说明这是什么；正文用 ## 概要／## 关键信息（金额、日期、对方、编号、结论等，用列表）／## 相关。\n"
        "5. 提到的项目、客户、供应商、产品、人名用 [[名字]] 链接；某个名字被好几张卡片提到、又还没有笔记时，"
        "建一条 type=主题 的笔记，简单介绍并列出相关卡片。\n"
        "6. 不要抄录全文，不要写进身份证号、银行卡号、密码。\n"
        "完成后告诉我做了几张卡片、建了哪些主题，笔记名写成 [[笔记名]]。"),
}


# ---------- 调用 Claude Code（以后换别的 agent 工具，只改这一段） ----------

def _tool_detail(args: dict) -> str:
    for key in ("file_path", "path", "pattern", "url", "command", "skill", "query", "title", "name"):
        if args.get(key):
            return str(args[key])[:200]
    return ""


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        # claude 可能是 .cmd 包装的 node 进程，要连子进程一起结束
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.kill()


def _hint_file(sess: dict, owner: dict) -> Path:
    hint = WEB_HINT.format(user=owner["display_name"], kb=KB_ROOT)
    path = DATA / "mcp" / f"hint_{sess['id']}.txt"
    path.write_text(hint, encoding="utf-8")
    return path


def _deny_paths(owner: dict) -> list[Path]:
    """软隔离要保护的路径：聊天记录库、待审核的 skill、别人的工作区、各种缓存。"""
    paths = [DATA / "center.db", DATA / "center.db-wal", DATA / "center.db-shm", DATA / "internal_token.txt", DATA / "mcp", DATA / "skills" / "submissions", TRASH,
             kb.DOC_CACHE_DIR,   # 文档缓存：Claude 只能通过 read_document 读，不能直接碰缓存目录
             DATA / "preview"]   # Office 转 PDF 的预览缓存
    for u in db("SELECT * FROM users WHERE id != ?", (owner["id"],)):
        paths += [user_ws_dir(u, create=False), DATA / "plugins" / str(u["id"])]
    return paths


def _deny_rules(owner: dict) -> list[str]:
    """软隔离：不让 Claude 用文件工具碰聊天记录库、待审核的 skill 和别人的工作区。"""
    rules = []
    for p in _deny_paths(owner):
        pat = posix_rule_path(p) + ("/**" if p.suffix == "" else "")
        rules += [f"Read({pat})", f"Edit({pat})", f"Write({pat})"]
    # 知识库可以读，但只能通过 kb_write 改（这样才有作者和历史记录）
    kbp = posix_rule_path(KB_ROOT) + "/**"
    rules += [f"Edit({kbp})", f"Write({kbp})"]
    return rules


def guard_policy(owner: dict) -> guard.Policy:
    """文件隔离策略：本人只能进自己的工作区，别人的工作区和系统数据一律禁止（给 guard.py 钩子和确认前的检查用）。"""
    ws_root = Path(WS_ROOT)
    forbidden = []
    for p in _deny_paths(owner):
        try:
            p.relative_to(ws_root)   # 在工作区根里面的（别人的文件夹、回收站）由 ws_root 规则管
        except ValueError:
            forbidden.append(str(p))
    # 先取完用户列表再逐个算文件夹名：user_ws_dir 里要用数据库锁，不能在持锁时嵌套
    others = [user_ws_dir(u, create=False).name for u in db("SELECT * FROM users WHERE id != ?", (owner["id"],))]
    return guard.Policy(ws_root=str(ws_root), own=[str(user_ws_dir(owner, create=False))],
                        forbidden=forbidden, other_names=others)


def _guard_settings(sess: dict, owner: dict) -> dict:
    """写策略文件，返回带 PreToolUse 钩子的 settings 字典（标准档会再往里加 permissions）"""
    policy_file = DATA / "mcp" / f"guard_{sess['id']}.json"
    policy_file.write_text(guard_policy(owner).dumps(), encoding="utf-8")
    # Windows 上钩子命令由 Git Bash 执行：路径一律正斜杠并加双引号
    command = f'"{Path(sys.executable).as_posix()}" "{(BASE / "guard.py").as_posix()}" "{policy_file.as_posix()}"'
    return {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": 20}]}]}}


def _mcp_center(sess: dict) -> dict:
    """外部工具服务 approval_mcp.py 的 stdio 配置（权限确认 + 技能、知识库工具）。"""
    return {
        "command": sys.executable,
        "args": [str(BASE / "approval_mcp.py")],
        "env": {
            "CENTER_URL": f"http://127.0.0.1:{PORT}",
            "CENTER_TOKEN": INTERNAL_TOKEN,
            "CENTER_SESSION": sess["id"],
            "PYTHONUTF8": "1",
        },
    }


def _perm_plan(sess: dict, owner: dict) -> tuple[str, list[str], list[str]]:
    """三个权限档位：返回 (档位 bypass/strict/standard, 自动放行名单, ask 规则)；cli 和 sdk 两种运行方式共用。"""
    if sess["bypass"] and can_bypass(owner):
        return "bypass", [], []
    if perm_mode() == "strict":
        # 严格：只读命令 + 白名单自动放行；改文件也要确认
        return "strict", READ_TOOLS + SAFE_BASH + SKILL_TOOLS + bash_allow_rules() + EDIT_TOOLS, []
    # 标准：读、改、运行命令都自动放行，只有危险命令走确认（ask 规则优先于 allow）
    auto = READ_TOOLS + ["Bash", "PowerShell", "NotebookEdit", "MultiEdit"] + EDIT_TOOLS + SKILL_TOOLS
    return "standard", auto, _cmd_rules(get_setting("ask_cmds", DEFAULT_ASK_CMDS))


def build_sdk_spec(claude_bin: str, sess: dict, owner: dict, extra_dirs: list[Path]) -> "sdk_runner.TurnSpec":
    """sdk 运行方式：和 build_command 同一套名单和规则，装进 TurnSpec。只写提示词文件，不写 settings/guard/mcp 配置文件。"""
    level, auto, ask = _perm_plan(sess, owner)
    plugin = skills_api.plugin_dir_for(owner)
    return sdk_runner.TurnSpec(
        sid=sess["id"], owner_id=owner["id"], cli_path=claude_bin,
        cwd=sess.get("work_dir") or str(FILE_ROOT),
        add_dirs=list(dict.fromkeys(str(p) for p in extra_dirs)),
        hint_file=str(_hint_file(sess, owner)),
        # 外部服务里的 ask_user / approve 在 sdk 模式下由进程内工具和 can_use_tool 代替，对模型隐藏
        disallowed=["AskUserQuestion", *_deny_rules(owner), "mcp__center__approve", "mcp__center__ask_user"],
        allowed=["mcp__projector__ask_user" if t == "mcp__center__ask_user" else t for t in auto],
        bypass=level == "bypass", ask_rules=ask if level == "standard" else [],
        mcp_center=_mcp_center(sess),
        plugin_dir=str(plugin) if plugin else None,
        resume=sess["claude_session"] or None,
        policy=lambda: guard_policy(owner),
        timeout=TASK_TIMEOUT,
        log_path=str(LOGS / f"claude_{sess['id']}.log"),
    )


def build_command(claude_bin: str, sess: dict, owner: dict, extra_dirs: list[Path]) -> list[str]:
    cmd = [
        claude_bin, "-p",
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        # 提示词写进文件再传：Windows 上 claude 常是 .cmd 包装，中文参数经过 cmd 容易乱码
        "--append-system-prompt-file", str(_hint_file(sess, owner)),
        "--disallowedTools", "AskUserQuestion", *_deny_rules(owner),
    ]
    for d in dict.fromkeys(str(p) for p in extra_dirs):
        cmd += ["--add-dir", d]
    if plugin := skills_api.plugin_dir_for(owner):
        cmd += ["--plugin-dir", str(plugin)]
    # 工具服务（权限确认 + 技能工具）每次都加载，完全放行时也能用技能工具
    mcp_config = DATA / "mcp" / f"{sess['id']}.json"
    mcp_config.write_text(json.dumps({"mcpServers": {"center": _mcp_center(sess)}}), encoding="utf-8")
    cmd += ["--mcp-config", str(mcp_config)]
    settings_data = _guard_settings(sess, owner)   # 三个档位都挂文件隔离钩子（钩子在权限判断之前执行，放行规则挡不住它）
    settings = DATA / "mcp" / f"settings_{sess['id']}.json"
    level, auto, ask = _perm_plan(sess, owner)
    if level == "bypass":
        cmd += ["--permission-mode", "bypassPermissions"]
    else:
        if level == "standard":
            settings_data["permissions"] = {"ask": ask}   # 标准：只有危险命令走确认（ask 规则优先于 allow）
        cmd += ["--permission-prompt-tool", "mcp__center__approve", "--allowedTools", *auto]
    settings.write_text(json.dumps(settings_data, ensure_ascii=False), encoding="utf-8")
    cmd += ["--settings", str(settings)]
    if sess["claude_session"]:
        cmd += ["--resume", sess["claude_session"]]
    return cmd


def run_claude(run: "Run", prompt: str, cmd: list[str], cwd: str, emit) -> dict:
    """在线程里运行 claude，逐行解析 stream-json 事件，通过 emit 回传；返回最终结果。"""
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", cwd=cwd,
        # 等人确认可能要很久，放宽 MCP 工具调用的超时；Windows 上 Python 启动慢，工具服务的启动等待也放宽
        env={**os.environ, "MCP_TOOL_TIMEOUT": str(int(APPROVAL_TIMEOUT * 1000) + 60000), "MCP_TIMEOUT": "60000"},
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    run.proc = proc
    # stderr 要单独读走，否则输出多了会把管道塞满，claude 卡住不动
    err_tail: list[str] = []

    log_path = LOGS / f"claude_{run.sid}.log"
    log = open(log_path, "a", encoding="utf-8", errors="replace")
    log.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} ====\n{' '.join(cmd[:3])} …\n")

    def drain():
        for line in proc.stderr:  # claude 和确认工具的报错都在这里，写进日志方便排查
            err_tail.append(line)
            del err_tail[:-50]
            log.write(line)
            log.flush()
    drainer = threading.Thread(target=drain, daemon=True)
    drainer.start()
    timer = threading.Timer(TASK_TIMEOUT, lambda: (setattr(run, "timed_out", True), _kill_tree(proc)))
    timer.start()
    # 指令走 stdin，避免 Windows 命令行对中文和引号的转义问题
    proc.stdin.write(prompt)
    proc.stdin.close()
    final: dict = {}
    try:
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = ev.get("type")
            if kind == "system" and ev.get("session_id"):
                final["session_id"] = ev["session_id"]
            elif kind == "stream_event":
                inner = ev.get("event", {})
                if inner.get("type") == "message_start":
                    emit({"type": "delta_reset"})
                elif inner.get("type") == "content_block_delta":
                    delta = inner.get("delta", {})
                    if delta.get("type") == "thinking_delta":
                        if delta.get("thinking"):   # 扩展思考：只做实时展示，不入库
                            emit({"type": "thinking", "text": delta["thinking"]})
                    elif delta.get("text"):
                        emit({"type": "delta", "text": delta["text"]})
            elif kind == "user":
                for block in ev.get("message", {}).get("content", []) or []:
                    if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("is_error"):
                        text = json.dumps(block.get("content"), ensure_ascii=False)
                        if "Permission prompt tool" in text and "warn_perm" not in run.warnings:
                            run.warnings.append("warn_perm")
                            log.write("确认通道出错：" + text[:500] + "\n")
            elif kind == "assistant":
                for block in ev.get("message", {}).get("content", []):
                    if block.get("type") == "tool_use":
                        emit({"type": "tool", "name": block.get("name"),
                              "detail": _tool_detail(block.get("input") or {})})
            elif kind == "result":
                final.update(ev)
        proc.wait()
        drainer.join(2)
    finally:
        timer.cancel()
        log.write(f"退出码 {proc.returncode}\n")
        log.close()
    if not final.get("type"):
        err = "".join(err_tail).strip()[-300:]
        final = {**final, "is_error": True, "result": err or f"claude 异常退出（退出码 {proc.returncode}）"}
    return final


# ---------- 会话运行 ----------

class Run:
    def __init__(self, sid: str, owner_id: int):
        self.sid = sid
        self.owner_id = owner_id
        self.proc: subprocess.Popen | None = None
        self.stop_fn = None   # sdk 模式下没有子进程句柄，停止靠它
        self.text = ""
        self.thinking = ""   # 当前这条消息的思考内容，只在实时快照里用，不写进 messages
        self.tools: list[dict] = []
        self.reply = ""
        self.ok = False
        self.stopped = False
        self.timed_out = False
        self.warnings: list[str] = []
        self.done = asyncio.Event()


RUNS: dict[str, Run] = {}


def live_snapshot(run: Run | None) -> dict | None:
    """会话详情里的 live 快照（调用方要和 seq 在 events.lock 里一起取）。"""
    return {"text": run.text, "thinking": run.thinking, "tools": list(run.tools)} if run else None


def _on_event(run: Run, ev: dict) -> None:
    # 改 Run 状态和 broadcast 放在同一把锁里：会话快照（live + seq）也在这把锁里取，
    # 所以快照里的 live 恰好包含 seq 及之前的所有增量，不多不少。
    with events_lock:
        if ev["type"] == "delta_reset":
            run.text = run.thinking = ""
        elif ev["type"] == "delta":
            run.text += ev["text"]
        elif ev["type"] == "thinking":
            run.thinking += ev["text"]
        elif ev["type"] == "tool":
            run.tools.append({"name": ev["name"], "detail": ev["detail"]})
        broadcast({**ev, "session_id": run.sid}, run.owner_id)


def build_prompt(text: str, refs: list[str], skill: str) -> str:
    head = []
    if skill:
        head.append(f"【请使用技能】{skills_api.PLUGIN_NAME}:{skill}（用 Skill 工具调用它来完成这次任务）")
    if refs:
        head.append("【用户引用的文件/文件夹】\n" + "\n".join(f"- {r}" for r in refs))
    return ("\n\n".join(head) + "\n\n" + text) if head else text


def _begin_turn(sess: dict, text: str, author: dict, refs: list[str] | None = None, skill: str = "",
                action: str = "") -> Run:
    """立刻开始一轮（同步函数、中间没有 await：登记 RUNS 和启动任务之间不会被别的协程插进来）。必须在事件循环线程里调用。"""
    claude_bin = find_claude()
    if not claude_bin:
        raise HTTPException(500, "台式机上找不到 claude 命令：请先安装 Claude Code，或在 config.bat 里设置 CLAUDE_BIN")
    sid = sess["id"]
    if sid in RUNS:
        raise HTTPException(409, "这个会话还有任务在进行，请等它完成或先停止")
    sdk_mode = runner_mode() == "sdk"
    if sdk_mode and (reason := sdk_runner.availability()):
        raise HTTPException(500, sdk_runner.unavailable_message(reason))   # 放在登记 RUNS 之前，不留残余状态
    owner = get_user(sess["user_id"]) or author
    refs = refs or []
    cwd = sess.get("work_dir") or str(FILE_ROOT)
    if not Path(cwd).is_dir():
        raise HTTPException(400, f"工作文件夹不存在：{cwd}")
    ws = session_workspace(sess, create=False)  # 工作区用到时才建，免得 D 盘里堆满空文件夹
    extra = ([ws] if ws and ws.exists() else []) + [KB_ROOT]
    for r in refs:
        p = Path(r)
        extra.append(p if p.is_dir() else p.parent)
    # 文件隔离：工作目录和要加进 --add-dir 的目录不能是别人的工作区、工作区根本身、回收站或系统数据（放在登记 RUNS 之前）
    policy = guard_policy(owner)
    for d in [cwd, *extra]:
        if guard.check_path(policy, str(d), cwd):
            raise HTTPException(403, f"不能使用这个文件夹：{d}。它是其他人的个人工作区、工作区根目录、回收站或系统数据，请换一个文件夹")
    run = RUNS[sid] = Run(sid, sess["user_id"])
    meta = {"author": author["display_name"], "bypass": bool(sess["bypass"])}
    if refs:
        meta["refs"] = refs
    if skill:
        meta["skill"] = skill
    if action:
        meta["kb"] = action
    try:
        db("INSERT OR REPLACE INTO active_runs (session_id, user_id, started) VALUES (?,?,?)",
           (sid, sess["user_id"], time.time()))
        add_message(sid, "user", text, meta)
        if sdk_mode:
            cmd, spec = [], build_sdk_spec(claude_bin, sess, owner, extra)
            run.stop_fn = lambda: sdk_runner.request_stop(sid)
        else:
            cmd, spec = build_command(claude_bin, sess, owner, extra), None
        action_text = KB_ACTIONS[action][1] if action else text
        if action:
            sec = sections.active_name_for_session(db("SELECT section_id FROM sessions WHERE id=?", (sid,), one=True))
            if sec:
                action_text += (f"\n\n（这个会话属于“{sec}”分区。分区由系统按会话自动补到笔记上，"
                                "kb_write 的 section 参数留空，不要自己填。）")
        prompt = build_prompt(action_text, refs, skill)
    except Exception:
        RUNS.pop(sid, None)  # 任何一步失败都要清掉，否则会话一直显示“进行中”
        _clear_active(sid)
        raise
    if spec:
        asyncio.create_task(_drive(run, prompt, cmd, cwd, spec))
    else:
        asyncio.create_task(_drive(run, prompt, cmd, cwd))
    return run


async def start_turn(sess: dict, text: str, author: dict, refs: list[str] | None = None, skill: str = "",
                     action: str = "") -> Run:
    return _begin_turn(sess, text, author, refs, skill, action)


# ---------- 排队：全局并发上限 + 每个会话的待发队列 ----------

QUEUE_CAP = 5   # 每个会话最多排几条
DEFAULT_MAX_CONCURRENT = 3


def max_concurrent() -> int:
    """同时运行的 Claude 进程数上限：管理员设置 > 环境变量 MAX_CONCURRENT > 3；限制在 1~16。"""
    try:
        default = int(os.environ.get("MAX_CONCURRENT") or DEFAULT_MAX_CONCURRENT)
    except ValueError:
        default = DEFAULT_MAX_CONCURRENT
    try:
        n = int(get_setting("max_concurrent", default))
    except (TypeError, ValueError):
        n = default
    return max(1, min(16, n))


def _clear_active(sid: str) -> None:
    try:
        db("DELETE FROM active_runs WHERE session_id=?", (sid,))
    except Exception:
        usage.log_failure(sid, "active_runs")


def queue_of(sid: str) -> list[dict]:
    return db("SELECT * FROM turn_queue WHERE session_id=? ORDER BY created, id", (sid,))


def clear_queue(sid: str) -> list[dict]:
    """清空某个会话的队列，返回被清掉的条目（调用方负责把文字记进会话，免得用户打的字悄悄丢了）。"""
    rows = queue_of(sid)
    if rows:
        db("DELETE FROM turn_queue WHERE session_id=?", (sid,))
    return rows


def cancelled_note(rows: list[dict], why: str) -> str:
    return f"{why}，排队中的 {len(rows)} 条消息已取消，内容如下：\n" + "\n".join(f"{i}. {r['text']}" for i, r in enumerate(rows, 1))


def submit_turn(sess: dict, text: str, author: dict, refs: list[str] | None = None, skill: str = "",
                action: str = "") -> dict:
    """发消息的统一入口（必须在事件循环线程里调用）：有空位就立刻开始，否则排队。
    返回 {"queued": False, "run": Run} 或 {"queued": True, "queue_id": 条目 id, "position": 在本会话队列里的第几位}。"""
    sid = sess["id"]
    waiting = queue_of(sid)
    if sid not in RUNS and len(RUNS) < max_concurrent() and not waiting:
        return {"queued": False, "run": _begin_turn(sess, text, author, refs, skill, action)}
    if len(waiting) >= QUEUE_CAP:
        raise HTTPException(409, f"这个会话已经排了 {QUEUE_CAP} 条消息，请等前面的完成，或先取消几条")
    qid = db_insert("INSERT INTO turn_queue (session_id, author_id, text, refs, skill, action, created) VALUES (?,?,?,?,?,?,?)",
                    (sid, author["id"], text, jdump(refs or []), skill or "", action or "", time.time()))
    push_session(sid)
    dispatch_queue()
    return {"queued": True, "queue_id": qid, "position": len(waiting) + 1}


def dispatch_queue() -> None:
    """有空位就从队列里取最早的、所在会话没在运行的一条开始。整个函数没有 await，读队列、删条目、登记 RUNS 一气呵成，
    所以两个任务同时结束也不会重复启动同一条或超过上限。必须在事件循环线程里调用。"""
    while len(RUNS) < max_concurrent():
        item = next((r for r in db("SELECT * FROM turn_queue ORDER BY created, id") if r["session_id"] not in RUNS), None)
        if not item:
            return
        db("DELETE FROM turn_queue WHERE id=?", (item["id"],))
        sid = item["session_id"]
        sess = db("SELECT * FROM sessions WHERE id=?", (sid,), one=True)
        if not sess:
            continue   # 会话已经被删了，这条直接丢掉
        try:
            author = get_user(item["author_id"]) or get_user(sess["user_id"])
            if not author:
                raise HTTPException(400, "找不到发这条消息的账号")
            _begin_turn(sess, item["text"], author, json.loads(item["refs"] or "[]"), item["skill"] or "", item["action"] or "")
        except Exception as e:
            reason = e.detail if isinstance(e, HTTPException) else str(e)
            try:
                add_message(sid, "error", f"排队的消息没能开始：{reason}\n\n{item['text']}", {"error": True, "queued_failed": True})
            except Exception:
                usage.log_failure(sid, "dispatch")


def recover_runs() -> int:
    """启动时调用一次：上次进程退出时还在跑的轮次，记一条中断消息、清掉它们的队列。
    没在运行的会话里排着的消息保持不动，事件循环起来后由 dispatch_queue 接着开始。可重复调用。"""
    rows = db("SELECT * FROM active_runs")
    for r in rows:
        sid = r["session_id"]
        if db("SELECT 1 FROM sessions WHERE id=?", (sid,), one=True):
            # 上次恢复到一半又崩了的话，这条已经写过：最后一条消息就是它时不再重复
            last = db("SELECT meta FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1", (sid,), one=True)
            if not (last and '"interrupted"' in (last["meta"] or "")):
                add_message(sid, "error", "服务重启，这一轮被中断了，请重新发送。", {"interrupted": True})
        db("DELETE FROM active_runs WHERE session_id=?", (sid,))
        dropped = clear_queue(sid)
        if dropped and db("SELECT 1 FROM sessions WHERE id=?", (sid,), one=True):
            add_message(sid, "event", cancelled_note(dropped, "服务重启"), {"queue_cancelled": True})
    return len(rows)


async def _drive(run: Run, prompt: str, cmd: list[str], cwd: str, spec=None) -> None:
    loop = asyncio.get_running_loop()

    def emit(ev):
        loop.call_soon_threadsafe(_on_event, run, ev)

    started = time.time()
    if spec is not None:
        try:
            final = await sdk_runner.run_turn(run, prompt, spec, lambda ev: _on_event(run, ev))
        except Exception as e:
            final = {"is_error": True, "result": f"sdk 运行出错：{e}。" + sdk_runner.UNAVAILABLE_HINT}
    else:
        try:
            final = await asyncio.to_thread(run_claude, run, prompt, cmd, cwd, emit)
        except Exception as e:
            final = {"is_error": True, "result": f"启动 claude 失败：{e}"}
    await asyncio.sleep(0)  # 让线程里排队的事件先处理完
    try:
        if final.get("session_id"):
            db("UPDATE sessions SET claude_session=? WHERE id=?", (final["session_id"], run.sid))

        meta = {"tools": run.tools, "seconds": round(time.time() - started), "cost": final.get("total_cost_usd")}
        msg = None
        if run.stopped:
            run.reply = "已停止。"
            msg = add_message(run.sid, "error", run.reply + (f"\n\n{run.text}" if run.text else ""),
                              {**meta, "stopped": True})
        elif run.timed_out:
            run.reply = f"超过 {int(TASK_TIMEOUT // 60)} 分钟没完成，已停止。"
            msg = add_message(run.sid, "error", run.reply, {**meta, "timed_out": True})
        elif final.get("is_error"):
            run.reply = f"出错了：{final.get('result') or final.get('subtype')}"
            msg = add_message(run.sid, "error", run.reply, {**meta, "error": True})
        else:
            run.ok = True
            run.reply = final.get("result") or run.text
            msg = add_message(run.sid, "assistant", run.reply, meta)

        try:
            if msg:
                usage.record_turn(run.sid, run.owner_id, msg["id"], final)
        except Exception:  # record_turn 自己也会兜底，这里再保一层
            usage.log_failure(run.sid, "record_turn")

        if "warn_perm" in run.warnings:  # 独立调用，不要覆盖 msg
            add_message(run.sid, "event", "⚠ 这一轮里权限确认通道出了故障，需要确认的操作没有执行。重发一次通常就好；"
                                          f"反复出现请把 data/logs/claude_{run.sid}.log 发给管理员。")
    except Exception:
        usage.log_failure(run.sid, "drive")
    finally:
        # 无论上面哪一步失败，都必须清掉 RUNS，否则会话会一直显示“进行中”
        try:
            for a in pending_for(run.sid) + questions_for(run.sid):
                if not a["future"].done():
                    a["future"].set_result((False, "任务已结束"))
        finally:
            RUNS.pop(run.sid, None)
            _clear_active(run.sid)
            run.done.set()
            push_session(run.sid)
            try:
                dispatch_queue()   # 空出一个位置：让排队的下一条开始
            except Exception:
                usage.log_failure(run.sid, "dispatch")


@router.post("/api/sessions/{sid}/stop")
async def stop_session(sid: str, user: dict = Depends(current_user)):
    session_for(sid, user)
    dropped = clear_queue(sid)   # 先清队列：这一轮一结束，dispatch_queue 就不会把排队的接着开始
    if dropped:
        add_message(sid, "event", cancelled_note(dropped, "已停止"), {"queue_cancelled": True})
    run = RUNS.get(sid)
    if run and (run.proc or run.stop_fn):
        run.stopped = True
        for a in pending_for(sid) + questions_for(sid):
            if not a["future"].done():
                a["future"].set_result((False, "用户停止了任务"))
        if run.stop_fn:
            run.stop_fn()
        else:
            _kill_tree(run.proc)
    return {"ok": True}


@router.delete("/api/sessions/{sid}/queue/{qid}")
async def cancel_queued(sid: str, qid: int, user: dict = Depends(current_user)):
    session_for(sid, user)   # 会话主人和管理员可以取消
    row = db("SELECT text FROM turn_queue WHERE id=? AND session_id=?", (qid, sid), one=True)
    if not row:
        raise HTTPException(404, "这条排队的消息已经开始或已被取消")
    db("DELETE FROM turn_queue WHERE id=?", (qid,))
    # 和“停止”“服务重启”一样留一条记录，写明是谁取消的、原文是什么，免得消息悄悄消失
    add_message(sid, "event", f"{user['display_name']} 取消了一条排队中的消息：\n{row['text']}", {"queue_cancelled": True})
    dispatch_queue()
    return {"ok": True}


async def sdk_close_session(sid: str) -> None:
    """会话被删时关掉它的 sdk 常驻客户端；失败只记日志，不影响删除。"""
    try:
        await sdk_runner.close_session(sid)
    except Exception:
        usage.log_failure(sid, "sdk_close")
