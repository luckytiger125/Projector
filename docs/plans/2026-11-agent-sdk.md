# 用 Claude Agent SDK 的常驻会话运行路径（带开关，默认关闭）

日期：2026-11-11
工作分支：`agent-sdk`（从 `main` 8cbecb5 切出）
对应总计划：`docs/plans/2026-11-10-workbench-next.md` 第二批第 1 条。
状态：不推送、不合并，做完汇报后由用户决定。

## 1. 目标和硬约束

- 现状：每一轮对话起一个 `claude -p` 进程，靠 `--resume` 续上下文。冷启动慢，状态在进程外。
- 目标：加一条用 `claude-agent-sdk`（`ClaudeSDKClient`）的路径，每个会话一个常驻客户端，轮与轮之间不重启进程。
- 硬约束：开发机（macOS）上验证不了 Windows 和 DeepSeek。所以
  - 新路径带开关，**默认 `cli`**；`cli` 模式的代码路径和行为不变，现有 278 个测试不改断言全部通过；
  - `claude-agent-sdk` 是可选依赖，没装时服务照常启动，只有切到 `sdk` 模式并发消息时才报错，报错里写明怎么切回；
  - 不改 `static/`，不动 `server.py` 里挂静态文件的那几行。

## 2. 调研结论（`claude-agent-sdk` 0.2.180，读的是已安装版本的源码）

| 问题 | 结论 |
| --- | --- |
| Python 版本 | `Requires-Python >=3.10`，目标机的 3.10 可用。依赖 `anyio`、`mcp`（与现有 `mcp>=1.2,<2` 兼容，本机装出来是 1.30）。 |
| 底层是什么 | SDK 自己不调模型，它启动 `claude` 可执行文件（`--output-format stream-json --input-format stream-json`），在 stdin/stdout 上跑控制协议。所以登录状态、`ANTHROPIC_BASE_URL` 等第三方模型配置、会话存档（`~/.claude/projects/…`）和 `claude -p` 完全共用。 |
| 怎样找 `claude` | 默认顺序：包里自带的 `_bundled/claude(.exe)` → `PATH` → 几个常见位置。传 `ClaudeAgentOptions(cli_path=…)` 可以指定。**我们传 `store.find_claude()` 的结果**，和 `cli` 模式用同一个可执行文件。 |
| **Windows 上的限制** | SDK **拒绝运行 `.cmd`/`.bat`**（`_reject_windows_batch_cli`，防 cmd.exe 注入）。npm 装出来的 `claude.cmd` 不能用，必须是原生 `claude.exe`（官方安装脚本装在 `%USERPROFILE%\.local\bin\claude.exe`），或 Windows x64 的 wheel 自带的 `claude.exe`。处理办法见 §4.2。 |
| 环境变量 | 子进程环境 = `os.environ`（去掉 `CLAUDECODE`）+ `CLAUDE_CODE_ENTRYPOINT=sdk-py` + `options.env`。`config.bat` 里设的变量原样继承；`MCP_TOOL_TIMEOUT`、`MCP_TIMEOUT` 放进 `options.env`。 |
| 系统提示词 | `system_prompt=None` 会被翻成 `--system-prompt ""`（清空默认提示词）。必须传 `{"type":"preset","preset":"claude_code"}`；附加内容用 `extra_args={"append-system-prompt-file": 路径}`，和 `cli` 模式一样走文件（不走命令行参数）。 |
| 逐字输出 | `include_partial_messages=True` 后收到 `StreamEvent`，`.event` 就是原始的 `message_start` / `content_block_delta`，和现在解析的内容相同。 |
| 权限确认 | `can_use_tool(tool_name, input, context)` 异步回调，返回 `PermissionResultAllow` / `PermissionResultDeny(message=…)`。只有 CLI 判断“需要问人”时才会调：`allowed_tools`、settings 里的 `ask` 规则、`permission_mode` 仍由 CLI 判断，所以三档的规则可以原样沿用。`bypassPermissions` 下回调不会被调用。 |
| 钩子 | `hooks={"PreToolUse":[HookMatcher(matcher=None, hooks=[回调], on_failure="block")]}`，回调在本进程里执行，在权限判断之前，三档（含完全放行）都会触发。`on_failure="block"`：回调出错按拒绝处理（旧版 CLI 不支持时 `connect()` 直接报错，不会悄悄放行）。 |
| 进程内 MCP 工具 | `@tool` + `create_sdk_mcp_server(name, tools=[…])`，工具函数在本进程里执行，工具名是 `mcp__<server>__<tool>`。可以和外部（stdio）MCP 服务并存。 |
| 续接 | `resume=<claude_session>`；`ResultMessage.session_id` 是这次的会话 id。 |
| 中断 | `client.interrupt()`，之后会收到一条 `ResultMessage`（`terminal_reason` 为 `aborted_*`），进程继续活着。 |
| 用量 | `ResultMessage` 有 `usage`、`total_cost_usd`、`model_usage`（键是驼峰，和 `modelUsage` 相同），能还原成 `usage.record_turn` 现在吃的那个字典。 |
| 进程退出 | 读消息的迭代器在进程退出时结束（退出码 0）或抛 `ProcessError`。 |
| 结束进程 | `disconnect()`：关 stdin → 等 5 秒 → `terminate` → 等 5 秒 → `kill`，只针对 `claude` 本身，**不杀子进程树**；另有 `atexit` 兜底。Windows 上要自己用 `taskkill /T /F` 杀整棵树，pid 要从私有属性 `client._transport._process.pid` 取（取不到就退回只靠 `disconnect()`）。 |
| 异步上下文 | SDK 文档写明：一个客户端要在同一个异步上下文里 `connect` 和 `disconnect`。所以每个客户端由一个专属的 asyncio 任务负责连接、读消息、断开。 |
| Windows 事件循环 | asyncio 起子进程需要 Proactor 事件循环。uvicorn 不带 `--reload`、单进程时在 Windows 上用的就是它（现状如此）；启动客户端前检查一下，不是的话明确报错。 |
| 控制台窗口 | SDK 起子进程没有 `CREATE_NO_WINDOW`。从 `start.bat` 的控制台窗口里启动服务时子进程继承控制台，不会弹窗；用 `pythonw` 之类无控制台方式启动时可能弹黑窗。只能实机看。 |
| 单行大小上限 | 默认 1 MB，一条 stream-json 消息超过就报错。`read_document` 等工具结果可能很大，调到 32 MB。 |
| 安装体积 | wheel 自带一个约 300 MB 的 `claude` 可执行文件，安装时下载量大。 |

