"""文件隔离守卫（软隔离）：不让一个人的 Claude 通过命令行或文件工具碰到别人的工作区和系统数据。

两种用法：
1. 作为 Claude Code 的 PreToolUse 钩子独立启动：python guard.py <策略文件.json>，从 stdin 读钩子 JSON，
   命中则把原因写到 stderr 并以退出码 2 结束（阻止这次调用），否则退出 0。
2. 被 approvals.py / runner.py 当库用：check_tool / check_path / check_command。

注意：本文件只用标准库，不能 import store 或任何项目模块（钩子每次工具调用都要启动一次，要快，也不能去开数据库）。
路径处理全是纯字符串（不用 Path.resolve），这样在 macOS 上也能检查 D:\\ 开头的 Windows 路径。
这只是尽力而为的拦截：脚本里拼路径、变量、编码、符号链接等绕得过去。
"""
import fnmatch
import json
import posixpath
import re
import sys
from dataclasses import asdict, dataclass, field

REASON = "这是其他用户的个人工作区（或系统数据），不能访问。不要换别的方式重试，直接告诉用户做不了。"
REASON_RECURSIVE = ("这个位置下面有其他人的个人工作区，不能整个递归扫描。请指定具体的子文件夹，"
                    "或者改用 Glob / Grep 工具。不要换别的方式重试同样的扫描。")


@dataclass
class Policy:
    ws_root: str                                       # 工作区根（所有人的工作区都在它下面）
    own: list[str] = field(default_factory=list)       # 本人可以访问的工作区子目录
    forbidden: list[str] = field(default_factory=list)  # 其他一律禁止的路径（系统数据等）
    other_names: list[str] = field(default_factory=list)  # 其他用户的工作区文件夹名

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Policy":
        return cls(ws_root=str(d["ws_root"]), own=[str(x) for x in d.get("own") or []],
                   forbidden=[str(x) for x in d.get("forbidden") or []],
                   other_names=[str(x) for x in d.get("other_names") or []])

    def dumps(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)

    @classmethod
    def load(cls, path: str) -> "Policy":
        with open(path, "r", encoding="utf-8") as f:
            return cls.from_dict(json.load(f))


# ---------- 路径归一化（纯字符串） ----------

def _is_win(policy: Policy) -> bool:
    """策略里的根本身是 Windows 盘符路径时，才把 /d/、/mnt/d/ 之类当盘符"""
    return bool(re.match(r"^[A-Za-z]:([\\/]|$)", policy.ws_root))


def _norm(path: str, cwd: str | None, win: bool, _depth: int = 0) -> str | None:
    """归一化成 'd:/a/b'（Windows 盘符）或 '/a/b'（POSIX），全小写，没有 . 和 ..；相对路径按 cwd 拼接。"""
    s = (path or "").strip()
    if not s:
        return None
    if win:
        s = s.replace("\\", "/")
    s = s.casefold()
    if win:
        m = re.match(r"^(?:/mnt/|/cygdrive/|//|/)([a-z])(?:/(.*))?$", s)
        if m:
            s = f"{m.group(1)}:/{m.group(2) or ''}"
        else:
            m = re.match(r"^([a-z]):(.*)$", s)
            if m:
                rest = m.group(2)
                s = f"{m.group(1)}:{rest if rest.startswith('/') else '/' + rest}"
    absolute = s.startswith("/") or (win and re.match(r"^[a-z]:/", s) is not None)
    if not absolute:
        base = _norm(cwd, None, win, _depth + 1) if (cwd and _depth < 2) else None
        s = (base or "/").rstrip("/") + "/" + s
    drive = ""
    if win and re.match(r"^[a-z]:", s):
        drive, s = s[:2], s[2:]
    s = posixpath.normpath(re.sub(r"/+", "/", s) or "/")
    if not s.startswith("/"):
        s = "/" + s
    return drive + s


def _inside(p: str, root: str) -> bool:
    """p 在 root 之内（含 root 本身）"""
    if p == root:
        return True
    return p.startswith(root if root.endswith("/") else root + "/")


def _strict_ancestor(p: str, root: str) -> bool:
    return p != root and _inside(root, p)


