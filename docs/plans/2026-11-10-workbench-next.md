# Projector 后续总计划（基于 fork 的 workbench-ui）

日期：2026-11-10
工作分支：`workbench-next`（从 `laifu0013-design:workbench-ui` 的 6db7ec6 切出）
完成后：合并进 `main`。

## 起点

fork 分支已经完成：删除 ESP32/语音模块、网页端依赖本地化（`static/vendor/`）、年鉴壳层新界面、分区和用量的**前端**。

fork 分支没完成：分区和用量的**后端**（前端在调用，接口 404）、文档缓存、全部测试。详细设计已经写在
`docs/superpowers/plans/2026-10-30-workbench-enhancements.md`（下称“详细计划”），本文件只定范围、顺序和补充项，不重复其中的细节。

## 通用规则

- 所有工作在 `workbench-next` 上做，每个阶段完成且测试通过后提交一次，不推送。
- 测试必须隔离：走临时目录，不碰 `data/center.db`，不在真实的文件库、知识库、工作区下写东西（详细计划 §0、§3）。
- 目标机器是 Windows，开发机是 macOS：路径处理不能写死任一平台，测试要在 macOS 上能跑。
- 接口契约以**已有前端的调用**为准（`static/app.js`、`static/admin.js`、`static/kb.js`）；前端和详细计划不一致时，先对齐到前端实际读的字段，并在提交说明里写明差异。
- 不新增外网依赖。不改动与本阶段无关的代码。

## 第一批（本次执行）

### A0 测试基础
- `store.py`：`DATA` 支持环境变量 `PROJECTOR_DATA`；新增 `db_insert` / `db_many`（详细计划 §3）。
- `tests/conftest.py`、`tests/test_isolation.py`、`requirements-dev.txt`（pytest）。
- 本机建 `.venv` 装依赖（已在 `.gitignore`）。

### A1 用量后端（详细计划 §4，P1）
- `usage.py`：`normalize_usage`、`record_turn`、`log_failure`、聚合接口。
- `server.py`：`add_message` 的消息 id 竞态修复、`_drive()` 记录用量、挂载路由。
- `tests/test_usage.py`：详细计划 §4.4 列出的全部用例。
- 完成标准：前端用量入口（`/api/usage/me`、`/api/usage/me/turns`）和管理页（`/api/admin/usage`、`/api/admin/usage/turns`）不再 404，字段与前端读取一致。

### A2 分区后端（详细计划 §6，P3）
- `sections.py`：分区增删改查、归档与恢复、权限。
- `store.py`：`sections` 表、`sessions.section_id`、`users.last_section_id` 迁移。
- `server.py`：会话创建/更新/视图带分区。
- `kb.py`、`approval_mcp.py`：笔记 `section` 字段，搜索/图谱/写入支持分区，分区改名带回滚。
- `tests/test_sections.py`：详细计划 §6.5 的全部用例。
- 完成标准：侧栏分区、会话归区、知识库分区筛选、管理后台分区页签全部走通。

### A3 文档缓存（详细计划 §5，P2）
- `kb.py`：`extract_text` 拆两层，持久缓存、失效、空文本和扫描件状态、清理。
- `server.py`：`_deny_rules()` 加缓存目录。
- `approval_mcp.py`：`read_document` 按状态提示。
- 管理接口 `/api/admin/doc-cache`、`/api/admin/doc-cache/prune`。
- `tests/test_doc_cache.py`：详细计划 §5.6 的全部用例。

### B1 前端体验修复（与 A0/A1 并行，只动 `static/` 和 `desktop/ui/`）
- **流式增量渲染**：现在每来一个字就整页重绘（`static/app.js` 的 `renderMessages` 被 `delta` 事件触发，整体替换 `#list`）。改成：流式期间只更新正在输出的那一条消息的正文和步骤，历史消息的 DOM 不动；用 `requestAnimationFrame` 合并同一帧内的多次更新。保持现有外观、滚动跟随、确认卡片、提问卡片的行为不变。
- **桌面设置页去掉 Google Fonts**（`desktop/ui/index.html`），改用本机字体栈。
- **清理残留**：前端里如果还有语音/板子相关的死代码或文案，删掉。

### A4 收尾（A1–A3 之后）
- 老数据迁移：数据库里已有的“板子”账号（`role='device'`）设为停用；历史语音会话保留为只读记录，归到第一个管理员名下可查看。不删数据。
- README 更新：去掉过期内容，补上用量、分区、文档缓存的说明和测试运行方法。
- 版本号统一改为 0.7.0（`server.py`、`desktop/src-tauri/tauri.conf.json`、`Cargo.toml`、`index.html` 的资源版本参数）。
- 跑全部测试，启动服务做一次冒烟检查（登录、建会话、分区、用量页）。

## 第二批（本次不做，单独立项）

这些改动大、需要在 Windows 实机上验证，不放进本次合并：

1. **调用方式换成常驻会话**：用 Claude Agent SDK 取代“每轮起一个 `claude -p` 进程”，权限确认改用 SDK 回调，去掉 `approval_mcp.py` 的确认通道。需先验证 Windows 和第三方模型（DeepSeek）下可用。
2. **运行状态落库**：进行中的任务、待确认、待回答写进数据库，重启后可恢复或标为“已中断”。
3. **任务排队和并发上限**：运行中再发消息进入队列；全局限制同时运行的任务数。
4. **事件流带序号、断线补发**；实时推送思考和工具返回。
5. **登录令牌改用 Cookie**，不再放在网址参数里。
6. **会话消息分页**。
7. **`server.py` 拆模块**（路由、运行器、权限、事件）。
8. **前端工程化**：迁到 Vite + 组件化，弹窗改为带网址的页面，手机端单独布局。
9. **服务端 CI**：推送时自动跑测试。

## 执行方式

子代理（Sonnet）按顺序执行，后端三个阶段都会改 `server.py` 和 `store.py`，所以串行：

1. 并行：`A0 + A1`（后端）｜`B1`（前端）
2. `A2`
3. `A3`
4. `A4`，然后主会话核对、跑全部测试、合并进 `main`。