没有发现 SDK 做不到的硬性要求。只有一条外部前提：**Windows 上必须有原生 `claude.exe`**（或装带 `claude.exe` 的 wheel）。

本机实测条件：本机的 `claude` 登录已失效（`401 OAuth access token is invalid`），真实的一问一答跑不了；能实测的是“SDK 起真的 `claude`、握手、发一轮、拿到（认证失败的）结果、空闲关闭、进程不残留”这条链路。模型真的回话、工具调用、权限卡片在真实 CLI 下的表现，要在 Windows 实机上验证。

## 3. 开关

- 取值 `cli` | `sdk`。优先级：管理员设置（`settings` 表的 `runner_mode`）> 环境变量 `RUNNER_MODE` > `cli`。非法值按 `cli`。
- `runner.runner_mode()` 每一轮开始时读一次，改设置对下一轮立即生效，不用重启。
- `GET /api/admin/settings` 多返回 `runner_mode`、`sdk_available`（布尔）、`sdk_error`（不可用的原因，可用时为空串）、`sdk_idle_seconds`、`sdk_clients`（当前常驻客户端数）。
- `PUT /api/admin/settings` 接受 `runner_mode`（只认 `cli`/`sdk`，其他值忽略，和 `perm_mode` 的做法一致）和 `sdk_idle_seconds`（30~86400）。切到 `cli` 时把空闲的常驻客户端全部关掉；正在跑的那一轮跑完后关。
  允许在 SDK 不可用时把设置存成 `sdk`（返回里 `sdk_available=false` 能看出来），发消息时报错。