class _Ctx:
    """策略里的路径预先归一化好"""

    def __init__(self, policy: Policy):
        self.policy = policy
        self.win = _is_win(policy)
        self.ws = _norm(policy.ws_root, None, self.win) or "/"
        self.own = [x for x in (_norm(p, None, self.win) for p in policy.own) if x]
        self.forbidden = [x for x in (_norm(p, None, self.win) for p in policy.forbidden) if x]
        self.other_names = [n.replace("\\", "/").casefold() for n in policy.other_names if n]
        self.ws_last = self.ws.rstrip("/").rsplit("/", 1)[-1]
        # 本人文件夹相对 ws_root 的写法（文本层判断“ws_root 后面紧跟本人文件夹名”用）
        self.own_rel = [o[len(self.ws.rstrip("/")) + 1:] for o in self.own if _inside(o, self.ws) and o != self.ws]

    def norm(self, path: str, cwd: str | None) -> str | None:
        return _norm(path, cwd, self.win)


def _check_path(ctx: _Ctx, path: str, cwd: str | None) -> str | None:
    p = ctx.norm(path, cwd)
    return _check_norm(ctx, p) if p else None


def _check_norm(ctx: _Ctx, p: str) -> str | None:
    if _inside(p, ctx.ws) and not any(_inside(p, o) for o in ctx.own):
        return REASON
    if any(_inside(p, f) for f in ctx.forbidden):
        return REASON
    return None


def check_path(policy: Policy, path: str, cwd: str | None = None) -> str | None:
    """路径检查：返回拒绝原因，放行返回 None。ws_root 的上级目录本身不拒绝。"""
    return _check_path(_Ctx(policy), path, cwd)


# ---------- 通配符 ----------

def _wild_split(raw: str):
    """带通配符的路径 → (固定前缀, 第一个通配段, 通配段起的段数, 是否含 **)；没有通配符返回 None。raw 用正斜杠。"""
    comps = raw.split("/")
    for i, c in enumerate(comps):
        if any(ch in c for ch in "*?["):
            prefix = "/".join(comps[:i])
            if not prefix and raw.startswith("/"):
                prefix = "/"
            elif re.fullmatch(r"[A-Za-z]:", prefix):
                prefix += "/"
            rest = [x for x in comps[i:] if x]
            return prefix, c, len(rest), any("**" in x for x in rest)
    return None


def _wild_leak(ctx: _Ctx, fixed: str, first: str, n: int, dstar: bool, recursive: bool) -> bool:
    """固定前缀是 ws_root 的严格祖先时，通配符会不会伸进别人的文件夹"""
    if not _strict_ancestor(fixed, ctx.ws):
        return False
    rel = ctx.ws[len(fixed.rstrip("/")) + 1:].split("/")
    if not fnmatch.fnmatchcase(rel[0], first.casefold()):
        return False
    if dstar:
        return True
    return n >= len(rel) + (0 if recursive else 1)


# ---------- 命令切词 ----------

_SEPS = set(";|&()<>\n\r")


def _segments(cmd: str) -> list[list[str]]:
    """按 ; | & ( ) < > 换行分段，再按空白切词，去掉引号。反斜杠原样保留（Windows 路径）。"""
    segs: list[list[str]] = []
    words: list[str] = []
    cur: list[str] = []
    has = False
    quote = ""
    inner = 0   # 当前词里还没配对的 (：李四(li) 这种文件夹名里的括号属于词本身

    def end_word():
        nonlocal cur, has, inner
        if has:
            words.append("".join(cur))
        cur, has, inner = [], False, 0

    def end_seg():
        nonlocal words
        end_word()
        if words:
            segs.append(words)
        words = []

    for ch in cmd:
        if quote:
            if ch == quote:
                quote = ""
            else:
                cur.append(ch)
        elif ch in "\"'":
            quote, has = ch, True
        elif ch == "(" and cur and cur[-1] != "$":
            cur.append(ch)
            inner += 1
        elif ch == ")" and inner:
            cur.append(ch)
            inner -= 1
        elif ch in _SEPS:
            end_seg()
        elif ch.isspace():
            end_word()
        else:
            cur.append(ch)
            has = True
    end_seg()
    return segs


# ---------- 命令检查 ----------

