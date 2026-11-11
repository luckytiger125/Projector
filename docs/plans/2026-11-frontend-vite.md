# 前端迁移到 Vite 并组件化

日期：2026-11-11　分支：`frontend-vite`（从 `main` 8cbecb5 切出）

## 0. 现状和目标

现在的前端是四个手写脚本加一个大页面，没有构建步骤：

| 文件 | 行数 | 内容 |
|---|---|---|
| `static/index.html` | 1075 | 约 810 行内联样式 + 全部静态骨架（主界面、各弹窗、登录页） |
| `static/almanac.css` | 267 | “年鉴”外观，覆盖在内联样式之上 |
| `static/ui.js` | 170 | 图标、水果头像、提示条、主题 |
| `static/app.js` | 2109 | 登录、会话、消息、流式输出、确认和提问、输入区、文件面板、技能、命令面板、桌面壳 |
| `static/kb.js` | 750 | 知识库（首页、笔记、图谱） |
| `static/admin.js` | 444 | 管理后台 |
| `static/vendor/` | — | marked、DOMPurify、jszip、docx-preview、xlsx、qrcode 的压缩文件 |

问题：全部状态是 `app.js` 顶层的几十个 `let`，四个脚本靠全局变量互相调用；界面靠拼 HTML 字符串整块重画；弹窗没有网址，刷新就丢；手机端只是把桌面布局挤窄。

目标：换成 Vite 工程、拆成组件、状态集中管理、主要弹窗有网址、手机端有专门布局，**并借组件化把界面精修一遍**。

> **2026-11-11 修订（用户确认）**：最初的要求是“外观保持不变”。用户改了这一条：要的是美观度，不是把旧界面原样搬过来。确认的方向是**保留“年鉴”风格，精修**——纸面底色、深蓝侧栏、衬线标题这套气质留着，但间距、层级、卡片、输入区、弹窗、动效、手机端都按组件重新设计，不照搬旧样式。对话区、首页和侧栏、弹窗类页面、手机端四处都要做。**功能和界面文字仍然不变。** 设计怎么做见第 6 节，阶段安排见第 8 节。

硬约束：目标台式机只有 Python；运行时不连外网；后端接口和事件格式不动；`server.py` 只改首页、静态挂载和前端路由回退。

## 1. 框架和语言

**Vite + TypeScript + Preact + @preact/signals，路由自己写（约 100 行）。**

理由：

- **体积小。** Preact 加 signals 压缩后约 6 KB（gzip），这个应用是内网工具，产物还要提交进仓库，越小越好。
- **流式输出天然不整页重绘。** signals 是细粒度订阅：`live.text` 变了，只有读它的那个组件重画。现在 `app.js` 为了做到这一点手写了 `scheduleLive` 和“只更新 live 节点”的逻辑，换成 signals 后这是默认行为。
- **能一块一块迁。** Preact 组件可以挂到页面上任意一个现有节点里，所以老代码和新组件能在同一个页面里共存，每个阶段结束应用都完整可用（见第 8 节的桥接办法）。
- **规模合适。** 全部前端约 3500 行脚本、十来个界面，用不着更重的框架和状态库。
- **TypeScript**：后端事件和接口返回的字段很多（会话、消息、确认、提问、文件条目），有类型后改动时能被检查出来；CI 里的 `node --check` 也就能换成真正的类型检查。

版本（写计划时 npm 上的最新版，锁在 `package-lock.json`）：vite 8、typescript 7、preact 11、@preact/signals 2、@preact/preset-vite 2。

第三方库改从 npm 装，版本钉在现在 `static/vendor/` 用的那一版，避免行为变化：marked 12.0.2、dompurify 3.1.6、jszip 3.10.1、docx-preview 0.3.5、xlsx 0.18.5、qrcode-generator 1.4.4。docx-preview、xlsx、jszip、qrcode 只在预览或扫码时才用，改成动态 `import()`，单独分包，不进首屏。

## 2. 目录结构