- `sdk` 模式不可用时的报错（HTTP 500，或排队消息的“没能开始”记录）：
  `sdk 模式不可用：<原因>。请让管理员在设置里把运行方式切回 cli（或在 config.bat 里设 RUNNER_MODE=cli 并清掉设置）。`
- 其他环境变量：`SDK_IDLE_SECONDS`（默认 600，设置项 `sdk_idle_seconds` 优先）、`SDK_MAX_CLIENTS`（默认 8，最小取并发上限）、`SDK_CONNECT_TIMEOUT`（默认 120 秒）。

## 4. 模块划分

依赖顺序：`store` < `events` < `approvals` < **`sdk_runner`** < `runner` < `sessions_api`/`auth_api` < `server`。
`sdk_runner` 不 import `runner`；`runner` 把这一轮要用的东西装进 `TurnSpec` 传进去。`claude_agent_sdk` 只在 `sdk_runner._load_sdk()` 里晚导入。

### 4.1 `approvals.py`（重构，HTTP 接口行为不变）

抽出两个协程，HTTP 接口和 SDK 回调共用：

- `async def wait_approval(sid, owner_id, tool_name, tool_input) -> tuple[bool, str]`：建卡片、广播 `approval`、等结果或超时、清理并广播 `approval_done`。就是 `request_approval` 里从 `aid = …` 到 `finally` 的那一段。
- `async def wait_question(sid, owner_id, raw_questions: list[dict]) -> str`：清洗问题、建卡片、等回答，返回给 Claude 的那段文字。就是 `ask_question` 里 `questions = []` 之后的全部。
- `def reject_by_guard(sid, tool_name, tool_input) -> None`：记那条“⛔ 已自动拒绝（涉及其他人的个人文件或系统数据）：…”的事件消息。

`request_approval` / `ask_question` 变成：查 `RUNS`、（确认）做 guard 检查、调上面的协程。返回值、事件顺序、超时文案都不变。

### 4.2 `sdk_runner.py`（新文件）

```python
def availability() -> str | None            # None=可用；否则是中文原因（没装包 / 导入失败）
def resolve_cli(claude_bin: str) -> str     # Windows 上 .cmd/.bat → 找原生 exe；找不到抛 SdkUnavailable
@dataclass
class TurnSpec:
    sid: str; owner_id: int
    cli_path: str; cwd: str
    add_dirs: list[str]
    hint_file: str                # 附加提示词文件
    disallowed: list[str]         # AskUserQuestion + deny 规则 + mcp__center__approve + mcp__center__ask_user
    allowed: list[str]            # 自动放行名单（完全放行档为空）
    bypass: bool
    ask_rules: list[str]          # 标准档的 ask 规则（严格档、完全放行档为空）
    mcp_center: dict              # 外部工具服务 approval_mcp.py 的 stdio 配置（command/args/env）
    plugin_dir: str | None
    resume: str | None
    policy: Callable[[], guard.Policy]   # 每次工具调用时现取，新建的账号立刻生效
    timeout: float                # TASK_TIMEOUT
    log_path: str

async def run_turn(run, prompt: str, spec: TurnSpec, on_event) -> dict   # 返回值和 run_claude 的 final 同形
def request_stop(sid: str) -> None        # 停止这一轮（同步，内部起任务）
async def close_session(sid: str) -> None # 会话被删、或要强制重建时
async def close_idle(now=None) -> int     # 关掉空闲超时的；后台任务每 30 秒调一次
async def close_all() -> None             # 服务退出、切回 cli
def client_count() -> int
```

