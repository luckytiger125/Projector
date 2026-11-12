# 阶段三实施说明：核心（基础库、状态、路由、登录、外壳、首页、对话）

这份说明给实现的人看。总体方案在 `2026-11-frontend-vite.md`，先读它的第 2、3、4、6、7、8、9、10 节；这里只写阶段三要交付什么、怎么分步、怎么验收。两份文档冲突时以这份为准，发现冲突要在汇报里说。

## 背景

- 阶段一已完成：`web/` 是 Vite + TypeScript + Preact 工程，老代码原样放在 `web/src/legacy/{ui,app,admin,kb}.js`，由 `web/plugins/legacy.ts` 拼成一个模块；页面骨架是 `web/index.html` 里的静态 DOM；构建产物在 `static/app/`，要提交。
- 阶段二已完成：`web/src/styles/tokens.css` 是设计变量；`docs/design/` 是用户已经同意的静态样稿（`mock.css` 是样式写法，`chat.html`、`board.html`、`dialogs.html` 是本阶段要对照的页面）。
- 用户的要求：**外观按样稿重做，不是把老样式搬过来；功能和界面文字不变。**

## 本阶段结束时应该是什么样

1. 登录、外壳（竖栏、值班目录、用户卡片和菜单、命令面板、提示条、通用对话框）、值班板、对话这几块由 Preact 组件渲染，样式用 `tokens.css` 的变量，长相对照样稿。
2. 文件库、知识库、技能、用量、管理后台、设置、手机二维码这些弹层**仍由老代码渲染**，功能照常能用（外观暂时是旧的，这是预期的）。
3. 网址路由生效：`/`、`/s/new`、`/s/{id}`、`/s/{id}/steps`；直接打开、刷新、前进后退都对；没登录时打开深链接，登录后落到原地址。其余路径（`/files` 等）本阶段可以只做到“打开对应的老弹层”，或者先不接，在汇报里说明做了哪种。
4. 流式输出时只更新正在变的那一条，不整页重画；几百条消息的会话滚动顺畅。
5. `npm run check`、`npm run build`、`pytest` 全过，`static/app/` 是最新构建。

## 分两步做

每一步做完都停下来汇报，等审查通过再做下一步。

### 第一步：基础库、状态、事件、路由（界面不变）

新增代码，但页面仍然全部由老代码渲染，用户看不出变化。

- `web/src/lib/`：`api.ts`（带 `Authorization` 头的请求封装，401 处理，错误文案沿用老代码）、`format.ts`（时间、大小等格式化，从老代码里搬，行为不变）、`markdown.ts`（marked + DOMPurify，净化配置和老代码完全一致）、`icons.tsx`（老代码 `icon()` 用到的图标）、桌面壳相关的探测。
- `web/src/stores/`：按总方案第 3 节的 `auth, sessions, chat, events, composer, ui`。`files` 留到阶段四。
- `events.ts`：SSE 连接和 `seq` 去重，规则照总方案“SSE 和 seq 去重”一小节，一条都不能少（`snapSeq`、`listSeq`、`resync`、3 秒后带 `last_id` 手动重连、`/api/me` 检查）。先把老代码里对应的实现逐行读懂再写。
- `web/src/router.ts`：自己写的 History 路由，照总方案第 4 节。
- 给纯逻辑写单元测试（`vitest`，加进 `devDependencies` 和 `npm run check`）：`seq` 去重、路由解析和生成、格式化、Markdown 净化（`<script>`、`onerror`、`javascript:` 链接都要被去掉）。
- 这一步**不要**让新旧两套代码同时连 SSE 或同时发请求。新的 store 写好、测好，先不接到页面上。

### 第二步：组件和桥接

