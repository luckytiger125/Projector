// 样稿共用的竖栏和值班目录，省得每页抄一遍。只是样稿用，不进产物。
function shell(opts) {
  const o = opts || {};
  const row = (t, tm, cls, dot) =>
    `<div class="row ${cls || ""}"><span class="dot ${dot || ""}"></span><span class="t">${t}</span><span class="tm">${tm}</span>` +
    `<span class="acts"><button class="icon-btn" title="改名"><span class="ic s i-more"></span></button><button class="icon-btn" title="删除"><span class="ic s i-trash"></span></button></span></div>`;
  document.write(`
  <aside class="rail">
    <button class="icon-btn m-only" title="${o.back ? "返回" : "菜单"}"><span class="ic l ${o.back ? "i-back" : "i-menu"}"></span></button>
    <span class="seal">值</span>
    <span class="vert">综合部工作台</span>
    <span class="yr">PROJECTOR · 2026</span>
    <button class="icon-btn m-only" title="搜索"><span class="ic l i-search"></span></button>
  </aside>
  ${o.tabs ? `<nav class="m-tabs"><a class="${o.tabs === "list" ? "on" : ""}" onclick="mtab('list')">值班目录</a><a class="${o.tabs === "board" ? "on" : ""}" onclick="mtab('board')">值班板</a></nav>` : ""}
  <aside class="side">
    <div class="side-head">
      <div class="kicker"><span>值班</span><span>11 · 11 周三</span></div>
      <h2>值班目录</h2>
      <button class="btn primary block"><span class="ic i-plus"></span>新会话</button>
      <label class="searchbox"><span class="ic s i-search"></span><input placeholder="搜索会话"></label>
    </div>
    <nav class="nav">
      <a class="${o.nav === "home" ? "on" : ""}"><span class="ic i-home"></span>首页</a>
      <a class="${o.nav === "files" ? "on" : ""}"><span class="ic i-folder"></span>文件库</a>
      <a class="${o.nav === "kb" ? "on" : ""}"><span class="ic i-book"></span>知识库</a>
      <a class="${o.nav === "admin" ? "on" : ""}"><span class="ic i-users"></span>管理后台</a>
    </nav>
    <div class="side-list">
      <div class="grp">分区 · 周报 <span class="n">2</span></div>
      ${row("第 45 周周报汇总", "10:42", o.cur === 1 ? "on" : "", "run")}
      ${row("各科室报送情况核对", "09:15", "unread", "wait")}
      <div class="grp">今天 <span class="n">3</span></div>
      ${row("找上个月的采购合同并列出路径和修改时间", "08:51", "", "")}
      ${row("会议纪要整理成发文格式", "08:20", "", "queue")}
      ${row("普通对话", "08:02", "", "")}
      <div class="grp">昨天 <span class="n">2</span></div>
      ${row("三季度经费使用表汇总", "周二", "", "")}
      ${row("长会话", "周二", "", "")}
      <div class="grp">更早 <span class="n">14</span></div>
      ${row("培训通知起草", "11-06", "", "")}
      ${row("档案目录核对", "11-03", "", "")}
    </div>
    <div class="side-foot">
      <span class="ava">王</span>
      <div style="flex:1;min-width:0"><div class="nm">王敏</div><div class="rl">管理员</div></div>
      <button class="icon-btn" title="设置"><span class="ic i-chev"></span></button>
    </div>
  </aside>`);
}
function mtab(m) {
  document.querySelector(".app").dataset.m = m;
  document.querySelectorAll(".m-tabs a").forEach((a, i) => a.classList.toggle("on", (i === 0) === (m === "list")));
}