- **`resolve_cli`**：非 Windows 原样返回。Windows 上如果 `find_claude()` 给的是 `.cmd`/`.bat`：依次找 `shutil.which("claude.exe")`、`~/.local/bin/claude.exe`、SDK 包里的 `_bundled/claude.exe`；都没有就抛 `SdkUnavailable("sdk 模式需要原生的 claude.exe，这台电脑上找到的是 …claude.cmd。请用官方安装脚本安装 Claude Code，或在 config.bat 里把 CLAUDE_BIN 指到 claude.exe")`。用了哪个可执行文件写进这一轮的日志。
- **选项拼装** `_options(spec, callbacks)`：
  - `cli_path`、`cwd`、`add_dirs`、`resume`、`allowed_tools`、`disallowed_tools`、`include_partial_messages=True`、`max_buffer_size=32MB`
  - `system_prompt={"type":"preset","preset":"claude_code"}`，`extra_args={"append-system-prompt-file": hint_file}`
  - `permission_mode="bypassPermissions"`（仅完全放行档），否则不设；`can_use_tool=回调`（三档都挂，完全放行档下不会被调）
  - `settings=json.dumps({"permissions":{"ask": ask_rules}})`（仅标准档；其他档不传）。**不再往 settings 里写 guard.py 的命令钩子**，改用进程内钩子
  - `hooks={"PreToolUse":[HookMatcher(matcher=None, hooks=[guard 钩子], on_failure="block")]}`
  - `mcp_servers={"center": {stdio 配置}, "projector": create_sdk_mcp_server("projector", tools=[ask_user])}`
  - `plugins=[{"type":"local","path":plugin_dir}]`（有的话）
  - `env={"MCP_TOOL_TIMEOUT": …, "MCP_TIMEOUT": "60000"}`，`stderr=写日志的回调`
  - 不设 `setting_sources`（默认行为和 `claude -p` 一样，照常读用户级设置）
- **指纹**：上面这些输入（除 `resume`、`policy`）算一个指纹。同一会话下一轮的指纹和常驻客户端的不一样（切了完全放行、改了权限档位或规则、引用了新目录、新增了账号导致 deny 规则变了、技能目录变了）→ 关掉旧客户端，用 `resume` 重建。`add_dirs` 只要新的是旧的子集就算相同。
- **`_Client`（每个会话一个）**：一个专属任务 `_owner()` 负责 `connect()` → `async for msg in client.receive_messages()` → 结束时 `disconnect()`。
  - 读到的消息：有进行中的轮次就放进这一轮的 `asyncio.Queue`，没有就丢弃（防止后台通知之类的迟到消息混进下一轮）。
  - 迭代器结束或抛异常：标记 `dead`，往队列里放一个哨兵；从池里摘掉。
  - 关闭 `close(force)`：`force` 时先杀进程树（Windows `taskkill /T /F /PID`，其他平台 `kill`），再取消 `_owner` 任务，任务的 `finally` 里 `disconnect()`（限时 20 秒）；之后进程还在就再杀一次树。
- **`run_turn`**：
  1. `availability()`、`resolve_cli`、Windows 事件循环检查，不过就返回 `{"is_error": True, "result": "…切回 cli…"}`；
  2. 取这个会话的客户端：没有、已死、指纹不同 → （关旧）建新，等连接完成（`SDK_CONNECT_TIMEOUT`）；池满（`SDK_MAX_CLIENTS`）时先关最久没用的空闲客户端；
  3. `client.query(prompt)`，从队列里取消息直到 `ResultMessage`：
     - `StreamEvent`：`message_start` → `delta_reset`；`content_block_delta` 的 `thinking_delta` → `thinking`，`text` → `delta`（`parent_tool_use_id` 非空的子代理流不转，和现状一致——`claude -p` 的输出里子代理的 stream_event 也带这个字段，但现有代码没区分；这里保持“全部转发”以求一致）；
     - `AssistantMessage`：每个 `ToolUseBlock` → `tool`（`name`、`detail` 用和 `runner._tool_detail` 相同的规则）；
     - `ResultMessage` → `final`：`{"type":"result","subtype","is_error","result","session_id","total_cost_usd","usage","modelUsage": model_usage}`；
     - 其他消息忽略；
  4. 哨兵（进程死了）→ `final = {"is_error": True, "result": "claude 进程异常退出：<stderr 末尾 300 字>", "session_id": 已知的}`，客户端已摘掉，下一轮自动重建；
  5. 超时（`spec.timeout`）→ `run.timed_out = True`，强制关闭客户端；
  6. 结束后 `last_used = now`，`busy = False`；如果此时模式已不是 `sdk`，关掉。
  - 事件直接调 `on_event(ev)`（已经在事件循环线程里，不需要 `call_soon_threadsafe`）。