- `web/src/features/` 下按功能分目录，组件和它的 css 放一起（如 `features/chat/chat.css`）。至少：`auth`（登录、首次创建管理员）、`shell`（竖栏、值班目录、用户菜单、命令面板、提示条、对话框）、`home`（值班板）、`chat`（头部、消息列表、思考块、工具步骤、确认卡片、提问面板、输入区含引用和技能选择、排队和停止、分页加载更早消息并保持滚动位置、步骤记录页）。
- 样式从 `docs/design/mock.css` 对应的段落拆过来，只用变量。老的 `base.css` / `almanac.css` 里被新组件取代的规则要删掉，不要留着互相打架；老弹层还在用的规则保留。
- `web/index.html` 里交给组件的那部分静态 DOM 删掉，换成挂载点。**一块 DOM 只能有一个主人**：要么组件，要么老代码。
- `web/src/legacy/bridge.ts`：老弹层代码还会读写一些全局变量、调用一些全局函数（当前会话、当前用户、`toast`、`dialog`、`openSession`、引用文件到输入区等）。把这些接到新的 store 和组件上，让老弹层照常工作。老代码里已经被组件取代的函数要删掉，不要留两份实现。先用搜索把老弹层依赖的全局列全，写在 `bridge.ts` 顶部的注释里。
- 手机端（≤720px）：两级导航照样稿，首页用“值班目录 / 值班板”两个页签切换，对话页顶栏有返回；没有横向滚动。
- 键盘：提问面板的数字键和回车、命令面板的快捷键、输入区的 Enter / Shift+Enter、`@` 引用，行为和老代码一致。

## 不许做的事

- 不改后端。`server.py` 只允许动静态文件挂载、首页和前端路由回退那几行；`runner.py`、`approvals.py` 等一律不碰。接口和事件格式不动，发现接口问题写在汇报里。
- 不改界面文字。文字从老代码里原样搬。
- 运行时不依赖外网：不引入网络字体、CDN 脚本；新依赖要有明确理由并写进 `web/THIRD_PARTY.md`。
- 令牌不出现在网址里；改动类请求带 `Authorization` 头；Markdown 必须净化。
- **不要执行 `git add`、`git commit`、`git stash`、切分支。** 改完把工作区留着，由派活的人审查后提交。
- 不动 `/Users/q/Desktop/dywcc/Projector` 和 `/Users/q/Desktop/dywcc/Projector-agent-sdk`。不在仓库里产生 `data/`。
- 不用按名字匹配的 `pkill`；自己起的进程用 `kill -9 <PID>` 停。

## 怎么跑和怎么测

- Node 在 `/Users/q/.local/node-v25.8.1/bin`（加到 `PATH` 前面）；Python 用仓库里的 `.venv/bin/python`。
- 前端：`cd web && npm run check && npm run build`。后端测试：仓库根目录 `.venv/bin/python -m pytest -q`。
- 本地实例：草稿目录 `S=/private/tmp/claude-501/-Users-q-Desktop-dywcc-Projector-frontend-vite/9bc559d0-9f74-48c8-a4f2-6c8b4fe7bc4e/scratchpad`。
  - `sh $S/run.sh 18282` 起一个用当前代码的实例，数据在 `$S/inst-18282/`，PID 在 `$S/inst-18282/pid`；改了 `server.py` 或重新构建后按需重启。**只用 18282 这个端口**，18280（迁移前的基线，可以对照行为）和 18281 是别人的，不要停。
  - `.venv/bin/python $S/seed.py 18282` 建管理员、一个普通用户、一个分区和几个会话；测试账号在 `seed.py` 里，只在这个本地实例上用，不要写进汇报。
  - 实例用的是假的 `claude`（`$S/bin/fake_claude.py`）：消息里带“确认”会弹确认卡片，带“提问”会弹两道题（第二道多选），带“长文”输出很长，带“慢”输出很慢。
- 有浏览器工具就用它在桌面宽度和 380 像素宽度各走一遍下面的清单；没有就把没能实测的项目在汇报里列出来，不要写成已验证。

### 第二步的验收清单

登录和首次创建管理员；深链接登录后回到原地址；会话列表和分区分组；新建、改名、删除会话；发送；排队和取消排队；停止；流式输出和“思考中”；工具步骤折叠；确认卡片同意和拒绝；提问面板（鼠标和键盘、多选、其他、跳过）；加载更早消息后滚动位置不跳；引用文件和 `@`；技能选择；完全放行开关；别人的会话只读提示；步骤记录；命令面板；断线重连和 `resync`；刷新、前进、后退；老弹层（文件库、知识库、管理后台、用量、设置）都还能打开和操作；控制台没有报错；380 像素下没有横向滚动。

## 汇报要写什么

改了哪些文件（按目录归类）；`npm run check`、`npm run build`、`pytest` 的原始输出；验收清单逐项标“已实测 / 未实测”；`bridge.ts` 接了哪些全局；和这份说明或总方案不一致的地方及原因；发现的接口问题或老代码里的缺陷（只记录，不修）。