```
web/                      前端源码（只有开发和 CI 需要 Node）
  package.json  package-lock.json  tsconfig.json  vite.config.ts
  index.html              入口页，只剩 <div id="app"> 和登录前的极简骨架
  src/
    main.tsx              启动：种 cookie、取 /api/me、挂载 <App/>
    app.tsx               外壳：左栏、会话列表、主区域、弹窗层、登录层
    router.ts             History API 路由（见第 4 节）
    lib/
      api.ts              fetch 封装：Authorization 头、X-Event-Seq、401 处理
      md.ts               Markdown：知识库链接 → marked → DOMPurify
      icons.tsx avatars.tsx  图标和水果头像
      desktop.ts          桌面壳（Tauri）调用的封装
      format.ts           时间、大小、路径缩写等小工具
      types.ts            后端数据的类型
    stores/               状态（见第 3 节）
      auth.ts sessions.ts chat.ts events.ts composer.ts files.ts ui.ts
    components/           通用部件：Dialog、Toast、Overlay、Seg、Orb……
    features/
      login/              登录、首次创建管理员
      shell/              左栏、会话列表、分区、用户菜单
      home/               值班板
      chat/               消息列表、live 条目、工具步骤、确认卡片、提问面板、输入区、标题栏
      files/              文件面板、预览、回收站、公共库上传、本机文件夹同步
      skills/             技能列表、详情、提交
      kb/                 知识库首页、笔记、图谱
      admin/              管理后台各页签
      account/            头像、密码、用量、手机扫码
      palette/            命令面板
    styles/
      tokens.css          设计变量：颜色、字号、间距、圆角、阴影、动效（阶段二新增）
      base.css            过渡期：原 index.html 的内联样式，迁一块删一块
      almanac.css         过渡期：原 almanac.css，迁一块删一块
    legacy/               过渡期：老脚本原样放这里，迁完一块删一块，阶段六清空
static/
  app/                    构建产物（提交进仓库，见第 5 节）
    index.html
    assets/*-[hash].js|css
  icon-192.png icon-512.png …   其余静态文件不动
```

样式用普通 CSS，不用 CSS-in-JS。阶段一先把两份旧样式原样搬进 `styles/`（保证脚手架阶段界面不变）；之后每迁一块界面，就按第 6 节的设计**重写这一块的样式**，放在组件旁边（`features/chat/chat.css` 这样），用 `styles/tokens.css` 里的设计变量，同时从旧样式里删掉对应的规则。迁完后 `base.css` 和 `almanac.css` 不再存在。

## 3. 状态管理

全部用 signals，放在 `stores/` 下的普通模块里，组件直接读。不引状态库。

| 模块 | 状态 | 说明 |
|---|---|---|
| `auth.ts` | `token`、`me` | `token` 存 `localStorage`，只通过 `Authorization` 头发出，**不进网址**。启动时 `POST /api/session-cookie` 种 HttpOnly cookie，给 EventSource、图片、下载这些带不了头的 GET 用（和现在一样）。 |
| `sessions.ts` | `sessions`、`sections`、`currentSection`、`viewMode`、`seen`、`listSeq` | 会话列表和分区。`upsertSession(session, stale)` 保留现有规则：事件序号不比列表快照新就不覆盖。分组（今天 / 昨天 / 7 天内 / 更早）是 `computed`。 |
| `chat.ts` | `current`、`currentSess`、`messages`、`hasMore`、`olderState`、`live{text,thinking,tools}`、`thinkOpen`、`approvals`、`questions`、`askState`、`links`、`liveSteps`、`snapSeq` | 当前会话的一切。`live` 的三个字段各是一个 signal：文字增量只动文字节点，思考块和工具步骤各自更新。`messages` 是数组 signal，列表按消息 id 做 key，新增一条不会重画已有条目。 |
| `events.ts` | `conn`（连接状态）、`lastEventId` | SSE 连接和事件分发，见下。 |
| `composer.ts` | `refs`、`skill`、`workDir`、`mySkills` | 输入区的引用、技能、工作目录。输入框本身不受控（不把每次按键写进状态），发送时读值。 |
| `files.ts` | 原 `F` 对象拆开：`roots`、`path`、`entries`、`sel`、`mode`、`searching`…… | 文件面板。 |
| `ui.ts` | `toasts`、`dialog`、`theme`、`paletteOpen` | 提示条、通用对话框、主题。 |

### SSE 和 `seq` 去重

现有逻辑原样搬到 `events.ts`，一条规则都不改，只是从散在 `connect()` 里变成一个有类型的分发表：

1. **连接**：`new EventSource("/api/events")`，浏览器自带的重连会带 `Last-Event-ID`，服务端从那之后补发。连接彻底断开（`readyState === 2`）时先请求 `/api/me` 判断是不是登录失效，不是就 3 秒后手动重连，带 `?last_id=<lastEventId>`。
2. **记序号**：每个事件带 `seq`，收到就更新 `lastEventId`。
3. **快照序号**：`openSession` 取会话数据时，接口返回 `seq`（`snapSeq`）；取会话列表时，响应头 `X-Event-Seq` 给出 `listSeq`。
4. **去重**：当前会话的事件如果 `seq <= snapSeq`，说明快照里已经包含，丢掉（`session` 事件除外，它走 `upsertSession` 的 stale 判断）。这保证了“先连 SSE 再取快照”和“先取快照再连 SSE”两种时序都不会重复或丢消息。
5. **`resync`**：服务端说补发不了（缓冲区已经滚掉），就整体重载：重取会话列表和当前会话。
6. **分发**：`session`、`session_deleted`、`approval`、`approval_done`、`question`、`question_done`、`message`、`delta_reset`、`delta`、`thinking`、`tool` 各一个处理函数，只改 store。组件不直接碰事件。