- **停止** `request_stop(sid)`：`client.interrupt()`，最多等 5 秒让这一轮自己以 `ResultMessage` 收尾；不管等没等到，都关掉这个客户端（等到了就正常 `disconnect`，没等到就强制）。停止后的下一轮冷启动一次、用 `resume` 续上——和 `cli` 模式停止后的行为等价，避免被打断的那一轮的残余消息串进下一轮。
- **权限回调** `can_use_tool(tool_name, tool_input, ctx)`：
  1. `guard.check_tool(spec.policy(), tool_name, tool_input, spec.cwd)` 有原因 → `approvals.reject_by_guard(…)`，返回 `Deny(message=原因)`（第二道，和现在 `request_approval` 里的兜底一致）；
  2. `allow, message = await approvals.wait_approval(sid, owner_id, tool_name, tool_input)`；
  3. 同意 → `Allow(updated_input=tool_input)`；拒绝或超时 → `Deny(message=message or "用户拒绝了这个操作，不要重试同样的操作")`；
  4. 回调里任何异常 → `Deny("确认通道出错（…），这一步没有执行，可以让用户重发一次")`。
- **文件隔离钩子**（PreToolUse，三档都生效）：`guard.check_tool(spec.policy(), tool_name, tool_input, input_data.get("cwd") or spec.cwd)`；有原因 → 返回
  `{"hookSpecificOutput": {"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason": 原因}}`；否则 `{}`。
  回调自己 try/except：出异常也返回 deny（原因写“文件隔离检查出错”），再加 `on_failure="block"` 兜底——和 `guard.py` 钩子“出错按拒绝处理”一致。
- **提问工具**：进程内 MCP 服务 `projector`，一个工具 `ask_user`，说明文字和参数结构（`questions[{question, header, options[{label, description}], multi_select}]`）照搬 `approval_mcp.py`；函数体就是 `text = await approvals.wait_question(sid, owner_id, questions)`，返回 `{"content":[{"type":"text","text": text}]}`。出异常返回“没能弹出问题（…），请直接在回答里问用户。”
  外部服务里重复的 `mcp__center__ask_user`、`mcp__center__approve` 放进 `disallowed_tools`，模型看不到；自动放行名单里 `mcp__center__ask_user` 换成 `mcp__projector__ask_user`。`approval_mcp.py` 不改。
- **日志**：和 `cli` 模式同一个文件 `data/logs/claude_<sid>.log`，每次新建客户端写一行头（时间、`[sdk]`、可执行文件），stderr 逐行追加，保留最后 50 行给报错用。

### 4.3 `runner.py`（小改）

- `runner_mode()`、`sdk_idle_seconds()`。
- `Run` 加 `stop_fn: Callable | None = None`。
- `_begin_turn`：`mode = runner_mode()`。`sdk` 时：`sdk_runner.availability()` 有原因 → `HTTPException(500, 上面那句)`（在登记 `RUNS` 之前）；否则在原来 `build_command` 的位置改成 `spec = build_sdk_spec(...)`，`run.stop_fn = lambda: sdk_runner.request_stop(sid)`，`asyncio.create_task(_drive(run, prompt, [], cwd, spec))`。`cli` 时一行不变。
- `build_sdk_spec(claude_bin, sess, owner, extra_dirs)`：和 `build_command` 用同一套名单和规则。把“三档各自的自动放行名单和 ask 规则”抽成一个小函数给两边用，**`build_command` 的输出一个字都不能变**（有测试盯着）。`sdk` 模式下不写 `settings_<sid>.json`、`guard_<sid>.json`、`<sid>.json`，只写 `hint_<sid>.txt`。
- `_drive(run, prompt, cmd, cwd, spec=None)`：`spec` 不为空时 `final = await sdk_runner.run_turn(run, prompt, spec, lambda ev: _on_event(run, ev))`，其余（入库、用量、收尾、`dispatch_queue`）完全共用。
- `stop_session`：`if run and (run.proc or run.stop_fn)`；有 `stop_fn` 调它，否则 `_kill_tree`。
- `sdk_close_session(sid)`：给 `sessions_api.delete_session` 用（没加载过 `sdk_runner` 就什么都不做）。