_CD = {"cd", "pushd", "chdir", "set-location", "sl"}
_WRAP = {"sudo", "time", "command", "env", "nohup", "xargs", "call", "start", "exec"}
_SHELLS = {"powershell", "pwsh", "bash", "sh", "zsh", "cmd"}
_GREP = {"grep", "egrep", "fgrep", "zgrep"}
_ALWAYS_REC = {"find", "rg", "ag", "ack", "tree", "du", "xcopy", "robocopy", "rsync", "tar", "zip", "7z", "7za", "7zz"}
_NOARG_CWD = {"find", "rg", "ag", "ack", "tree", "du", "ls", "dir", "findstr", "gci", "get-childitem", "grep", "egrep", "fgrep"}
_PATTERN_FIRST = {"rg", "ag", "ack", "grep", "egrep", "fgrep", "zgrep", "findstr"}
_PS_REC = {"gci", "get-childitem", "select-string", "sls", "copy-item", "cpi", "ls", "dir"}
_COPY_LIKE = {"cp", "xcopy", "robocopy", "rsync", "copy-item", "cpi"}
_GREP_VALUE_FLAGS = {"-g", "-t", "-T", "-A", "-B", "-C", "-m", "-j", "--glob", "--type", "--max-count", "--include",
                     "--exclude", "--exclude-dir", "-e", "-f", "--regexp", "--file", "-d", "--context"}
_GREP_PATTERN_FLAGS = {"-e", "-f", "--regexp", "--file", "--files"}


def _prog(words: list[str]) -> tuple[str, int]:
    """命令名（小写、去路径和 .exe）和它在 words 里的位置，跳过 VAR=x 前缀和 sudo 之类的包装"""
    i = 0
    while i < len(words):
        w = words[i]
        name = re.split(r"[\\/]", w.casefold())[-1]
        name = name[:-4] if name.endswith(".exe") else name
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w) or name in _WRAP:
            i += 1
            continue
        if name == "cmd" and i + 2 < len(words) and words[i + 1].casefold() in ("/c", "/k"):
            i += 2   # cmd /c dir /s D:\ ：真正的命令在后面
            continue
        return name, i
    return "", len(words)


def _is_flag(w: str, name: str) -> bool:
    if len(w) > 1 and w.startswith("-"):
        return True
    if name in {"dir", "findstr", "xcopy", "robocopy"} and re.fullmatch(r"/[A-Za-z]+(:.*)?", w):
        return True
    return False


def _is_recursive(name: str, args: list[str]) -> bool:
    low = [a.casefold() for a in args]
    short = [a for a in args if re.fullmatch(r"-[A-Za-z]+", a)]
    if name in _ALWAYS_REC:
        return True
    if name in _GREP:
        return any(a in ("--recursive", "--dereference-recursive") for a in args) or any(
            "r" in a[1:] or "R" in a[1:] for a in short)
    if name == "cp":
        return any(a in ("--recursive", "--archive") for a in args) or any(
            set(a[1:]) & set("rRa") for a in short)
    if name == "ls":
        return any("R" in a[1:] for a in short) or any(a == "-r" or a.startswith("-rec") for a in low) \
            or "--recursive" in args
    if name == "dir":
        return "/s" in low or any(a == "-r" or a.startswith("-rec") for a in low)
    if name == "findstr":
        return "/s" in low
    if name in _PS_REC:
        return any(a == "-r" or a.startswith("-rec") for a in low)
    return False


def _targets(name: str, args: list[str]) -> list[str]:
    """递归程序的目标路径参数（空列表表示“没有写路径”）"""
    if name == "find":
        out = []
        for a in args:
            if a.startswith("-") or a in ("!", "(", ")", "\\(", "\\)"):
                break
            out.append(a)
        return out
    skip_next = False
    pos: list[str] = []
    custom_pattern = False
    for a in args:
        if skip_next:
            skip_next = False
            continue
        if name in _PATTERN_FIRST and a in _GREP_PATTERN_FLAGS:
            custom_pattern = True
        if name in _PATTERN_FIRST and a in _GREP_VALUE_FLAGS:
            skip_next = True
            continue
        if name == "tar" and a in ("-C", "--directory"):
            skip_next = True
            continue
        if _is_flag(a, name):
            continue
        pos.append(a)
    if name in _PATTERN_FIRST and not custom_pattern and pos:
        pos = pos[1:]
    if name in _COPY_LIKE and len(pos) >= 2:
        pos = pos[:-1]   # 最后一个是目标位置，只往里写，不会读到别人的东西
    return pos