流式输出：`delta` 把文字追加到 `live.text`，Markdown 渲染节流到每帧一次（保留现在的 `requestAnimationFrame` 合并）；滚动条距底部不到 120px 才自动跟随（保留）。

## 4. 路由

用 History API，自己写一个小路由：一个 `route` signal（路径 + 查询 + `history.state`），`navigate()`、`replace()`、`back()`，监听 `popstate`。不引路由库——只有十来条路径，没有嵌套加载、懒加载数据这些需要库来解决的问题。

### 网址设计

| 网址 | 界面 | 桌面形态 | 手机形态 |
|---|---|---|---|
| `/` | 值班板 | 主区域 | 会话列表（第一级） |
| `/s/new` | 新对话（还没发第一条） | 主区域 | 全屏对话 |
| `/s/{id}` | 对话 | 主区域 | 全屏对话（第二级） |
| `/s/{id}/steps` | 这次对话的步骤记录 | 弹层 | 全屏页 |
| `/board` | 值班板 | 同 `/` | 全屏页（从会话列表进） |
| `/files`、`/files?path=…` | 文件面板，定位到某个目录或文件 | 弹层 | 全屏，列表 → 预览两级 |
| `/files/trash` | 回收站 | 弹层 | 全屏页 |
| `/kb`、`/kb/notes`、`/kb/notes?note=…`、`/kb/graph` | 知识库三个页签，可定位到某篇笔记 | 弹层 | 全屏，列表 → 笔记两级 |
| `/skills`、`/skills/{name}` | 我的技能、技能详情 | 对话框 | 全屏页 |
| `/usage` | 我的用量 | 对话框 | 全屏页 |
| `/mobile` | 手机扫码 | 对话框 | 全屏页 |
| `/admin/{tab}` | 管理后台（users / chats / library / review / files / usage / sections / settings） | 弹层 | 全屏页 |

不进网址的：头像、改密码、各种确认框、重名处理、命令面板、技能选择浮层、提问面板、登录页。它们是一步操作或依附于当前界面的临时状态，刷新后重现没有意义。文件面板的“选工作目录”和“引用文件”两种模式也不进网址（它们是输入区的一次选择动作）。

### 行为

- **弹层的背景**：桌面上文件、知识库、管理后台等是盖在主界面上的弹层。打开时把当时的主界面路径记进 `history.state.bg`（比如从 `/s/12` 打开知识库，网址变 `/kb`，背景仍是会话 12）。`history.state` 在刷新后还在，所以**刷新后弹层和背景都还原**。直接输入网址打开时没有 `bg`，背景就是值班板。
- **关闭弹层**：如果是从应用里点开的（历史里有上一条），关闭 = 后退；如果是直接打开的，关闭 = `replace` 到背景路径。这样后退键和关闭按钮行为一致，不会后退出应用。
- **前进后退**：弹层内部的切换（文件面板进目录、知识库切页签、后台切页签）用 `replace` 更新网址，不堆历史；打开和关闭弹层、切换会话用 `push`。所以后退一步 = 关一个弹层或回到上一个会话。
- **登录**：登录页是盖在上面的一层，**不改网址**。未登录打开 `/kb/graph`，看到登录页，登录成功后那一层撤掉，下面就是 `/kb/graph`。退出登录后回到 `/`。
- **会话不存在或无权**：`/s/{id}` 取不到时提示并 `replace` 到 `/`。非管理员打开 `/admin/*` 同样处理。
- **知识库有未保存的编辑**：离开前的确认（现在的 `kbBeforeClose`）接到路由的离开守卫上，后退键也会拦住。

### 服务端回退

`server.py` 只加这一处：把上面这些前缀（`s`、`board`、`files`、`kb`、`skills`、`usage`、`mobile`、`admin`）的 GET 请求都返回 `static/app/index.html`，带 `Cache-Control: no-cache`。用**明确的前缀清单**而不是“其余全部”，这样 `/api/…` 打错路径仍然是 404 而不是一个 HTML 页面，也不会盖住将来新增的后端路由。为它加一个小的后端测试（各前缀返回首页、`/api/nope` 仍是 404）。

## 5. 构建产物和“台式机没有 Node”

**做法：产物提交进仓库，放在 `static/app/`。**

- 仓库检出后：`static/app/index.html` 和带哈希的资源已经在那里，`start.bat` 直接能跑，不需要 Node。
- 发布包：`desktop.yml` 里的 `git archive … static …` 本来就打包整个 `static/`，产物自动在里面，打包命令不用改。
- 运行时不连外网：所有依赖都打进产物；没有 CDN、没有外链字体。