### 4.4 其他文件

- `auth_api.py`：设置接口加上 §3 的字段。
- `sessions_api.py`：`delete_session` 里调一次 `runner.sdk_close_session(sid)`。
- `server.py`：`lifespan` 里起一个每 30 秒调 `close_idle()` 的后台任务，退出时取消它并 `close_all()`；`main()` 里多打印一行“运行方式”。不动静态文件挂载。
- `requirements-sdk.txt`（新）：`claude-agent-sdk>=0.2.180,<0.3`。`requirements.txt` 不变。
- `config.example.bat`：加注释掉的 `RUNNER_MODE`、`SDK_IDLE_SECONDS` 示例。
- `README.md`：新增一节（见 §8 第 5 步）。

## 5. 常驻进程的生命周期

| 时刻 | 行为 |
| --- | --- |
| 会话在 `sdk` 模式下发第一条消息 | 建客户端（冷启动，和现在一轮的启动耗时相当），有 `claude_session` 就 `resume` |
| 同一会话后续消息 | 复用，直接 `query()` |
| 指纹变了 | 关旧建新，`resume` 续上 |
| 空闲超过 `sdk_idle_seconds`（默认 10 分钟） | 后台任务关掉；下次发消息冷启动 + `resume` |
| 客户端数到 `SDK_MAX_CLIENTS` | 新建前先关最久没用的空闲客户端；全都在忙时不限制（正在跑的轮数本来就受 `max_concurrent` 限制） |
| 用户点停止 | `interrupt` → 等 5 秒 → 关闭这个客户端 |
| 轮次超时（`CLAUDE_TASK_TIMEOUT`） | 强制关闭（杀进程树） |
| `claude` 自己退出或崩溃 | 进行中的那一轮按错误收尾；从池里摘掉；下一轮自动重建 |
| 删除会话 | 关闭它的客户端 |
| 管理员切回 `cli` | 空闲的立即关；在跑的跑完后关 |
| 服务正常退出 | `lifespan` 退出时 `close_all()`（强制，杀进程树） |
| 服务被强杀 | SDK 的 `atexit` 兜不住；Windows 上可能残留 `claude.exe`（现在的 `cli` 模式被强杀时也一样）。重启恢复逻辑（`recover_runs`）不变：`active_runs` 里的轮次记为中断 |

排队、并发上限、重启恢复都在 `_begin_turn` / `_drive` / `dispatch_queue` / `recover_runs` 这一层，两种模式共用，不用改。

## 6. 功能对应关系

| 功能 | `cli` 模式（不变） | `sdk` 模式 |
| --- | --- | --- |
| 逐字输出、思考、`delta_reset`、工具步骤 | 解析 stdout 的 stream-json | 同样的原始事件，从 `StreamEvent` / `AssistantMessage` 取；经同一个 `_on_event` → `broadcast`，事件格式和 `seq` 不变 |
| 权限三档 | `--allowedTools`、`--settings` 的 ask 规则、`--permission-mode` | 同一套名单和规则，传给 `ClaudeAgentOptions` |
| 权限确认 | `--permission-prompt-tool mcp__center__approve` → `approval_mcp.py` → HTTP → `approvals` | `can_use_tool` → `approvals.wait_approval`（同一个卡片流程） |
| Claude 提问 | `mcp__center__ask_user` → HTTP → `approvals` | 进程内工具 `mcp__projector__ask_user` → `approvals.wait_question` |
| 文件隔离 | PreToolUse 命令钩子 `guard.py` + 确认前兜底 | 进程内 PreToolUse 钩子调 `guard.check_tool`（出错按拒绝）+ `can_use_tool` 里兜底；deny 规则照旧 |
| 知识库、技能、读文档工具 | 外部 stdio 服务 `approval_mcp.py` | 同一个外部服务，不改 |
| 技能插件目录 | `--plugin-dir` | `plugins=[{"type":"local",…}]`（SDK 翻成同一个参数） |
| 停止 | 杀进程树 | `interrupt` 后关闭客户端 |
| 超时 | 定时器杀进程树 | 强制关闭客户端 |
| 排队、并发上限、重启恢复 | `runner` | 共用 |
| 用量和费用 | `usage.record_turn(final)` | `ResultMessage` 还原成同形的 `final`，同一个函数 |
| 会话续接 | `--resume` | `resume=`；两种模式读写同一份 Claude 会话存档，来回切都能接上 |
| 工作目录、`--add-dir`、deny 规则、附加提示词 | 命令行参数 | 对应的选项；提示词仍走文件 |
| “确认通道出故障”的提示（`warn_perm`） | 有 | 不需要（没有外部确认通道）；回调出错时直接拒绝并把原因告诉 Claude |

