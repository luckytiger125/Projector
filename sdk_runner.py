"""用 claude-agent-sdk 的常驻会话运行 Claude Code（runner_mode=sdk 时用；默认的 cli 模式不经过这里）。
每个会话一个常驻客户端，轮与轮之间不重启 claude 进程。设计见 docs/plans/2026-11-agent-sdk.md。

本文件不 import runner（runner 把这一轮要用的东西装进 TurnSpec 传进来），也不在模块顶层 import claude_agent_sdk：
没装这个包时服务照常启动，只有 sdk 模式下发消息才会报错（见 availability / unavailable_message）。

当前是骨架：接口都在，run_turn 还没有真正的实现。
"""
from dataclasses import dataclass, field
from typing import Callable

import approvals  # noqa: F401  （实现里的权限回调和提问工具要用）
import events  # noqa: F401
import guard
import store  # noqa: F401
import usage  # noqa: F401


class SdkUnavailable(Exception):
    """sdk 模式用不了（没装包、找不到原生 claude.exe 等）；消息是给管理员看的中文原因。"""


def _load_sdk():
    """晚导入 claude_agent_sdk 并返回模块（测试会 monkeypatch 这个函数）。"""
    import claude_agent_sdk
    return claude_agent_sdk


def availability() -> str | None:
    """None 表示 sdk 可用；否则返回中文原因。"""
    try:
        _load_sdk()
    except ImportError:
        return "没有安装 claude-agent-sdk（在服务目录下运行 pip install -r requirements-sdk.txt）"
    except Exception as e:
        return f"claude-agent-sdk 加载失败：{e}"
    return None


UNAVAILABLE_HINT = "请让管理员在设置里把运行方式切回 cli（或在 config.bat 里设 RUNNER_MODE=cli 并清掉设置）"


def unavailable_message(reason: str) -> str:
    return f"sdk 模式不可用：{reason}。{UNAVAILABLE_HINT}"


@dataclass
class TurnSpec:
    """runner 为这一轮准备好的全部输入（sdk_runner 不依赖 runner）。"""
    sid: str
    owner_id: int
    cli_path: str
    cwd: str
    add_dirs: list = field(default_factory=list)
    hint_file: str = ""                       # 附加提示词文件
    disallowed: list = field(default_factory=list)   # AskUserQuestion + deny 规则 + 被进程内工具替换的两个外部工具
    allowed: list = field(default_factory=list)      # 自动放行名单（完全放行档为空）
    bypass: bool = False                      # 完全放行档
    ask_rules: list = field(default_factory=list)    # 标准档的 ask 规则
    mcp_center: dict = field(default_factory=dict)   # 外部工具服务 approval_mcp.py 的 stdio 配置
    plugin_dir: str | None = None
    resume: str | None = None
    policy: Callable[[], guard.Policy] | None = None  # 每次工具调用时现取，新建的账号立刻生效
    timeout: float = 3600.0
    log_path: str = ""


async def run_turn(run, prompt: str, spec: TurnSpec, on_event) -> dict:
    """跑一轮，返回和 runner.run_claude 同形的 final 字典。（骨架：还没有实现）"""
    return {"is_error": True, "result": unavailable_message("这一版还没有实现 sdk 运行路径")}


def request_stop(sid: str) -> None:
    """停止这一轮（同步调用，内部起任务）。"""


async def close_session(sid: str) -> None:
    """会话被删、或要强制重建时关掉它的常驻客户端。"""


async def close_idle(now=None) -> int:
    """关掉空闲超时的客户端，返回关了几个。"""
    return 0


async def close_all() -> None:
    """服务退出、切回 cli 时关掉所有客户端。"""


def client_count() -> int:
    return 0