为什么不选别的办法：

- *只在 CI 构建、只放进发布包*：满足不了“仓库检出后直接运行”。现在的部署方式就有直接检出仓库运行的。
- *服务端启动时自动构建*：要求台式机装 Node，直接违反约束。

提交产物的代价和对策：

- **源码改了但忘了重新构建** → CI 里 `npm ci && npm run build` 之后 `git diff --exit-code static/app`，不一致就失败。
- **Windows 上检出换行符被改，哈希对不上** → `.gitattributes` 把 `static/app/**` 标成 `-text`，把 `web/**` 标成 `eol=lf`。
- **仓库里多出构建文件的改动噪音** → 接受。每个阶段的提交里产物和源码一起提交；评审时看 `web/` 的 diff 即可。

缓存：Vite 给每个 JS/CSS 文件名加内容哈希（`assets/index-a1b2c3.js`），内容变了文件名就变，所以资源可以放心被缓存；`index.html` 由服务端加 `Cache-Control: no-cache` 返回，每次都重新验证。原来 `?v=0.8.0-dev4` 那套手工版本参数删掉。

Vite 配置要点：`base: "/static/app/"`，`build.outDir: "../static/app"`，`emptyOutDir: true`。开发时 `npm run dev` 起 Vite 开发服务器，把 `/api`、`/static`、`/manifest.webmanifest` 代理到本机的 Python 服务端。

桌面壳（`desktop/`）不用改：它把窗口导航到服务端地址，注入的 `window.__TAURI__` 照旧可用；托盘的“刷新”是 `location.reload()`，有了网址后刷新会留在当前页面，比现在更好。

## 6. 界面精修

方向：**还是那本“年鉴”，但排得更讲究。** 不换配色体系，不换气质，不加花哨的东西；靠排版、留白、层级和细节把它做精致。字体只用系统自带的（运行时不连外网）：标题用宋体类衬线（Songti SC / Noto Serif CJK / SimSun），正文用系统黑体，数字和路径用等宽。

### 设计基础（`styles/tokens.css`）

旧样式里颜色、字号、间距是各处手写的数值，同一种东西有好几种写法。先定一套变量，所有组件只用变量：

- **颜色**：纸面（三级：底、卡片、凹陷）、墨色（四级：标题、正文、次要、禁用）、藏青（侧栏和主按钮）、朱红（唯一的强调色：待确认、未读、印章）、三种状态色（运行、成功、出错，都压低饱和度配纸面）。正文和次要文字对纸面的对比度不低于 4.5:1。
- **字号**：一条比例尺（12 / 13 / 14 / 16 / 20 / 28 / 40），标题衬线、正文无衬线；正文行高 1.7，中文阅读舒服。
- **间距**：4px 网格（4 / 8 / 12 / 16 / 24 / 32 / 48）。
- **线和圆角**：年鉴的味道主要来自细线和方正——分隔用 1px 发丝线和双线刊头，圆角统一 2–4px，不用大圆角；阴影只给浮起来的东西（弹层、输入区、菜单），一档浅一档深。
- **动效**：150ms（悬停、按下）和 220ms（弹层、展开）两档，同一条缓动曲线；`prefers-reduced-motion` 时全部关掉。
- **焦点**：所有可操作元素有清楚的键盘焦点环；可点的东西不小于 40px（手机 44px）。

### 各处怎么改