def _check_segment(ctx: _Ctx, words: list[str], cwd: str, depth: int) -> tuple[str | None, str]:
    """检查一段命令，返回 (拒绝原因, 之后的当前目录)"""
    name, pi = _prog(words)
    args = words[pi + 1:]

    # 通用路径检查：每个不是选项的词都当路径看
    for w in words:
        cands = [w]
        if "=" in w:
            cands.append(w.split("=", 1)[1])
        for c in cands:
            if not c or (c.startswith("-") and c is w) or re.fullmatch(r"\\+", c):
                continue
            raw = c.replace("\\", "/") if ctx.win else c
            ws_ = _wild_split(raw)
            if ws_:
                prefix, first, n, dstar = ws_
                fixed = ctx.norm(prefix or ".", cwd)
                if fixed:
                    if r := _check_norm(ctx, fixed):
                        return r, cwd
                    if _wild_leak(ctx, fixed, first, n, dstar, False):
                        return REASON, cwd
            elif r := _check_path(ctx, c, cwd):
                return r, cwd

    # cd 跟踪
    new_cwd = cwd
    if name in _CD:
        tgt = next((a for a in args if not a.startswith("-")), None)
        if tgt and tgt not in ("~", "-"):
            ws_ = _wild_split(tgt.replace("\\", "/") if ctx.win else tgt)
            if ws_:   # cd Proj*：通配符可能正好进到工作区根或别人的文件夹，之后的当前目录就说不清了
                fixed = ctx.norm(ws_[0] or ".", cwd)
                if fixed and _strict_ancestor(fixed, ctx.ws) and fnmatch.fnmatchcase(
                        ctx.ws[len(fixed.rstrip("/")) + 1:].split("/")[0], ws_[1].casefold()):
                    return REASON, cwd
            n = ctx.norm(tgt, cwd)
            if n:
                new_cwd = n

    # bash -c "..." / powershell -Command "..." 里面的命令
    if name in _SHELLS and depth < 3:
        for a in args:
            if re.search(r"\s", a):
                if r := _check_command(ctx, a, cwd, depth + 1):
                    return r, new_cwd

    # 递归扫描
    if _is_recursive(name, args):
        tg = _targets(name, args)
        if not tg and name in _NOARG_CWD:
            tg = ["."]
        for t in tg:
            raw = t.replace("\\", "/") if ctx.win else t
            ws_ = _wild_split(raw)
            if ws_ and not ws_[0] and name in {"findstr", "dir", "gci", "get-childitem"}:
                ws_ = None
                raw = "."   # 光写 *.txt：在当前目录下递归找
                t = "."
            if ws_:
                prefix, first, n, dstar = ws_
                fixed = ctx.norm(prefix or ".", cwd)
                if fixed and (_strict_ancestor(fixed, ctx.ws) and _wild_leak(ctx, fixed, first, n, dstar, True)):
                    return REASON_RECURSIVE, new_cwd
                continue
            p = ctx.norm(t, cwd)
            if p and _strict_ancestor(p, ctx.ws):
                return REASON_RECURSIVE, new_cwd
    return None, new_cwd


def _boundary(ch: str) -> bool:
    return (not ch) or ch.isspace() or ch in "/\\\"'`;|&<>(),=:"


def _variants(root: str, win: bool) -> list[str]:
    """一个已归一化的根在命令文本里的各种写法"""
    out = [root]
    m = re.match(r"^([a-z]):(/.*)$", root) if win else None
    if m:
        d, rest = m.group(1), m.group(2).rstrip("/")
        out += [f"/{d}{rest}", f"//{d}{rest}", f"/mnt/{d}{rest}", f"/cygdrive/{d}{rest}"]
    return [v.rstrip("/") if len(v) > 3 else v for v in out]