需要前端配合的地方：**没有新的事件类型**，聊天界面不用改。唯一建议的前端改动是管理后台的设置页加一个“运行方式”选择（读写 `runner_mode`，`sdk_available=false` 时提示原因）。没有这个界面时可以用环境变量 `RUNNER_MODE` 或直接调 `PUT /api/admin/settings`。

## 7. 测试（`tests/test_sdk_runner.py`，不依赖真的 `claude` 和真的 SDK）

用假的 SDK 模块（`monkeypatch.setattr(sdk_runner, "_load_sdk", …)`）：假的 `ClaudeSDKClient`（记录选项、`connect`/`query`/`interrupt`/`disconnect` 调用，按脚本吐消息，能模拟崩溃和挂起）、消息类、`HookMatcher`、`PermissionResultAllow/Deny`、`tool`、`create_sdk_mcp_server`。

覆盖：
1. 事件转换：`delta_reset`、`thinking`、`delta`、`tool` 的顺序和内容；经 `_on_event` 后带 `seq`；最终消息入库。
2. 选项拼装三档：标准（ask 规则在 settings 里、名单）、严格（名单、无 settings）、完全放行（`bypassPermissions`）；`disallowed` 含 deny 规则和两个被替换的工具；`resume`、`cwd`、`add_dirs`、提示词文件、插件目录、`cli_path`。
3. 权限回调：同意、拒绝、超时（把 `APPROVAL_TIMEOUT` 调小）各自的返回和事件消息；回调出异常 → 拒绝。
4. 文件隔离：钩子对别人工作区的 `Read`、`Bash cat` 返回 deny，对自己的返回 `{}`；完全放行档下钩子照样挂着；`can_use_tool` 的兜底不弹卡片直接拒绝并记“⛔”消息；钩子内部出异常 → deny。
5. 提问：进程内 `ask_user` 弹出问题卡片，回答、跳过、超时三种返回文字和现在一致。
6. 停止：`interrupt` 被调用、消息记为“已停止。”、客户端被关闭；`interrupt` 没反应时强制关闭。
7. 空闲回收：`close_idle` 关掉超时的、不动在忙的和没超时的；池满时淘汰最久没用的空闲客户端。
8. 异常退出：轮次中途崩溃 → 错误消息、`RUNS` 清空、下一轮新建客户端且带 `resume`。
9. 用量入账：`ResultMessage` 的 `model_usage` / `usage` 写进 `usage_turns`。
10. 开关：默认 `cli`；设置优先于环境变量；非法值按 `cli`；`sdk` 模式但包不可用 → 500 且文案含“切回 cli”，没有残留的 `RUNS` / `active_runs`；设置接口的新字段；切回 `cli` 后关闭空闲客户端、下一轮走 `run_claude`。
11. 复用和重建：连续两轮只 `connect` 一次；切换完全放行后重建。
12. `resolve_cli`：模拟 Windows + `.cmd` → 找到 exe 或报错。
13. `approvals` 重构后的 HTTP 接口：现有测试不改即通过。

## 8. 提交步骤

1. **计划**：本文件。
2. **开关和接线**：`approvals.py` 重构；`sdk_runner.py` 先只有 `availability()`、`TurnSpec` 和接口骨架；`runner.py`、`auth_api.py`、`sessions_api.py`、`server.py` 接线；`requirements-sdk.txt`；开关相关测试。此时 `sdk` 模式能走到 `run_turn`。
3. **`sdk_runner` 实现**：客户端池、事件转换、权限回调、钩子、提问工具、停止、回收；`tests/test_sdk_runner.py` 其余用例。
4. **实测和修正**：本机用真的 `claude` 跑一轮（能跑到哪算哪），按结果修。
5. **README**：一节“运行方式（cli / sdk）”——开关、装依赖、切回、Windows 启用前的验证清单；`config.example.bat`。