| 地方 | 现在的问题 | 精修后 |
|---|---|---|
| **对话区** | 正文横向铺满，长行难读；用户和 Claude 的条目区分弱；思考块、工具步骤、正文挤在一起；确认卡片像普通消息 | 正文限宽（约 72 个字符）居中成一栏，左侧留一条窄的“页边”放时间和角色；用户的话是带引线的短条目，Claude 的回复是正文；思考块和工具步骤做成页边上的一条细时间线，安静、可折叠；代码块和表格有自己的版式；确认卡片做成“签批单”——朱红标头、操作内容等宽展示、允许是主按钮；提问面板是从输入区上沿展开的一张纸，选项大而清楚、带数字键提示。 |
| **输入区** | 平贴在底部，按钮零散 | 一张浮起的纸：聚焦时描边加深；引用和技能标签在输入框上沿排成一行；左边是附加类按钮（引用、本机、技能），右边是发送 / 停止，主次分明；下方一行小字状态。 |
| **值班板** | 信息都在，但刊头、信息表、三栏之间节奏平 | 刊头放大并加双线；当班信息表做成年鉴的“表头栏”，数字等宽右对齐；三栏有编号小标签和清楚的空状态；待处理一栏有事时用朱红提示。 |
| **侧栏和会话列表** | 行距紧，状态靠小标签，选中态弱 | 分组标题是小号字距拉开的刊眉；每行时间等宽左对齐、标题单行截断、状态用小圆点 + 文字；悬停和选中有明确的底色和左侧墨线；搜索、分区、新建三件事的层级理顺；用户卡片和菜单重排。 |
| **弹层（文件、知识库、后台、技能、用量）** | 各自一套头部、页签、表格样式 | 统一的弹层骨架：标题栏（标题 + 页签 + 关闭）、工具条、内容区、底栏；统一的列表行、表格、表单、空状态、加载状态；文件面板的列表和预览左右分栏比例固定，预览区有文件信息头；知识库笔记按文章版式排；后台表格行高、对齐、操作按钮统一。 |
| **对话框和提示** | 样式朴素 | 统一尺寸档位（小 / 中 / 宽）、标题、正文、按钮区（主按钮在右）；危险操作的主按钮用朱红；提示条从右上角滑入，分信息 / 成功 / 出错三种。 |
| **登录页** | 已经有年鉴感 | 保留左右分栏，细调字距、输入框和按钮状态；手机上改成上下排。 |
| **手机端** | 桌面布局挤窄 | 见第 7 节，和每个组件的桌面样式一起设计，不是最后再补。 |

### 先出样稿再动手

好不好看是主观的，所以在大面积实现之前先做一份**静态样稿**（`docs/design/` 下的几个 HTML，直接用 `tokens.css`）：对话（含思考块、工具步骤、确认卡片、提问面板、输入区）、值班板 + 侧栏、文件面板、知识库笔记、一个后台页签、对话框，各一屏桌面版和一屏 380px 手机版。**用户看过同意后**再进入各组件阶段；样稿里定下的样式就是各阶段实现的依据，样稿的 CSS 直接成为组件样式的起点。

## 7. 手机端布局

断点沿用现有的 **720px**（现有 CSS 已经在这个宽度切换），以 380px 宽为验收基准。不新增断点。原则：**一屏只做一件事，分级导航，后退键回上一级。**

| 界面 | 手机形态 |
|---|---|
| 主界面 | 两级。第一级 `/`：会话列表占满屏（现在的 logbook），顶部是搜索和新建，底部是值班板 / 文件 / 知识库 / 用户卡片。第二级 `/s/{id}`：对话占满屏，标题栏左边是返回。左侧深色窄栏在手机上不显示。 |
| 值班板 | `/board`，单列，三栏竖排。 |
| 对话 | 条目单列（时间和角色放在正文上方）；标题栏只留返回、标题、状态、“更多”菜单（步骤、命令面板、知识库、工作目录收进去）。 |
| 输入区 | 贴底，避开安全区（`env(safe-area-inset-bottom)`）；输入框字号 16px 防止 iOS 自动放大；按钮一行排不下时引用 / 本机 / 技能收成图标。 |
| 确认卡片 | 占满宽度，允许 / 拒绝两个按钮各占一半，够大好点；长命令横向在卡片内部滚动，不撑宽页面。 |
| 提问面板 | 贴在输入区上方，占满宽度，选项竖排；最多占 60% 屏高，内部滚动。 |
| 文件面板 | 全屏。两级：目录列表 → 点文件进预览（沿用现有 `.viewing` 的做法），预览页顶部有返回。工具按钮收成一行可横滑的图标。 |
| 知识库 | 全屏。页签在顶部；笔记是列表 → 正文两级；图谱占满屏，支持单指拖动、双指缩放。 |
| 管理后台 | 全屏。页签横向滚动；表格在自己的容器里横向滚动，页面本身不横滚。 |
| 对话框 | 从底部升起，占满宽度；有网址的那几个（技能、用量、扫码）是全屏页。 |

统一要求：`html, body` 不出现横向滚动条；可点的东西不小于 40px；键盘弹出时输入区不被遮住（用 `dvh` 而不是 `vh`）。

## 8. 分阶段

### 过渡办法：老代码和新组件共存

阶段一把四个老脚本**原样**搬进 `web/src/legacy/`，由一个小的 Vite 插件按原来的加载顺序（ui → app → admin → kb）拼成一个模块，这样它们之间靠顶层变量互相调用的写法不用改。静态骨架暂时留在 `web/index.html` 里。

之后每迁一块：

1. 新写的 store 和组件接管这一块；
2. 从 legacy 里删掉对应的代码和骨架；
3. legacy 里剩下的代码如果还要用被迁走的变量或函数（比如 `kb.js` 用 `api`、`dialog`、`current`），由 `legacy/bridge.ts` 在 `window` 上定义同名的访问器，背后读写 store。老代码不用改就能继续跑。