def _check_text(ctx: _Ctx, cmd: str) -> str | None:
    """文本层 + 名字层：不管命令怎么拆，字面上出现了就拒绝"""
    text = cmd.replace("\\", "/").casefold()
    for f in ctx.forbidden:
        if any(v in text for v in _variants(f, ctx.win)):
            return REASON
    for v in _variants(ctx.ws, ctx.win):
        start = 0
        while (i := text.find(v, start)) >= 0:
            start = i + len(v)
            rest = text[start:]
            if rest and rest[0] != "/" and not _boundary(rest[0]):
                continue   # 只是前缀相同的别的名字
            if not any(rest.startswith("/" + o) and _boundary(rest[1 + len(o):2 + len(o)]) for o in ctx.own_rel):
                return REASON
    for n in ctx.other_names:
        start = 0
        while (i := text.find(n, start)) >= 0:
            start = i + len(n)
            if _boundary(text[i - 1] if i else "") and _boundary(text[start] if start < len(text) else ""):
                return REASON
    if ctx.ws_last:
        start = 0
        while (i := text.find(ctx.ws_last, start)) >= 0:
            start = i + len(ctx.ws_last)
            if not (_boundary(text[i - 1] if i else "") and _boundary(text[start] if start < len(text) else "")):
                continue
            rest = text[start:]
            if not any(rest.startswith("/" + o) and _boundary(rest[1 + len(o):2 + len(o)]) for o in ctx.own_rel):
                return REASON
    return None


def _check_command(ctx: _Ctx, command: str, cwd: str | None, depth: int = 0) -> str | None:
    if not command or not command.strip():
        return None
    if r := _check_text(ctx, command):
        return r
    cur = ctx.norm(cwd or ".", None) or "/"
    for words in _segments(command):
        r, cur = _check_segment(ctx, words, cur, depth)
        if r:
            return r
    return None


def check_command(policy: Policy, command: str, cwd: str | None = None) -> str | None:
    """检查 Bash / PowerShell 命令文本：返回拒绝原因，放行返回 None"""
    return _check_command(_Ctx(policy), command, cwd)


# ---------- 工具调用 ----------

_PATH_KEYS = ("file_path", "path", "notebook_path", "directory", "dir", "folder", "filepath", "filename",
              "source", "destination", "target", "paths", "file_paths")


def check_tool(policy: Policy, tool_name: str, tool_input: dict, cwd: str | None = None) -> str | None:
    """检查一次工具调用：返回拒绝原因，放行返回 None"""
    inp = tool_input if isinstance(tool_input, dict) else {}
    if tool_name in ("Bash", "PowerShell"):
        return check_command(policy, str(inp.get("command") or ""), cwd)
    ctx = _Ctx(policy)
    for key in _PATH_KEYS:
        v = inp.get(key)
        for item in (v if isinstance(v, list) else [v]):
            if isinstance(item, str) and item.strip():
                if r := _check_path(ctx, item, cwd):
                    return r
    base = inp.get("path") if isinstance(inp.get("path"), str) and inp.get("path") else cwd
    for key in ("pattern", "glob"):
        if tool_name == "Grep" and key == "pattern":
            continue   # Grep 的 pattern 是正则，不是路径
        pat = inp.get(key)
        if isinstance(pat, str) and re.search(r"[\\/]", pat):
            raw = pat.replace("\\", "/") if ctx.win else pat
            ws_ = _wild_split(raw)
            fixed = (ws_[0] if ws_ else raw.rsplit("/", 1)[0] if "/" in raw else "") or "."
            if r := _check_path(ctx, fixed, base):
                return r
    return None


# ---------- 钩子入口 ----------

def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    try:
        if len(argv) < 2:
            raise ValueError("没有给策略文件")
        policy = Policy.load(argv[1])
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
        reason = check_tool(policy, str(data.get("tool_name") or ""), data.get("tool_input") or {}, data.get("cwd") or None)
    except Exception as e:   # 任何异常都按拒绝处理，不能因为出错就放行
        reason = f"隔离检查出错，为安全起见已拒绝这次操作（{type(e).__name__}: {e}）。请告诉用户联系管理员。"
    if reason:
        sys.stderr.buffer.write(reason.encode("utf-8"))
        sys.stderr.buffer.flush()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