每一步之后跑 `.venv/bin/python -m pytest -q`，全过才提交。

## 9. 只能在 Windows 实机（和 DeepSeek）上验证的事项

1. `pip install -r requirements-sdk.txt` 在目标机的 Python 3.10 上能装上（wheel 约 300 MB）。
2. `find_claude()` 找到的是不是原生 `claude.exe`；是 `claude.cmd` 时报错文案是否清楚，装了原生版或 wheel 自带的 `claude.exe` 后能否自动用上。
3. 服务用的是不是 Proactor 事件循环（`start.bat` 的启动方式下应该是）。
4. 第一轮和后续轮的耗时对比（预期后续轮明显变快）。
5. 逐字输出、思考、工具步骤显示正常；中文不乱码（提示词文件、Git Bash 输出、stderr 日志）。
6. 三档权限：标准档危险命令弹确认；严格档改文件弹确认；完全放行档不弹。同意、拒绝、超时各一次。
7. 文件隔离在三档下都拦得住（读别人工作区、`cat` 别人的文件），尤其完全放行档。
8. `ask_user` 弹出问题卡片，回答、跳过。
9. 知识库（`kb_search`、`kb_write`）、技能（`skill_list`）、`read_document` 可用——外部工具服务在 SDK 起的 `claude` 下能启动。
10. 停止：点停止后界面显示“已停止”，任务管理器里没有残留的 `claude.exe` / `node.exe` / `python.exe`（工具服务）/ `bash.exe`。
11. 空闲 10 分钟后 `claude.exe` 自动消失；再发消息能接上上下文。
12. 服务窗口关掉后没有残留进程；强杀服务后的残留情况。
13. 无控制台方式启动服务时会不会弹黑窗。
14. 老会话（`cli` 模式下聊过的）切到 `sdk` 后能接着聊；再切回 `cli` 也能。
15. DeepSeek：以上 4~9 在 `ANTHROPIC_BASE_URL` 指向 DeepSeek 时重做一遍；特别看思考内容、工具调用、用量（DeepSeek 下 `total_cost_usd` 可能没有意义）。
16. 排队和并发上限在 `sdk` 模式下照常工作；重启服务后进行中的轮次显示“被中断”。

## 10. 实现后的修订（与上文不一致的地方，以这里为准）

- **外部工具服务的配置走文件，不走 `mcp_servers`**。SDK 会把 `mcp_servers` 整个序列化进 `--mcp-config` 命令行参数，里面有内部令牌 `CENTER_TOKEN`，同机的人用进程列表就能看到（本机冒烟时发现）。改为：`mcp_servers` 里只放进程内的 `projector`；外部的 `center` 写进 `data/mcp/<sid>.json`（和 `cli` 模式同一个文件，受 deny 规则保护），用 `extra_args={"mcp-config": 路径}` 传。实测两个 `--mcp-config` 可以并存。所以 `sdk` 模式下会写 `hint_<sid>.txt` 和 `<sid>.json` 两个文件。
- **`on_failure="block"` 要看 Claude Code 版本**。本机的 2.1.280 不认这个参数（`connect()` 直接报错），2.1.321 认。实现为：先带上连接，报错文字里有 `on_failure` 就去掉重连，并在会话日志里记一行。去掉后钩子“出错即拒绝”只靠回调自身的 try/except。
- **停止收尾期间不复用客户端**：加了 `stopping` 标记，避免用户停止后立刻发的下一条消息被收尾时的关闭打断。
- `SDK_MAX_CLIENTS` 下限是 1，没有和并发上限取大（`sdk_runner` 不能 import `runner`）；全部在忙时本来就不限制，效果相同。
- `CanUseToolShadowedWarning` 用进程级过滤器压掉（`catch_warnings` 跨 await 会在多个客户端之间互相覆盖）。