老代码还在用的 element id 保持不变，它的 `$("id")` 继续有效；已经迁成组件的部分用新的 class 和新样式。阶段六迁完最后一块后，`legacy/` 和 `bridge.ts` 一起删掉。

### 阶段

每个阶段结束：应用完整可用、`npm run check`（类型检查）和 `npm run build` 通过、后端测试全过、浏览器实测通过、提交（含重新构建的 `static/app/`）。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **一 脚手架** | 建 `web/` 工程；老脚本搬进 `legacy/`，样式搬进 `styles/`；第三方库改 npm 引入（预览类动态加载）；产物进 `static/app/`；`server.py` 改首页路径并加路由回退（+ 测试）；删 `static/*.js`、`static/vendor/`、`static/almanac.css`、`static/index.html`；CI 的 `node --check` 换成类型检查 + 构建 + 产物一致性检查；`.gitignore`、`.gitattributes`。 | 界面和迁移前一样（这一阶段还不改样式）；对照表全部功能可用；干净检出不装 Node 能启动。 |
| **二 设计基础和样稿** | `styles/tokens.css`；`docs/design/` 静态样稿（第 6 节列的各屏，桌面 + 380px）。不动应用本身。 | **用户看过样稿并同意。** |
| **三 核心** | 按样稿重写这部分样式。`lib/`、`stores/`（auth、sessions、chat、events、composer、ui）、`router.ts`、bridge；组件：登录、左栏、会话列表和分区、值班板、对话（消息、live、思考块、工具步骤、确认卡片、提问面板、分页）、输入区、标题栏、步骤记录、提示条、通用对话框。路由 `/`、`/s/new`、`/s/{id}`、`/s/{id}/steps`。 | 对照表 1–24 项；流式期间只有 live 条目在更新（用 Performance 面板或 MutationObserver 验证）；500 条消息的会话打开和滚动顺畅；`/s/{id}` 直接打开、刷新、前进后退正确；未登录打开深层网址登录后留在那里。 |
| **四 文件** | 按样稿重写样式。 文件面板（我的文件 / 公共文件库、搜索、各类型预览、选择模式）、回收站、公共库管理和上传确认、上传和拖拽、本机文件夹同步、`@` 引用。路由 `/files`、`/files/trash`。 | 对照表 25–34 项；`/files?path=…` 直接打开定位正确。 |
| **五 技能和账户** | 按样稿重写样式。 技能（列表、详情、提交、回滚、选择浮层）、头像、密码、用量、手机扫码、命令面板、用户菜单。路由 `/skills`、`/usage`、`/mobile`。 | 对照表 35–41 项。 |
| **六 知识库** | 按样稿重写样式。 首页、笔记（阅读、编辑、历史、反向链接）、图谱（画布绘制代码保持命令式，包在组件里）、分区筛选、搜索、沉淀经验、整理进知识库、文件卡片提示。路由 `/kb…`。 | 对照表 42–46 项；未保存时后退有确认。 |
| **七 后台和收尾** | 按样稿重写样式；删除 `base.css`、`almanac.css` 里剩余的旧规则。 管理后台八个页签；删除 `legacy/`、bridge、`index.html` 里剩余骨架。路由 `/admin/{tab}`。 | 对照表 47–54 项；`legacy/` 不存在；`grep` 不到 `window.` 上的桥接。 |
| **八 手机端总验收** | 手机样式随各阶段一起做；这一阶段补齐两级导航等跨组件的部分，并在 380px 下整体走查、修齐。 | 380px 下逐项过第 7 节的表；无横向滚动。 |
| **九 文档和总验收** | README（开发、构建、台式机不需要 Node）；CI 和发布工作流定稿；桌面宽度和 380px 把对照表从头到尾再过一遍。 | 完成标准全部满足。 |

每个组件阶段除功能验收外，还要对着样稿逐屏核对（桌面和 380px 截图）。阶段三到七都会动 `app.tsx`、bridge 和 `index.html`，所以**串行**做。

## 9. 现有功能对照表

迁移的验收清单。“现在”指迁移前的实现位置。

### 登录和外壳

| # | 功能 | 现在 | 迁到 | 阶段 |
|---|---|---|---|---|
| 1 | 登录；首次打开创建管理员（`/api/setup`） | app.js `showLogin` | `features/login` | 三 |
| 2 | 启动：种 cookie、`/api/me`、登录失效（401）回登录页 | app.js 末尾、`api()` | `main.tsx`、`lib/api.ts` | 三 |
| 3 | 左侧窄栏、会话列表（今天 / 昨天 / 7 天内 / 更早）、状态点、未读 | `renderSessions` | `features/shell` | 三 |
| 4 | 会话搜索框、今日计数 | 同上 | 同上 | 三 |
| 5 | 分区：切换、筛选、给会话改分区 | sections 相关 | `features/shell`、`stores/sessions` | 三 |
| 6 | 值班板：刊头、当班信息表、用量数字、待处理 / 今日 / 知识库三栏 | `renderHome` | `features/home` | 三 |
| 7 | 用户卡片和菜单（头像、技能、用量、手机、后台、主题、密码、退出） | user menu | `features/shell` | 三（入口）/ 五 |
| 8 | 主题切换（三种模式都保持纸面配色） | ui.js `applyTheme` | `stores/ui` | 三 |

