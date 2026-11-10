"""文件隔离（软隔离）：guard.py 的路径/命令检查、PreToolUse 钩子入口、runner 的 --settings 与目录检查、确认前的兜底检查。
新增用例请放在对应的分节注释下面。"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import approvals
import guard
import runner
import store

import server  # noqa: E402  (conftest 已先设好临时目录)

GUARD_PY = Path(__file__).resolve().parent.parent / "guard.py"

# ======================================================================
# 一、guard：Windows 风格策略
# ======================================================================

WIN = guard.Policy(
    ws_root="D:\\Projector工作区",
    own=["D:\\Projector工作区\\张三(zhang)"],
    forbidden=["D:\\Projector\\data\\center.db", "D:\\Projector\\data\\mcp", "D:\\Projector\\data\\preview"],
    other_names=["李四(li)"],
)
WIN_CWD = "D:\\"
OWN_CWD = "D:\\Projector工作区\\张三(zhang)"

WIN_DENY = [
    # cd 带通配符正好能进到工作区根；cmd /c 包着的递归扫描
    "cd Proj* && ls",
    "cd D:/P*/ ; cat */*",
    "cmd /c dir /s D:\\",
    # 直接点名别人的文件：各种写法
    'cat "D:/Projector工作区/李四(li)/工资.xlsx"',
    'cat "D:\\Projector工作区\\李四(li)\\工资.xlsx"',
    'cat "d:/projector工作区/李四(li)/工资.xlsx"',
    'cat /d/Projector工作区/李四(li)/工资.xlsx',
    'cat //d/Projector工作区/李四(li)/工资.xlsx',
    'cat /mnt/d/Projector工作区/李四(li)/工资.xlsx',
    'cat /cygdrive/d/Projector工作区/李四(li)/工资.xlsx',
    'type D:\\Projector工作区\\李四(li)\\工资.xlsx',
    'Get-Content "D:\\Projector工作区\\李四(li)\\工资.xlsx"',
    # 相对路径
    'cat Projector工作区/李四(li)/工资.xlsx',
    'cat "Projector工作区\\李四(li)\\工资.xlsx"',
    # 回收站和工作区根本身
    'ls "D:/Projector工作区/回收站"',
    'ls D:/Projector工作区',
    # cd 之后再读
    'cd Projector工作区 && cat */*',
    'cd "D:/Projector工作区/李四(li)" && cat 工资.xlsx',
    'cd Projector工作区; ls',
    'Set-Location D:\\Projector工作区; Get-ChildItem',
    # 系统数据
    'cat D:/Projector/data/center.db',
    'sqlite3 D:\\Projector\\data\\center.db "select * from users"',
    'cat /d/projector/data/mcp/1.json',
    # 通配符
    'cat */*/*.xlsx',
    'cat D:/*/*/*.xlsx',
    'cat D:/Proj*/*/x',
    'cat D:/**/*.xlsx',
    # 递归扫描上级目录
    'grep -r 工资 .',
    'grep -rn 工资',
    'grep -R 工资 D:/',
    'grep --recursive 工资 .',
    'find . -name "*.xlsx"',
    'find D:\\ -name "*.xlsx"',
    'rg 工资',
    'tree',
    'tree D:/',
    'ls -R',
    'du -sh .',
    'dir /s',
    'dir /s D:\\',
    'findstr /s 工资 *.txt',
    'Get-ChildItem -Recurse D:\\',
    'gci -r',
    'Get-ChildItem D:\\ -Recurse | Select-String 工资',
    'cp -r * 备份/',
    'xcopy D:\\ E:\\x /e',
    'robocopy D:\\ E:\\x /MIR',
    'rsync -a D:/ /tmp/x',
    'zip -r all.zip .',
    'powershell -Command "Get-ChildItem -Recurse D:\\"',
    'bash -c "grep -r 工资 ."',
]

WIN_ALLOW = [
    "cd 合同* && ls",
    "cmd /c dir /b",
    # 自己的工作区
    f'cat "{OWN_CWD}\\a.txt"',
    'cat "D:/Projector工作区/张三(zhang)/2026-03 报表/a.txt"',
    'cat /d/Projector工作区/张三(zhang)/a.txt',
    'cd "D:/Projector工作区/张三(zhang)" && ls',
    'grep -r x "D:/Projector工作区/张三(zhang)"',
    # 文件库里的普通文件夹
    'cat 合同/a.txt',
    'ls 合同',
    'grep -r x 合同/',
    'find 合同 -name "*.xlsx"',
    'cat 合同/*.txt',
    'cat *.txt',
    'cp -r *.txt 备份/',
    'tar -xf 文件.zip',
    # 普通命令
    'ls',
    'ls -lrt',
    'ls ..',
    'git status',
    'git diff HEAD~1',
    'python a.py',
    'echo hello && pwd',
    'python -c "print(1)"',
]


@pytest.mark.parametrize("cmd", WIN_DENY)
def test_win_command_denied(cmd):
    assert guard.check_command(WIN, cmd, WIN_CWD), cmd


@pytest.mark.parametrize("cmd", WIN_ALLOW)
def test_win_command_allowed(cmd):
    assert guard.check_command(WIN, cmd, WIN_CWD) is None, cmd


@pytest.mark.parametrize("cmd", [
    "ls ..", "cat ../*/*.xlsx", "cd .. ; ls", "cd .. && cat */*", "cat ../李四(li)/a.xlsx", "ls ../*",
    "find ..", "grep -r x ../..",
])
def test_win_from_own_workspace(cmd):
    """在自己的工作区里往上走"""
    assert guard.check_command(WIN, cmd, OWN_CWD), cmd


@pytest.mark.parametrize("cmd", ["ls", "cat a.txt", "ls 子文件夹", "grep -r x .", "find . -name '*.py'", "cat ./a.txt"])
def test_win_own_workspace_allowed(cmd):
    assert guard.check_command(WIN, cmd, OWN_CWD) is None, cmd


def test_win_check_path():
    for p in ["D:\\Projector工作区\\李四(li)\\a.xlsx", "d:/projector工作区/李四(li)", "/d/Projector工作区",
              "/mnt/d/Projector工作区/回收站/x", "D:/Projector工作区", "D:\\Projector\\data\\center.db",
              "D:/Projector/data/mcp/x.json", "D:/projector工作区/张三(zhang)/../李四(li)/a"]:
        assert guard.check_path(WIN, p, WIN_CWD), p
    for p in ["D:\\Projector工作区\\张三(zhang)", "d:/projector工作区/张三(zhang)/a/../b.txt", "D:\\", "D:/合同/a.txt",
              "/d/合同/a.txt", "D:\\Projector\\data"]:
        assert guard.check_path(WIN, p, WIN_CWD) is None, p
    assert guard.check_path(WIN, "../李四(li)/a.xlsx", OWN_CWD)
    assert guard.check_path(WIN, "a.txt", OWN_CWD) is None
    assert guard.check_path(WIN, "..", OWN_CWD)   # 工作区根本身


def test_win_reason_is_chinese_and_useful():
    r = guard.check_command(WIN, "cat D:/Projector工作区/李四(li)/a", WIN_CWD)
    assert "其他用户" in r and "不要换别的方式重试" in r
    r = guard.check_command(WIN, "grep -r x .", WIN_CWD)
    assert "递归" in r and "Glob" in r


def test_win_tools():
    cases_deny = [
        ("Read", {"file_path": "D:\\Projector工作区\\李四(li)\\a.xlsx"}),
        ("Edit", {"file_path": "d:/projector工作区/李四(li)/a.xlsx"}),
        ("Write", {"file_path": "/d/Projector工作区/李四(li)/new.txt"}),
        ("NotebookEdit", {"notebook_path": "D:/Projector工作区/李四(li)/a.ipynb"}),
        ("Grep", {"pattern": "x", "path": "D:/Projector工作区/李四(li)"}),
        ("Glob", {"pattern": "*.xlsx", "path": "D:/Projector工作区"}),
        ("Glob", {"pattern": "D:/Projector工作区/李四(li)/*.xlsx"}),
        ("Glob", {"pattern": "Projector工作区/*/*.xlsx"}),
        ("Grep", {"pattern": "x", "glob": "Projector工作区/李四(li)/**"}),
        ("mcp__center__read_document", {"path": "D:\\Projector工作区\\李四(li)\\工资.xlsx"}),
        ("mcp__center__skill_submit", {"path": "D:\\Projector\\data\\center.db"}),
        ("Bash", {"command": "cat Projector工作区/李四(li)/a"}),
        ("PowerShell", {"command": "Get-Content D:\\Projector工作区\\李四(li)\\a"}),
    ]
    for name, inp in cases_deny:
        assert guard.check_tool(WIN, name, inp, WIN_CWD), (name, inp)
    cases_allow = [
        ("Read", {"file_path": "D:\\Projector工作区\\张三(zhang)\\a.txt"}),
        ("Read", {"file_path": "D:\\合同\\a.txt"}),
        ("Grep", {"pattern": "工资/奖金"}),                    # 省略 path 不查；pattern 是正则
        ("Grep", {"pattern": "x", "path": "D:\\"}),            # 上级目录本身不拒绝（那层靠 Read 的 deny 规则）
        ("Glob", {"pattern": "**/*.xlsx"}),
        ("Glob", {"pattern": "合同/*.xlsx", "path": "D:\\"}),
        ("mcp__center__read_document", {"path": "D:\\合同\\a.xlsx", "offset": 0}),
        ("mcp__center__kb_search", {"query": "李四"}),
        ("Bash", {"command": "git status"}),
    ]
    for name, inp in cases_allow:
        assert guard.check_tool(WIN, name, inp, WIN_CWD) is None, (name, inp)


# ======================================================================
# 二、guard：POSIX 风格策略（macOS / Linux 路径）
# ======================================================================

@pytest.fixture
def posix(tmp_path):
    root = tmp_path / "files"
    ws = root / "Projector工作区"
    (ws / "张三(zhang)").mkdir(parents=True)
    (ws / "李四(li)").mkdir()
    (root / "合同").mkdir()
    data = tmp_path / "data"
    pol = guard.Policy(ws_root=str(ws), own=[str(ws / "张三(zhang)")], forbidden=[str(data / "center.db"), str(data / "mcp")],
                       other_names=["李四(li)"])
    return pol, root, ws, data


def test_posix_policy(posix):
    pol, root, ws, data = posix
    deny = [f'cat "{ws}/李四(li)/a.xlsx"', f"cat {ws}", f"ls {ws}/回收站", "cat Projector工作区/李四(li)/a.xlsx",
            "cd Projector工作区 && cat */*", f"cat {data}/center.db", "grep -r 工资 .", "find . -name '*.xlsx'", "ls -R",
            "cat */*/*.xlsx", f"cat {ws}/张三(zhang)/../李四(li)/a", "cd Projector工作区; ls", f"grep -r x {root}"]
    for c in deny:
        assert guard.check_command(pol, c, str(root)), c
    allow = [f'cat "{ws}/张三(zhang)/a.txt"', "cat 合同/a.txt", "grep -r x 合同/", "ls", "git status", "python a.py",
             "find 合同 -name '*.x'", "cat *.txt", f"cd {ws}/张三(zhang) && ls"]
    for c in allow:
        assert guard.check_command(pol, c, str(root)) is None, c
    own = str(ws / "张三(zhang)")
    for c in ["ls ..", "cat ../*/*.xlsx", "cd .. ; ls", "cat ../李四(li)/a"]:
        assert guard.check_command(pol, c, own), c
    assert guard.check_command(pol, "ls", own) is None


def test_posix_slash_d_not_treated_as_drive(posix):
    """macOS 上 /d/… 不是盘符：根不是盘符路径时不做映射"""
    pol, root, ws, data = posix
    assert guard.check_path(pol, "/d/Projector工作区/李四(li)/a", str(root)) is None
    assert guard.check_path(pol, "/mnt/d/x", str(root)) is None
    assert guard.check_path(pol, str(ws / "李四(li)" / "a"), str(root))


def test_posix_tools(posix):
    pol, root, ws, data = posix
    assert guard.check_tool(pol, "Read", {"file_path": str(ws / "李四(li)" / "a.xlsx")}, str(root))
    assert guard.check_tool(pol, "Read", {"file_path": str(ws / "张三(zhang)" / "a.xlsx")}, str(root)) is None
    assert guard.check_tool(pol, "Glob", {"pattern": "*/*.xlsx", "path": str(ws)}, str(root))
    assert guard.check_tool(pol, "Grep", {"pattern": "x", "path": str(root)}, str(root)) is None


# ======================================================================
# 三、PreToolUse 钩子入口：python guard.py <策略文件>
# ======================================================================

def run_hook(policy_file, payload):
    return subprocess.run([sys.executable, str(GUARD_PY), str(policy_file)], input=json.dumps(payload).encode("utf-8"),
                          capture_output=True, timeout=30)


@pytest.fixture
def win_policy_file(tmp_path):
    f = tmp_path / "guard.json"
    f.write_text(WIN.dumps(), encoding="utf-8")
    return f


def test_hook_blocks_with_exit_2(win_policy_file):
    p = run_hook(win_policy_file, {"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": WIN_CWD,
                                   "tool_input": {"command": "cat D:/Projector工作区/李四(li)/工资.xlsx"}})
    assert p.returncode == 2
    assert "其他用户" in p.stderr.decode("utf-8") and p.stdout == b""
    p = run_hook(win_policy_file, {"tool_name": "Read", "cwd": WIN_CWD, "tool_input": {"file_path": "D:\\Projector\\data\\center.db"}})
    assert p.returncode == 2


def test_hook_allows_with_exit_0(win_policy_file):
    p = run_hook(win_policy_file, {"tool_name": "Bash", "cwd": WIN_CWD, "tool_input": {"command": "git status"}})
    assert p.returncode == 0 and p.stdout == b"" and p.stderr == b""
    p = run_hook(win_policy_file, {"tool_name": "Read", "cwd": WIN_CWD,
                                   "tool_input": {"file_path": "D:\\Projector工作区\\张三(zhang)\\a.txt"}})
    assert p.returncode == 0


def test_hook_errors_are_denials(tmp_path, win_policy_file):
    payload = {"tool_name": "Bash", "cwd": WIN_CWD, "tool_input": {"command": "git status"}}
    p = run_hook(tmp_path / "不存在.json", payload)
    assert p.returncode == 2 and "隔离检查出错" in p.stderr.decode("utf-8")
    bad = tmp_path / "bad.json"
    bad.write_text("{不是 json", encoding="utf-8")
    assert run_hook(bad, payload).returncode == 2
    p = subprocess.run([sys.executable, str(GUARD_PY), str(win_policy_file)], input=b"not json", capture_output=True, timeout=30)
    assert p.returncode == 2 and "隔离检查出错" in p.stderr.decode("utf-8")
    p = subprocess.run([sys.executable, str(GUARD_PY)], input=b"{}", capture_output=True, timeout=30)
    assert p.returncode == 2


# ======================================================================
# 四、runner：guard_policy / build_command / _begin_turn
# ======================================================================

@pytest.fixture
def two_users(make_user):
    a = make_user("zhang", display_name="张三")
    b = make_user("li", display_name="李四")
    ua, ub = store.get_user(a["id"]), store.get_user(b["id"])
    return a, b, ua, ub


def _sess(user, **kw):
    row = {"id": "s" + str(user["id"]) + "x", "user_id": user["id"], "bypass": 0, "claude_session": None, "work_dir": None}
    row.update(kw)
    return row


def test_guard_policy_contents(two_users):
    a, b, ua, ub = two_users
    pol = runner.guard_policy(ua)
    assert pol.ws_root == str(store.WS_ROOT)
    assert pol.own == [str(store.user_ws_dir(ua, create=False))]
    assert store.user_ws_dir(ub, create=False).name in pol.other_names
    assert store.user_ws_dir(ua, create=False).name not in pol.other_names
    assert str(store.DATA / "center.db") in pol.forbidden and str(store.DATA / "preview") in pol.forbidden
    assert not any(Path(f).is_relative_to(store.WS_ROOT) for f in pol.forbidden)   # 回收站由 ws_root 规则管
    # 自己的工作区放行，别人的拒绝
    assert guard.check_path(pol, str(store.user_ws_dir(ua, create=False) / "a.txt"), str(store.FILE_ROOT)) is None
    assert guard.check_path(pol, str(store.user_ws_dir(ub, create=False) / "a.txt"), str(store.FILE_ROOT))
    assert guard.check_path(pol, str(store.TRASH), str(store.FILE_ROOT))


def test_deny_rules_still_generated(two_users):
    a, b, ua, ub = two_users
    rules = runner._deny_rules(ua)
    other = store.posix_rule_path(store.user_ws_dir(ub, create=False))
    assert f"Read({other}/**)" in rules and f"Write({other}/**)" in rules
    assert any("preview" in r for r in rules)


@pytest.fixture
def admin_user(make_user):
    u = make_user("boss", role="admin")
    return store.get_user(u["id"])


def _hook_cmd(settings):
    hooks = settings["hooks"]["PreToolUse"]
    assert hooks[0]["matcher"] == "*"
    return hooks[0]["hooks"][0]


@pytest.mark.parametrize("mode", ["standard", "strict", "bypass"])
def test_build_command_has_guard_hook(two_users, admin_user, monkeypatch, mode):
    a, b, ua, ub = two_users
    owner, sess = ua, _sess(ua)
    if mode == "strict":
        monkeypatch.setattr(runner, "perm_mode", lambda: "strict")
    elif mode == "bypass":
        owner, sess = admin_user, _sess(admin_user, bypass=1)
    cmd = runner.build_command("claude", sess, owner, [])
    assert "--settings" in cmd
    settings_path = Path(cmd[cmd.index("--settings") + 1])
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    h = _hook_cmd(settings)
    assert h["type"] == "command" and h["timeout"] > 0
    policy_file = store.DATA / "mcp" / f"guard_{sess['id']}.json"
    assert h["command"] == f'"{Path(sys.executable).as_posix()}" "{(store.BASE / "guard.py").as_posix()}" "{policy_file.as_posix()}"'
    assert "\\" not in h["command"]
    pol = json.loads(policy_file.read_text(encoding="utf-8"))
    mine = store.user_ws_dir(owner, create=False)
    assert pol["own"] == [str(mine)] and pol["ws_root"] == str(store.WS_ROOT)
    assert mine.name not in pol["other_names"]
    others = [store.user_ws_dir(u, create=False).name for u in store.db("SELECT * FROM users WHERE id != ?", (owner["id"],))]
    assert others and all(n in pol["other_names"] for n in others)
    # 权限档位本身的行为不变
    if mode == "bypass":
        assert "bypassPermissions" in cmd and "permissions" not in settings
    else:
        assert "--permission-prompt-tool" in cmd
    if mode == "standard":
        assert settings["permissions"]["ask"]   # 标准档原有的 ask 规则还在同一个文件里


@pytest.mark.parametrize("mode", ["standard", "strict"])
def test_hook_script_runs_against_written_policy(two_users, monkeypatch, mode):
    """按 build_command 写出的钩子命令里的策略文件，真的去跑 guard.py"""
    a, b, ua, ub = two_users
    if mode == "strict":
        monkeypatch.setattr(runner, "perm_mode", lambda: "strict")
    sess = _sess(ua)
    runner.build_command("claude", sess, ua, [])
    pf = store.DATA / "mcp" / f"guard_{sess['id']}.json"
    other = store.user_ws_dir(ub, create=False)
    p = run_hook(pf, {"tool_name": "Bash", "cwd": str(store.FILE_ROOT), "tool_input": {"command": f'cat "{other}/工资.xlsx"'}})
    assert p.returncode == 2
    p = run_hook(pf, {"tool_name": "Bash", "cwd": str(store.FILE_ROOT), "tool_input": {"command": "git status"}})
    assert p.returncode == 0


class Env:
    def __init__(self, client):
        self.c = client

    def begin(self, sess, text="hi", refs=None):
        async def w():
            return runner._begin_turn(sess, text, store.get_user(sess["user_id"]), refs or [])
        return self.c.portal.call(w)


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(runner, "run_claude", lambda run, prompt, cmd, cwd, emit: {"result": "ok"})
    monkeypatch.setattr(runner, "find_claude", lambda: "claude")
    runner.RUNS.clear()
    with TestClient(server.app) as c:
        yield Env(c)
        while runner.RUNS:
            c.portal.call(next(iter(runner.RUNS.values())).done.wait)


def _new_session(env, user, work_dir=None):
    sid = env.c.post("/api/sessions", json={}, headers=user["headers"]).json()["id"]
    if work_dir:
        store.db("UPDATE sessions SET work_dir=? WHERE id=?", (str(work_dir), sid))
    return store.db("SELECT * FROM sessions WHERE id=?", (sid,), one=True)


def test_begin_turn_rejects_other_workspace_as_cwd(env, two_users):
    a, b, ua, ub = two_users
    other = store.user_ws_dir(ub)
    sess = _new_session(env, a, other)
    with pytest.raises(HTTPException) as e:
        env.begin(sess)
    assert e.value.status_code == 403 and "工作区" in e.value.detail
    assert sess["id"] not in runner.RUNS   # 没有留下登记
    assert store.db("SELECT 1 FROM active_runs WHERE session_id=?", (sess["id"],), one=True) is None


@pytest.mark.parametrize("where", ["root", "trash", "other_sub"])
def test_begin_turn_rejects_ws_root_trash_and_other_subfolder(env, two_users, where):
    a, b, ua, ub = two_users
    sub = store.user_ws_dir(ub) / "子文件夹"
    sub.mkdir(exist_ok=True)
    store.TRASH.mkdir(exist_ok=True)
    wd = {"root": store.WS_ROOT, "trash": store.TRASH, "other_sub": sub}[where]
    sess = _new_session(env, a, wd)
    with pytest.raises(HTTPException) as e:
        env.begin(sess)
    assert e.value.status_code == 403
    assert sess["id"] not in runner.RUNS


def test_begin_turn_rejects_other_workspace_ref(env, two_users):
    a, b, ua, ub = two_users
    other = store.user_ws_dir(ub)
    (other / "工资.xlsx").write_text("x")
    sess = _new_session(env, a)
    with pytest.raises(HTTPException) as e:
        env.begin(sess, refs=[str(other / "工资.xlsx")])
    assert e.value.status_code == 403
    assert sess["id"] not in runner.RUNS
    with pytest.raises(HTTPException) as e:
        env.begin(sess, refs=[str(other)])
    assert e.value.status_code == 403


def test_begin_turn_allows_own_workspace_and_file_library(env, two_users):
    a, b, ua, ub = two_users
    own = store.user_ws_dir(ua)
    (own / "a.txt").write_text("x")
    lib = store.FILE_ROOT / "合同"
    lib.mkdir(exist_ok=True)
    (lib / "c.txt").write_text("x")
    for wd, refs in [(own, [str(own / "a.txt")]), (store.FILE_ROOT, [str(lib / "c.txt")]), (store.FILE_ROOT, [])]:
        sess = _new_session(env, a, wd)
        run = env.begin(sess, refs=refs)
        env.c.portal.call(run.done.wait)
        assert sess["id"] not in runner.RUNS


def test_send_message_api_rejects_other_workspace_ref(env, two_users):
    """走完整接口：别人的工作区文件夹被 files_api 或 runner 拒绝，不会开始一轮"""
    a, b, ua, ub = two_users
    other = store.user_ws_dir(ub)
    sess = _new_session(env, a)
    r = env.c.post(f"/api/sessions/{sess['id']}/messages", json={"text": "读一下", "refs": [str(other)]}, headers=a["headers"])
    assert r.status_code in (403, 404)
    assert sess["id"] not in runner.RUNS


# ======================================================================
# 五、approvals.request_approval：钩子之外的第二道
# ======================================================================

def test_request_approval_auto_denies_other_workspace(env, two_users):
    a, b, ua, ub = two_users
    sess = _new_session(env, a)
    other = store.user_ws_dir(ub)
    # 假装这一轮正在运行（approval 接口要求会话在 RUNS 里）
    async def reg():
        runner.RUNS[sess["id"]] = runner.Run(sess["id"], a["id"])
    env.c.portal.call(reg)
    try:
        h = {"Authorization": f"Bearer {store.INTERNAL_TOKEN}"}
        r = env.c.post("/api/approvals", json={"session_id": sess["id"], "tool_name": "Bash",
                                               "input": {"command": f'cat "{other}/工资.xlsx"'}}, headers=h)
        assert r.status_code == 200
        body = r.json()
        assert body["allow"] is False and "其他用户" in body["message"]
        assert not approvals.pending_for(sess["id"])
        msgs = store.db("SELECT * FROM messages WHERE session_id=? AND role='event'", (sess["id"],))
        assert any("已自动拒绝" in m["content"] and "工资.xlsx" in m["content"] for m in msgs)
        # 文件类工具、系统数据同样直接拒绝
        r = env.c.post("/api/approvals", json={"session_id": sess["id"], "tool_name": "Write",
                                               "input": {"file_path": str(other / "x.txt")}}, headers=h).json()
        assert r["allow"] is False
        r = env.c.post("/api/approvals", json={"session_id": sess["id"], "tool_name": "Bash",
                                               "input": {"command": f"cat {store.DATA}/center.db"}}, headers=h).json()
        assert r["allow"] is False and not approvals.pending_for(sess["id"])
    finally:
        runner.RUNS.pop(sess["id"], None)


def test_delete_session_removes_guard_file(env, two_users):
    a, b, ua, ub = two_users
    sess = _new_session(env, a)
    runner.build_command("claude", sess, ua, [])
    pf = store.DATA / "mcp" / f"guard_{sess['id']}.json"
    assert pf.exists()
    assert env.c.delete(f"/api/sessions/{sess['id']}", headers=a["headers"]).status_code == 200
    assert not pf.exists()


# ======================================================================
# 六、files_api：个人工作区只有本人能进（管理员也不例外）、回收站脱敏、空间占用
# ======================================================================

import files_api  # noqa: E402


@pytest.fixture
def fx(env, make_user):
    """A 有两个文件的工作区；B 是普通用户；boss 是管理员"""
    import shutil
    store.db("DELETE FROM trash")
    store.db("DELETE FROM file_ops")
    shutil.rmtree(store.TRASH, ignore_errors=True)
    a = make_user("zhang", display_name="张三")
    b = make_user("li", display_name="李四")
    boss = make_user("boss", role="admin", display_name="老板")
    ua = store.get_user(a["id"])
    sub = store.user_ws_dir(ua) / "会话1"
    sub.mkdir(exist_ok=True)
    (sub / "秘密.txt").write_text("工资表内容", encoding="utf-8")
    (sub / "报价.docx").write_bytes(b"x" * 300)
    (sub / "秘密.txt").write_text("a" * 1000, encoding="utf-8")
    ns = type("NS", (), {})()
    ns.c, ns.a, ns.b, ns.boss, ns.ua, ns.sub = env.c, a, b, boss, ua, sub
    return ns


def _ws_forms(fx):
    """同一个文件的各种写法：ws<id>: 前缀、绝对路径"""
    return [f"ws{fx.a['id']}:会话1/秘密.txt", str(fx.sub / "秘密.txt")]


@pytest.mark.parametrize("who", ["b", "boss"])
def test_others_cannot_touch_workspace(fx, monkeypatch, who):
    c, h = fx.c, getattr(fx, who)["headers"]
    for p in _ws_forms(fx):
        assert c.get("/api/files", params={"path": p}, headers=h).status_code == 403
        assert c.get("/api/files/text", params={"path": p}, headers=h).status_code == 403
        assert c.get("/api/files/raw", params={"path": p}, headers=h).status_code == 403
        assert c.get("/api/files/raw", params={"path": p, "download": "true"}, headers=h).status_code == 403
        assert c.get("/api/files/pdf", params={"path": p}, headers=h).status_code == 403
    monkeypatch.setattr(files_api, "SOFFICE", None)   # 没装 LibreOffice：权限检查要先于 501
    for p in _ws_forms(fx):
        assert c.get("/api/files/pdf", params={"path": p}, headers=h).status_code == 403
    for d in (f"ws{fx.a['id']}:会话1", str(fx.sub), f"ws{fx.a['id']}:", str(fx.sub.parent)):
        assert c.get("/api/files", params={"path": d}, headers=h).status_code == 403
        assert c.get("/api/files/search", params={"q": "秘密", "path": d}, headers=h).status_code == 403
        assert c.put("/api/files/upload", params={"dir": d, "name": "新.txt"}, content=b"hi", headers=h).status_code == 403
        assert c.post("/api/files/mkdir", json={"path": d, "name": "新夹"}, headers=h).status_code == 403
    p = str(fx.sub / "秘密.txt")
    assert c.post("/api/files/rename", json={"path": p, "name": "改.txt"}, headers=h).status_code == 403
    r = c.post("/api/files/delete", json={"paths": [p, f"ws{fx.a['id']}:会话1/报价.docx"]}, headers=h).json()
    assert r["deleted"] == [] and len(r["failed"]) == 2
    assert (fx.sub / "秘密.txt").exists() and (fx.sub / "报价.docx").exists()
    assert not (fx.sub / "新.txt").exists() and not (fx.sub / "新夹").exists()
    # 用户不存在和无权返回一样的状态
    assert c.get("/api/files", params={"path": "ws9999:"}, headers=h).status_code == 403


def test_admin_cannot_enter_ws_root_or_trash(fx):
    h = fx.boss["headers"]
    for p in (str(store.WS_ROOT), str(store.TRASH), str(store.WS_ROOT / "没人的文件夹")):
        store.TRASH.mkdir(exist_ok=True)
        (store.WS_ROOT / "没人的文件夹").mkdir(exist_ok=True)
        assert fx.c.get("/api/files", params={"path": p}, headers=h).status_code == 403
        assert fx.c.get("/api/files/search", params={"q": "a", "path": p}, headers=h).status_code == 403


def test_no_other_workspace_paths_in_responses(fx):
    p = fx.c.get("/api/files", params={"path": "ws:"}, headers=fx.boss["headers"]).json()
    assert p["entries"] == [] or all("ws" + str(fx.a["id"]) not in e["path"] for e in p["entries"])
    ua = fx.ua
    assert files_api.to_virtual(fx.sub / "秘密.txt", fx.boss | {"id": fx.boss["id"]}) == ""
    assert files_api.crumbs_for(fx.sub, {"id": fx.b["id"]}) == [{"label": "文件库", "path": ""}]
    assert files_api.to_virtual(fx.sub / "秘密.txt", {"id": ua["id"]}) == "ws:会话1/秘密.txt"


def test_ws_root_hidden_in_library(fx, monkeypatch, tmp_path):
    """工作区放在文件库里面时，根文件夹对所有人（含管理员）都不显示、搜索也不进入"""
    ws = store.FILE_ROOT / "Projector工作区"
    name = store.user_ws_dir(fx.ua, create=False).name
    (ws / name / "会话1").mkdir(parents=True, exist_ok=True)
    (ws / name / "会话1" / "独特文件名.txt").write_text("x")
    (store.FILE_ROOT / "公共独特.txt").write_text("y")
    monkeypatch.setattr(files_api, "WS_ROOT", ws.resolve())
    monkeypatch.setattr(store, "WS_ROOT", ws.resolve())
    monkeypatch.setattr(files_api, "TRASH", ws.resolve() / "回收站")
    for who in (fx.a, fx.b, fx.boss):
        r = fx.c.get("/api/files", params={"path": ""}, headers=who["headers"]).json()
        names = [e["name"] for e in r["entries"]]
        assert "Projector工作区" not in names and "公共独特.txt" in names
        s = fx.c.get("/api/files/search", params={"q": "独特"}, headers=who["headers"]).json()["results"]
        assert [x["name"] for x in s] == ["公共独特.txt"]
        assert fx.c.get("/api/files", params={"path": "Projector工作区"}, headers=who["headers"]).status_code == 403
    # 本人从 ws: 进自己的那份不受影响
    r = fx.c.get("/api/files", params={"path": "ws:会话1"}, headers=fx.a["headers"])
    assert r.status_code == 200 and [e["name"] for e in r.json()["entries"]] == ["独特文件名.txt"]


def test_owner_can_use_own_workspace(fx, monkeypatch):
    c, h = fx.c, fx.a["headers"]
    assert [e["name"] for e in c.get("/api/files", params={"path": "ws:会话1"}, headers=h).json()["entries"]] == ["报价.docx", "秘密.txt"]
    r = c.get("/api/files", params={"path": str(fx.sub)}, headers=h).json()
    assert r["writable"] and r["crumbs"][0]["path"] == "ws:"
    assert c.get("/api/files", params={"path": f"ws{fx.a['id']}:会话1"}, headers=h).status_code == 200
    assert [x["name"] for x in c.get("/api/files/search", params={"q": "秘密", "path": "ws:"}, headers=h).json()["results"]] == ["秘密.txt"]
    assert c.get("/api/files/text", params={"path": "ws:会话1/秘密.txt"}, headers=h).json()["text"].startswith("aaa")
    assert c.get("/api/files/raw", params={"path": "ws:会话1/秘密.txt"}, headers=h).status_code == 200
    monkeypatch.setattr(files_api, "SOFFICE", None)
    assert c.get("/api/files/pdf", params={"path": "ws:会话1/报价.docx"}, headers=h).status_code == 501
    assert c.put("/api/files/upload", params={"dir": "ws:会话1", "name": "新.txt"}, content=b"hi", headers=h).status_code == 200
    assert c.post("/api/files/mkdir", json={"path": "ws:会话1", "name": "新夹"}, headers=h).status_code == 200
    assert c.post("/api/files/rename", json={"path": "ws:会话1/新.txt", "name": "改.txt"}, headers=h).status_code == 200
    r = c.post("/api/files/delete", json={"paths": ["ws:会话1/改.txt"]}, headers=h).json()
    assert len(r["deleted"]) == 1 and not r["failed"]


def _delete_own(fx, rel="ws:会话1/秘密.txt"):
    r = fx.c.post("/api/files/delete", json={"paths": [rel]}, headers=fx.a["headers"]).json()
    assert len(r["deleted"]) == 1
    return r["deleted"][0]["id"]


def test_trash_personal_item_views(fx):
    tid = _delete_own(fx)
    ra = fx.c.get("/api/trash", headers=fx.a["headers"]).json()["items"]
    assert len(ra) == 1 and ra[0]["name"] == "秘密.txt" and ra[0]["personal"] and ra[0]["can_restore"]
    assert ra[0]["owner_name"] == "张三"
    # 普通用户 B 看不到，也不能恢复
    assert fx.c.get("/api/trash", headers=fx.b["headers"]).json()["items"] == []
    assert fx.c.post(f"/api/trash/{tid}/restore", headers=fx.b["headers"]).status_code == 404
    # 管理员：脱敏
    rb = fx.c.get("/api/trash", headers=fx.boss["headers"]).json()["items"]
    assert len(rb) == 1
    it = rb[0]
    assert it["name"] == "（个人文件）" and it["personal"] and it["can_restore"] is False and it["owner_name"] == "张三"
    assert it["orig_path"] == it["orig_virtual"] == it["trash_path"] == ""
    assert "秘密" not in json.dumps(it, ensure_ascii=False) and "会话1" not in json.dumps(it, ensure_ascii=False)
    r = fx.c.post(f"/api/trash/{tid}/restore", headers=fx.boss["headers"])
    assert r.status_code == 403 and "只有本人能恢复" in r.json()["detail"]
    assert fx.c.delete(f"/api/trash/{tid}", headers=fx.b["headers"]).status_code == 403
    # A 自己恢复
    r = fx.c.post(f"/api/trash/{tid}/restore", headers=fx.a["headers"])
    assert r.status_code == 200 and (fx.sub / "秘密.txt").exists()


def test_trash_admin_purge_personal_logs_masked(fx):
    tid = _delete_own(fx)
    assert fx.c.delete(f"/api/trash/{tid}", headers=fx.boss["headers"]).status_code == 200
    assert store.db("SELECT 1 FROM trash WHERE id=?", (tid,), one=True) is None
    last = store.db("SELECT * FROM file_ops WHERE action='彻底删除' ORDER BY id DESC", one=True)
    assert last["path"] == "张三 的个人文件" and "秘密" not in last["path"]


def test_trash_public_items_unchanged(fx):
    f = store.FILE_ROOT / "公共.txt"
    f.write_text("p")
    r = fx.c.post("/api/files/delete", json={"paths": ["公共.txt"]}, headers=fx.b["headers"]).json()
    tid = r["deleted"][0]["id"]
    item = fx.c.get("/api/trash", headers=fx.b["headers"]).json()["items"][0]
    assert item["name"] == "公共.txt" and not item["personal"] and item["can_restore"] and item["orig_path"]
    # A 看不到 B 删的公共文件；管理员看得到原样的
    assert fx.c.get("/api/trash", headers=fx.a["headers"]).json()["items"] == []
    ai = fx.c.get("/api/trash", headers=fx.boss["headers"]).json()["items"][0]
    assert ai["name"] == "公共.txt" and ai["orig_path"] and ai["can_restore"]
    assert fx.c.post(f"/api/trash/{tid}/restore", headers=fx.a["headers"]).status_code == 404
    assert fx.c.post(f"/api/trash/{tid}/restore", headers=fx.boss["headers"]).status_code == 200
    assert f.exists()


def test_admin_session_trash_restorable_by_owner(fx):
    """管理员删了 A 的会话：工作区进回收站，A 能看到并恢复，管理员看到脱敏条目"""
    sid = fx.c.post("/api/sessions", json={}, headers=fx.a["headers"]).json()["id"]
    sess = store.db("SELECT * FROM sessions WHERE id=?", (sid,), one=True)
    ws = store.session_workspace(sess)
    (ws / "x.txt").write_text("x")
    assert fx.c.delete(f"/api/sessions/{sid}", headers=fx.boss["headers"]).status_code == 200
    ia = [i for i in fx.c.get("/api/trash", headers=fx.a["headers"]).json()["items"] if i["personal"]]
    assert len(ia) == 1 and ia[0]["can_restore"] and "删除会话" in ia[0]["reason"]
    ib = [i for i in fx.c.get("/api/trash", headers=fx.boss["headers"]).json()["items"] if i["personal"]]
    assert ib[0]["name"] == "（个人文件）" and ib[0]["reason"] == "删除" and not ib[0]["can_restore"]
    assert fx.c.post(f"/api/trash/{ia[0]['id']}/restore", headers=fx.a["headers"]).status_code == 200


def test_links_for_admin_viewing_others_session(fx):
    sid = fx.c.post("/api/sessions", json={}, headers=fx.a["headers"]).json()["id"]
    lk = fx.c.post(f"/api/sessions/{sid}/links", json={"name": "本机"}, headers=fx.a["headers"]).json()
    root = Path(lk["abs"])
    (root / "机密名.txt").write_text("z")
    assert fx.c.post(f"/api/sessions/{sid}/links/{lk['id']}/snapshot", headers=fx.a["headers"]).status_code == 200
    (root / "新增机密.txt").write_text("z")
    own = fx.c.get(f"/api/sessions/{sid}/links", headers=fx.a["headers"]).json()
    assert len(own) == 1
    assert fx.c.get(f"/api/sessions/{sid}/links", headers=fx.boss["headers"]).json() == []
    r = fx.c.get(f"/api/sessions/{sid}/links/{lk['id']}/changes", headers=fx.boss["headers"])
    assert r.status_code == 403 and "机密" not in r.text
    ch = fx.c.get(f"/api/sessions/{sid}/links/{lk['id']}/changes", headers=fx.a["headers"]).json()
    assert [x["rel"] for x in ch["added"]] == ["新增机密.txt"]


def test_workspace_usage(fx, make_user):
    make_user("nows", display_name="没工作区")   # 没建工作区的用户记 0
    r = fx.c.get("/api/admin/workspace-usage", headers=fx.boss["headers"])
    assert r.status_code == 200
    body = r.json()
    by = {u["username"]: u for u in body["users"]}
    assert by["zhang"]["size"] == 1300 and by["zhang"]["files"] == 2 and by["zhang"]["display_name"] == "张三"
    assert by["nows"]["size"] == 0 and by["nows"]["files"] == 0
    assert not (store.WS_ROOT / by["nows"]["username"]).exists()
    assert set(body["trash"]) == {"size", "files"}
    assert "秘密" not in r.text and "会话1" not in r.text
    assert fx.c.get("/api/admin/workspace-usage", headers=fx.b["headers"]).status_code == 403
    tid = _delete_own(fx)
    tb = fx.c.get("/api/admin/workspace-usage", headers=fx.boss["headers"]).json()["trash"]
    assert tb["size"] == 1000 and tb["files"] == 1 and tid


def test_file_ops_masked_for_admin(fx):
    c = fx.c
    c.put("/api/files/upload", params={"dir": "ws:会话1", "name": "n.txt"}, content=b"hi", headers=fx.a["headers"])
    c.put("/api/files/upload", params={"dir": "", "name": "pub.txt"}, content=b"hi", headers=fx.b["headers"])
    tid = _delete_own(fx)
    c.delete(f"/api/trash/{tid}", headers=fx.boss["headers"])
    ops = c.get("/api/admin/file-ops", headers=fx.boss["headers"]).json()
    text = json.dumps(ops, ensure_ascii=False)
    assert "秘密" not in text and "n.txt" not in text and "会话1" not in text
    assert any(o["path"] == "张三 的个人文件" and o["detail"] == "" for o in ops)
    assert any(o["path"].endswith("pub.txt") for o in ops)   # 公共文件库的记录不变
    # 管理员自己的工作区记录保持原样
    store.log_file_op(store.get_user(fx.boss["id"]), "上传", store.user_ws_dir(store.get_user(fx.boss["id"])) / "我的.txt")
    ops = c.get("/api/admin/file-ops", headers=fx.boss["headers"]).json()
    assert ops[0]["path"].endswith("我的.txt")


def test_internal_read_document_cannot_read_other_workspace(fx):
    """管理员的 Claude（以会话主人身份）读不了 A 的工作区；自己的可以"""
    sid = fx.c.post("/api/sessions", json={}, headers=fx.boss["headers"]).json()["id"]
    h = {"Authorization": f"Bearer {store.INTERNAL_TOKEN}"}
    r = fx.c.post("/api/internal/kb/doc", json={"session_id": sid, "path": str(fx.sub / "秘密.txt")}, headers=h)
    assert r.status_code == 403
    r = fx.c.post("/api/internal/kb/doc", json={"session_id": sid, "path": f"ws{fx.a['id']}:会话1/秘密.txt"}, headers=h)
    assert r.status_code == 403
    mine = store.user_ws_dir(store.get_user(fx.boss["id"])) / "我的.txt"
    mine.write_text("老板的", encoding="utf-8")
    r = fx.c.post("/api/internal/kb/doc", json={"session_id": sid, "path": str(mine)}, headers=h)
    assert r.status_code == 200 and "老板的" in r.json()["text"]


def test_internal_user_is_not_a_backdoor(fx):
    with pytest.raises(HTTPException) as e:
        files_api.resolve_path(str(fx.sub / "秘密.txt"), store.INTERNAL)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        files_api.resolve_path("ws:", store.INTERNAL)
    assert e.value.status_code == 403