### 对话

| # | 功能 | 现在 | 迁到 | 阶段 |
|---|---|---|---|---|
| 9 | 新建会话（发第一条时才创建）、打开会话 | `ensureSession`、`openSession` | `stores/chat` | 三 |
| 10 | 改名（双击标题）、删除 | title dblclick、delete | `features/chat/Header` | 三 |
| 11 | 发送（Enter 发送、Shift+Enter 换行、输入法组字时不发） | `send` | `features/chat/Composer` | 三 |
| 12 | 排队（运行中再发进队列）和取消排队 | `queued`、queue cancel | 同上 | 三 |
| 13 | 停止 | stopBtn | 同上 | 三 |
| 14 | 逐字输出，Markdown 渲染（净化），代码块 | `renderLive`、`md` | `features/chat/LiveEntry`、`lib/md.ts` | 三 |
| 15 | “思考中”块：展开 / 收起，流式更新 | think block | `features/chat/Thinking` | 三 |
| 16 | 工具步骤：图标、说明、路径缩写；路径可点开文件 | `TOOL_META`、`linkifyPaths` | `features/chat/Steps` | 三 |
| 17 | 步骤记录弹层（完整 transcript） | `showSteps` | `features/chat/StepsPanel` | 三 |
| 18 | 确认卡片：详情、允许 / 拒绝、处理后的状态 | `approvalDetail` | `features/chat/Approval` | 三 |
| 19 | Claude 提问面板：单选 / 多选 / 自填，数字键 1–9 选、Enter 提交 | `renderAsk`、`submitAsk` | `features/chat/AskDock` | 三 |
| 20 | 消息分页：加载更早，保持滚动位置 | `loadOlder` | `features/chat/MessageList` | 三 |
| 21 | 标题栏：分区、状态、条数、权限标签、所有者、跳过确认开关、连接状态 | `renderTop` | `features/chat/Header` | 三 |
| 22 | 别人的会话只读提示条 | otherBanner | 同上 | 三 |
| 23 | 通知（网页通知 / 桌面壳通知）：需要确认、有提问、回复完成 | `notify` | `lib/notify.ts` | 三 |
| 24 | 断线重连、`Last-Event-ID` 补发、`resync` 整体重载、连接状态显示 | `connect` | `stores/events` | 三 |

### 文件

| # | 功能 | 现在 | 迁到 | 阶段 |
|---|---|---|---|---|
| 25 | 文件面板：我的文件 / 公共文件库切换、面包屑、目录浏览 | `showFiles`、`openDir` | `features/files` | 四 |
| 26 | 文件搜索（防抖 350ms） | 同上 | 同上 | 四 |
| 27 | 预览：文本 / 代码、Markdown、图片、PDF、docx、xlsx、office 转 PDF、音视频、不支持的类型给下载 | `preview` | `features/files/Preview` | 四 |
| 28 | 引用文件到输入区（面板里选、`@` 触发）、引用标签、移除 | `addRef`、chips | `features/files`、`Composer` | 四 |
| 29 | 选工作目录模式 | `showFiles(path,"workdir")` | 同上 | 四 |
| 30 | 上传（按钮、整个文件夹）、进度、2 GB 上限 | `uploadFiles` | `features/files/upload.ts` | 四 |
| 31 | 拖拽上传：拖到对话 / 拖到文件面板的公共库 | window drag-drop | 同上 | 四 |
| 32 | 公共库：新建文件夹、重命名、删除、上传前确认（可勾“不再提示”）、重名处理 | `confirmLibUpload`、`askConflict` | `features/files/library.ts` | 四 |
| 33 | 回收站：列表、原位置、还原、彻底删除 | `openTrash` | `features/files/Trash` | 四 |
| 34 | 本机文件夹同步（桌面壳）：添加、链接条、同步回本机 | `addLocalFolder`、`renderLinks`、`syncBack` | `features/files/links.ts` | 四 |

### 技能和账户

| # | 功能 | 现在 | 迁到 | 阶段 |
|---|---|---|---|---|
| 35 | 输入区选技能（浮层）、技能标签 | skillPop | `features/skills/SkillPop` | 五 |
| 36 | 我的技能：列表、详情（文件查看）、提交审核、回滚 | `openMySkills` 等 | `features/skills` | 五 |
| 37 | 换头像（16 个水果） | avatar dialog | `features/account` | 五 |
| 38 | 改密码 | pwd dialog | 同上 | 五 |
| 39 | 我的用量：汇总、最近 20 轮 | usage | 同上 | 五 |
| 40 | 手机扫码（局域网地址二维码） | `showMobile` | 同上 | 五 |
| 41 | 命令面板（Ctrl/⌘K）、Esc 关闭顺序 | palette | `features/palette` | 五 |

### 知识库

| # | 功能 | 现在 | 迁到 | 阶段 |
|---|---|---|---|---|
| 42 | 首页：统计、最近、类型和标签 | kb.js | `features/kb/Home` | 六 |
| 43 | 笔记：列表、搜索、分区筛选、阅读（`[[链接]]`、反向链接）、新建、编辑、删除、历史 | kb.js | `features/kb/Notes` | 六 |
| 44 | 关系图谱：拖动、缩放、点节点、按类型隐藏 | kb.js | `features/kb/Graph` | 六 |
| 45 | 对话里的 `[[链接]]` 可点开笔记；沉淀经验；整理进知识库 | `kbLinkify`、`kbDistill`、`kbOrganize` | `lib/md.ts`、`features/kb` | 六 |
| 46 | 文件预览上的“知识库里有这份文件的卡片”提示 | `kbFileBanner` | `features/kb` | 六 |

### 管理后台

| # | 功能 | 现在 | 迁到 | 阶段 |
|---|---|---|---|---|
| 47 | 用户：列表、新建、改角色、重置密码、停用 | admin.js | `features/admin/Users` | 七 |
| 48 | 聊天记录：所有人的会话、打开查看、实时更新 | admin.js `adminOnSession` | `features/admin/Chats` | 七 |
| 49 | 技能库：列表、安装本机技能、删除 | admin.js | `features/admin/Library` | 七 |
| 50 | 待审核技能：通过 / 驳回，待审数量角标 | admin.js | `features/admin/Review` | 七 |
| 51 | 文件操作记录、各人空间占用 | admin.js | `features/admin/Files` | 七 |
| 52 | 用量：按人、按天 | admin.js | `features/admin/Usage` | 七 |
| 53 | 分区管理：新建、改名、排序、删除 | admin.js | `features/admin/Sections` | 七 |
| 54 | 设置 | admin.js | `features/admin/Settings` | 七 |

### 桌面壳和其它

| # | 功能 | 现在 | 迁到 | 阶段 |
|---|---|---|---|---|
| 55 | 桌面壳：用本机程序打开文件、上传本机文件夹、同步回本机、系统通知 | `IS_DESKTOP` 分支 | `lib/desktop.ts` | 三 / 四 |
| 56 | PWA：manifest、图标、安全区 | index.html head | `web/index.html` | 一 |
| 57 | 减少动效（`prefers-reduced-motion`） | CSS | `styles/` | 一 |

## 10. 安全

迁移不能放松的几条：

- Markdown 一律经 `lib/md.ts`：marked 输出交给 DOMPurify 净化后才进 DOM。组件里用 `dangerouslySetInnerHTML` 的地方只允许传 `md()` 的结果或由转义过的片段拼成的图标 SVG；用户内容其余地方一律走 JSX 文本（自动转义），比现在手写 `esc()` 更不容易漏。
- 令牌不出现在网址里：路由的路径和查询参数里只有会话 id、文件路径、笔记名、页签名。
- 所有改动类请求（POST / PUT / DELETE）走 `lib/api.ts`，带 `Authorization` 头。cookie 只用于带不了头的 GET。
- 文件预览里的 HTML 类内容继续按现在的方式处理（不直接插入页面）。

## 11. 风险

| 风险 | 对策 |
|---|---|
| 另一个会话同时在 `agent-sdk` 分支改后端 | 前端只依赖现有接口和事件格式；`server.py` 只动首页、挂载、回退这几行，合并时冲突面最小。发现接口问题只记录不改。 |
| 桥接期新旧代码同时改同一块 DOM | 一块界面在任何时刻只有一个主人：迁走时把 legacy 里对应的渲染函数整个删掉，不留半截。 |
| xlsx 的 npm 包不带中文代码页 | 动态加载时一并加载 `cpexcel` 并 `set_cptable`，用一份 GBK 的 `.xls` 实测。 |
| 产物提交导致合并冲突 | 产物冲突不手工解：合并后重新 `npm run build` 再提交。写进 README。 |
| 桌面壳和真实手机无法在这台机器上实测 | 汇报里单列需要用户验证的清单。 |
