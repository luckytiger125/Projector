// Claude 工作台网页端里仍由老代码渲染的部分：技能、用量、手机二维码、头像和改密码。
// 登录、外壳、值班板、对话、文件库、命令面板、提示条和通用对话框已经是 Preact 组件（见 src/features/）；
// 它们用到的全局（me、current、toast、dialog、api……）由 bridge.ts 先挂到 window 上，见那个文件顶部的清单。
"use strict";
const $ = id => document.getElementById(id);

// ---------- 静态图标（老弹层的关闭按钮） ----------
document.querySelectorAll(".closebtn").forEach(b => b.innerHTML = icon("x"));

document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => b.closest(".overlay").classList.remove("show"));
document.querySelectorAll(".overlay").forEach(o => o.addEventListener("mousedown", e => {
  if (e.target === o && o.id !== "kbBox") o.classList.remove("show");
}));


// ---------- 用量 ----------
function usageQuery(range) {
  if (range === "all") return "all=true";
  if (range === "last") {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return `from=${localYmd(start)}&to=${localYmd(end)}`;
  }
  return "";
}
function usageHtml(d) {
  if (!d || !d.has_data) return `<div class="board-empty">还没有采集到用量</div>`;
  const t = d.total || {};
  const models = (d.by_model || []).map(m => `<tr><td>${esc(m.model || "unknown")}</td><td>${fmtTok(m.input)}</td><td>${fmtTok(m.output)}</td><td>${fmtCost(m.cost)}</td></tr>`).join("");
  const turns = (d.turns || []).map(x => `<tr><td>${esc(x.session_title || "")}</td><td>${esc(x.preview || "")}</td><td>${fmtTok(x.input)}</td><td>${fmtTok(x.output)}</td><td>${fmtCost(x.cost)}</td></tr>`).join("");
  return `<div class="stats">${[["输入", t.input], ["输出", t.output], ["缓存读", t.cache_read], ["轮次", t.turns], ["费用", fmtCost(t.cost)]].map(([k, v]) =>
    `<div class="stat"><div class="v">${esc(v ?? "—")}</div><div class="l">${k}</div></div>`).join("")}</div>
    ${models ? `<h4>按模型</h4><table class="grid"><tr><th>模型</th><th>输入</th><th>输出</th><th>费用</th></tr>${models}</table>` : ""}
    ${turns ? `<h4>最近轮次</h4><table class="grid"><tr><th>会话</th><th>内容</th><th>输入</th><th>输出</th><th>费用</th></tr>${turns}</table>` : ""}
    <p class="muted" style="font-size:12px;margin-top:12px">token 是模型调用量，不等于套餐额度；费用为估算值；cache read 单价更低。</p>`;
}

async function loadUsage(body, range) {
  const box = body.querySelector("#usageData");
  if (!box) return;
  box.innerHTML = `<div class="empty-note">读取中…</div>`;
  try {
    const qs = usageQuery(range);
    const d = await api("/api/usage/me" + (qs ? "?" + qs : ""));
    const tr = await api("/api/usage/me/turns?limit=20").catch(() => ({ turns: [] }));
    d.turns = Array.isArray(tr) ? tr : (tr.turns || []);
    box.innerHTML = usageHtml(d);
  } catch (e) {
    box.innerHTML = `<div class="board-empty">用量接口还没就绪：${esc(e.message)}</div>`;
  }
}

function openUsage() {
  const body = dialog("我的用量", `<div class="seg" id="usageTabs">
    <button data-ur="month" class="on">本月</button><button data-ur="last">上月</button><button data-ur="all">全部</button>
    </div><div id="usageData"></div>`, [], true);
  const load = r => {
    body.querySelectorAll("[data-ur]").forEach(b => b.classList.toggle("on", b.dataset.ur === r));
    loadUsage(body, r);
  };
  body.querySelector("#usageTabs").onclick = e => { const b = e.target.closest("[data-ur]"); if (b) load(b.dataset.ur); };
  load("month");
}

// ---------- 头像、改密码 ----------
function pickAvatar() {
  const body = dialog("选一个头像", `<div class="ava-grid">${AVATAR_LIST.map(([id, n], i) =>
    `<button class="ava-opt ${id === me.avatar ? "on" : ""}" data-ava="${id}" style="animation-delay:${i * 25}ms">${avatarEl(id, 56)}${n}</button>`).join("")}</div>`);
  body.onclick = async e => {
    const b = e.target.closest("[data-ava]");
    if (!b) return;
    body.querySelectorAll(".ava-opt").forEach(x => x.classList.toggle("on", x === b));
    try {
      me = { ...me, ...(await post("/api/me", { avatar: b.dataset.ava }, "PATCH")) };
      setTimeout(closeDialog, 250);
      toast("头像换成了" + AVATAR_NAMES[b.dataset.ava], "ok");
    } catch (err) { toast(err.message, "err"); }
  };
}

function changePassword() {
  dialog("修改密码", `<div class="form">
    <input class="field" type="password" id="pwOld" placeholder="原密码" autocomplete="current-password">
    <input class="field" type="password" id="pwNew" placeholder="新密码（至少 6 位）" autocomplete="new-password">
    <input class="field" type="password" id="pwNew2" placeholder="再输一次新密码" autocomplete="new-password">
    <div class="err"></div></div>`, [{
    label: "保存", primary: true, onClick: async () => {
      if ($("pwNew").value !== $("pwNew2").value) throw new Error("两次新密码不一样");
      await post("/api/me/password", { old: $("pwOld").value, new: $("pwNew").value });
      // 服务端改密码后会让所有登录失效（含 cookie），这里直接回到登录页
      await afterPasswordChange();
      toast("密码已修改，请用新密码重新登录", "ok");
    },
  }]);
}

// ---------- 会话分区 ----------
function sessionSectionOptions(selected) {
  const opts = [`<option value="0"${!selected ? " selected" : ""}>未分类</option>`];
  const active = sections.filter(s => !s.archived);
  if (selected && !active.some(s => Number(s.id) === Number(selected))) {
    opts.push(`<option value="${selected}" selected>${esc(sessionSectionName(selected))}（已下架）</option>`);
  }
  for (const s of active) opts.push(`<option value="${s.id}"${Number(selected) === Number(s.id) ? " selected" : ""}>${esc(s.name)}</option>`);
  return opts.join("");
}

async function pickSessionSection() {
  if (!currentSess || !isMine()) return;
  const body = dialog("设置会话分区", `<div class="form">
    <select class="ke-section" id="sessSecSel">${sessionSectionOptions(currentSess.section_id)}</select>
    <p class="muted" style="font-size:12px;margin:8px 0 0">只影响这个会话的筛选，不改变下次新建的默认分区。</p>
  </div>`, [{ label: "取消" }, {
    label: "保存", primary: true, onClick: async () => {
      const val = Number($("sessSecSel").value || 0);
      const r = await post(`/api/sessions/${current}`, { section_id: val }, "PATCH");
      currentSess = r;
      upsertSession(r);
    },
  }]);
  return body;
}


// ---------- 技能：我的技能、技能详情和版本记录、提交新版本 ----------

// 通用文件查看器（技能审核、版本文件都用）：左边文件列表，右边内容；changes 用来标出新增、修改、删除
function fileViewer(title, files, buttons = [], extraHtml = "", changes = null) {
  const badge = p => !changes ? "" : changes.added.includes(p) ? '<span class="cbadge add">新增</span>' : changes.modified.includes(p) ? '<span class="cbadge mod">修改</span>' : "";
  const removed = changes && changes.removed.length ? `<div class="muted" style="font-size:12.5px;margin:-4px 0 10px">删除了：${changes.removed.map(esc).join("、")}</div>` : "";
  const body = dialog(title, `${extraHtml}${removed}<div class="filev"><div class="list">${files.map((f, i) =>
    `<div data-i="${i}">${badge(f.path)}${/\.(py|sh|bat|cmd|ps1|js|ts|exe|dll)$/i.test(f.path) ? '<span class="status pending">脚本</span> ' : ""}${esc(f.path)} <span class="muted" style="font-size:11.5px">${fsize(f.size)}</span></div>`).join("")}</div>
    <pre id="fvPre">选左边的文件查看内容</pre></div>`, buttons, true);
  const pick = i => {
    const f = files[i];
    body.querySelectorAll(".filev .list div").forEach(d => d.classList.toggle("on", +d.dataset.i === i));
    body.querySelector("#fvPre").textContent = f.text == null ? `（二进制文件，${fsize(f.size)}，不能显示）` : f.text + (f.truncated ? "\n……（太长，已截断）" : "");
  };
  body.querySelector(".filev .list").onclick = e => { const d = e.target.closest("[data-i]"); if (d) pick(+d.dataset.i); };
  const changed = changes ? files.findIndex(f => changes.modified.includes(f.path) || changes.added.includes(f.path)) : -1;
  const first = changed >= 0 ? changed : files.findIndex(f => f.path === "SKILL.md");
  if (files.length) pick(first >= 0 ? first : 0);
  return body;
}

// 上传技能文件（zip 或文件夹）并提交审核；changelog 是更新说明
async function submitSkill(upload, changelog) {
  const sub = await post("/api/skills/submissions");
  await upload(sub.id);
  return post(`/api/skills/submissions/${sub.id}/submit`, { changelog });
}

function skillUploadHtml(prefix, withLog = true) {
  return `${withLog ? `<input class="field" id="${prefix}Log" placeholder="更新说明：这次改了什么（更新已有技能时必填）" style="margin-bottom:8px">` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn small" id="${prefix}Zip">${icon("upload", 14)}上传 zip 压缩包</button>
      <button class="btn small" id="${prefix}Dir">${icon("folder", 14)}选择技能文件夹</button>
    </div>
    <input type="file" id="${prefix}ZipIn" accept=".zip" hidden><input type="file" id="${prefix}DirIn" webkitdirectory hidden>
    <div class="err" id="${prefix}Err" style="margin-top:6px"></div>`;
}

function bindSkillUpload(body, prefix, done, needLog = false) {
  const err = body.querySelector(`#${prefix}Err`);
  const go = async upload => {
    const log = (body.querySelector(`#${prefix}Log`)?.value || "").trim();
    if (needLog && !log) { err.textContent = "请先写更新说明"; body.querySelector(`#${prefix}Log`).focus(); return; }
    err.textContent = "正在提交…";
    try { const r = await submitSkill(upload, log); done(r); } catch (e) { err.textContent = e.message; }
  };
  body.querySelector(`#${prefix}Zip`).onclick = () => body.querySelector(`#${prefix}ZipIn`).click();
  body.querySelector(`#${prefix}Dir`).onclick = () => body.querySelector(`#${prefix}DirIn`).click();
  body.querySelector(`#${prefix}ZipIn`).onchange = e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    go(id => api(`/api/skills/submissions/${id}/zip`, { method: "PUT", body: f, raw: true }));
  };
  body.querySelector(`#${prefix}DirIn`).onchange = e => {
    const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
    go(async id => {
      for (const f of files) {
        const rel = f.webkitRelativePath.split("/").slice(1).join("/") || f.name;
        await api(`/api/skills/submissions/${id}/file?path=${encodeURIComponent(rel)}`, { method: "PUT", body: f, raw: true });
      }
    });
  };
}

async function openMySkills() {
  const subs = await api("/api/skills/submissions").catch(() => []);
  const st = { pending: "待审核", approved: "已入库", rejected: "未通过" };
  const mine = subs.filter(s => s.submitted_by === me.id);
  const body = dialog("技能", `
    <div style="font-weight:600;margin-bottom:8px">我能用的技能 <span class="muted" style="font-weight:400;font-size:12.5px">点开看版本记录、修改</span></div>
    ${mySkills.length ? mySkills.map((s, i) => `<div class="card" data-skill="${esc(s.name)}" style="padding:10px 14px;cursor:pointer;animation-delay:${i * 30}ms"><h4>${icon("puzzle", 15)}${esc(s.name)} <span class="vtag">v${s.version || 1}</span></h4><div class="muted" style="font-size:13px">${esc(s.description)}</div></div>`).join("") : '<p class="empty-note">还没有，管理员分配后会出现在这里。</p>'}
    <div style="font-weight:600;margin:18px 0 6px">提交新技能</div>
    <p class="muted" style="margin:0 0 10px;font-size:13px">技能是一个文件夹，里面必须有 SKILL.md（开头写 name 和 description）。也可以直接在对话里说“帮我做一个××技能”，让 Claude 写好提交。提交后由管理员审核。</p>
    ${skillUploadHtml("sk")}
    <div style="font-weight:600;margin:12px 0 6px">我的提交</div>
    ${mine.map(s => `<div class="card" style="padding:10px 14px"><h4>${esc(s.name)} <span class="status ${s.status}">${st[s.status] || s.status}</span></h4>
      ${s.changelog ? `<div style="font-size:13px">${esc(s.changelog)}</div>` : ""}
      <div class="muted" style="font-size:12.5px">${ftime(s.created)}${s.note ? " · 管理员备注：" + esc(s.note) : ""}</div></div>`).join("") || '<p class="empty-note">还没有提交过。</p>'}
  `, [], true);
  body.querySelectorAll(".card[data-skill]").forEach(c => c.onclick = () => openSkillDetail(c.dataset.skill));
  bindSkillUpload(body, "sk", r => { toast(`已提交技能 ${r.name}，等管理员审核`, "ok"); openMySkills(); });
}

// 技能详情：说明、版本记录（谁改的、改了什么）、在对话里修改、上传新版本；管理员还能回滚
async function openSkillDetail(name) {
  let d;
  try { d = await api("/api/skills/" + encodeURIComponent(name)); } catch (e) { return toast(e.message, "err"); }
  const sk = d.skill, isAdmin = me.role === "admin";
  const body = dialog("技能详情", `
    <div class="sk-head"><span class="big">${icon("puzzle", 26)}</span><div><h3>${esc(sk.name)} <span class="vtag">v${sk.version}</span></h3><p>${esc(sk.description)}</p></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn small primary" id="sdChat">${icon("chat", 14)}在对话里修改</button>
      <button class="btn small" id="sdUse">${icon("sparkle", 14)}用它开始一个任务</button>
      <button class="btn small" id="sdUp">${icon("upload", 14)}上传新版本</button>
    </div>
    <div id="sdUpBox" hidden class="card" style="margin-bottom:14px">${skillUploadHtml("sdu")}<div class="muted" style="font-size:12.5px">SKILL.md 里的 name 要保持 <code>${esc(sk.name)}</code>，否则会变成一个新技能。</div></div>
    ${d.pending.length ? `<div class="card warnc" style="padding:10px 14px">${icon("clock", 14)} 有 ${d.pending.length} 个新版本在等管理员审核：${d.pending.map(p => esc(p.submitter) + "「" + esc(p.changelog || "没写说明") + "」").join("；")}</div>` : ""}
    <div style="font-weight:600;margin-top:6px">${icon("history", 15)} 版本记录</div>
    <ol class="vtl">${d.versions.map((v, i) => `<li class="${v.version === sk.version ? "cur" : ""}" style="animation-delay:${i * 40}ms">
      <span class="vn">v${v.version}</span>
      <div class="vb">
        <div class="vm">${avatarEl(v.submitter_avatar, 18)}${esc(v.submitter || "—")} · ${ftime(v.created)}${v.approver ? ` · ${esc(v.approver)} 审核` : ""}${v.version === sk.version ? ' · <span class="tag admin">当前</span>' : ""}</div>
        <div class="vc">${esc(v.changelog || "没写更新说明")}</div>
        <div class="va"><button class="btn small ghost" data-vfiles="${v.version}">${icon("eye", 13)}查看文件</button>
          ${isAdmin && v.version !== sk.version ? `<button class="btn small ghost" data-rollback="${v.version}">${icon("history", 13)}回滚到这个版本</button>` : ""}</div>
      </div></li>`).join("")}</ol>
  `, [], true);
  body.querySelector("#sdChat").onclick = () => {
    closeDialog();
    resetComposer(); openSession(null);
    composerInput.set(`我想修改技能「${sk.name}」：`);
    toast("说清楚要改什么，Claude 会取出技能、改好后提交新版本给管理员审核", "info", 5000);
  };
  body.querySelector("#sdUse").onclick = () => {
    closeDialog(); composer.skill = sk.name;
    if (!current) openSession(null);
    composerInput.focus();
  };
  body.querySelector("#sdUp").onclick = () => { body.querySelector("#sdUpBox").hidden = !body.querySelector("#sdUpBox").hidden; };
  bindSkillUpload(body, "sdu", r => { toast(`已提交 ${r.name} 的新版本，等管理员审核`, "ok"); openSkillDetail(name); }, true);
  body.querySelectorAll("[data-vfiles]").forEach(b => b.onclick = async () => {
    const v = +b.dataset.vfiles;
    const f = await api(`/api/skills/${encodeURIComponent(name)}/versions/${v}/files`);
    fileViewer(`${name} v${v} 的文件`, f.files, [{ label: "返回", onClick: () => { setTimeout(() => openSkillDetail(name), 0); } }],
      f.changes ? '<div class="muted" style="font-size:12.5px;margin-bottom:8px">标出了相对上一个版本的改动</div>' : "", f.changes);
  });
  body.querySelectorAll("[data-rollback]").forEach(b => b.onclick = async () => {
    const v = +b.dataset.rollback;
    if (!confirm(`回滚到 v${v}？会生成一个内容和 v${v} 一样的新版本，所有能用这个技能的人马上生效。`)) return;
    try { const r = await post(`/api/admin/library/${encodeURIComponent(name)}/rollback`, { version: v }); toast(`已回滚，现在是 v${r.version}`, "ok"); openSkillDetail(name); loadSkills(); }
    catch (e) { toast(e.message, "err"); }
  });
}

// ---------- 在手机上打开：二维码 ----------

async function showMobile() {
  let lan;
  try { lan = await api("/api/lan"); } catch (e) { return toast(e.message, "err"); }
  const urls = lan.urls.length ? lan.urls : [location.origin];
  let qrcode;
  try { qrcode = await loadQrcode(); }
  catch (e) { return toast(e.message, "err"); }
  const qrSvg = url => {
    const qr = qrcode(0, "H"); qr.addData(url); qr.make();
    const n = qr.getModuleCount(), c = Math.floor(n / 2), hole = Math.ceil(n * 0.13);
    let rects = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!qr.isDark(y, x) || (Math.abs(x - c) <= hole && Math.abs(y - c) <= hole)) continue;  // 中间留给橙光球
      const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
      rects += `<rect x="${x + .06}" y="${y + .06}" width=".88" height=".88" rx="${finder ? .2 : .42}" fill="${finder ? "#c24f1c" : "#201b15"}"/>`;
    }
    return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="geometricPrecision">${rects}</svg>`;
  };
  const render = url => {
    $("dlgBody").querySelector(".qrcard").innerHTML = qrSvg(url) + orb(46);
    $("dlgBody").querySelector("#qrUrl").textContent = url;
  };
  const body = dialog("在手机上打开", `<div class="qrwrap">
    <div class="qrcard"></div>
    <div class="qrurl"><span id="qrUrl"></span><button class="iconbtn" id="qrCopy" data-tip="复制">${icon("copy", 16)}</button></div>
    ${urls.length > 1 ? `<div class="seg" id="qrPick" style="margin-top:10px">${urls.map((u, i) => `<button class="${i ? "" : "on"}" data-u="${esc(u)}">${esc(u.replace(/^https?:\/\//, ""))}</button>`).join("")}</div>` : ""}
    <p class="muted" style="font-size:13px;margin:14px 0 0">手机连上和这台台式机<b>同一个 Wi-Fi</b>，用相机或微信扫一扫。</p>
    <div class="qrsteps">
      <div><b>iPhone</b>用 Safari 打开 → 底部分享按钮 → “添加到主屏幕”，之后像 App 一样全屏打开</div>
      <div><b>安卓</b>用 Chrome 打开 → 右上角 ⋮ → “添加到主屏幕”，桌面上会出现橙光球图标</div>
    </div></div>`);
  render(urls[0]);
  body.querySelector("#qrCopy").onclick = () => navigator.clipboard?.writeText($("qrUrl").textContent).then(() => toast("已复制", "ok", 1500));
  body.querySelector("#qrPick")?.addEventListener("click", e => {
    const b = e.target.closest("[data-u]"); if (!b) return;
    body.querySelectorAll("#qrPick button").forEach(x => x.classList.toggle("on", x === b));
    render(b.dataset.u);
  });
}

// ---------- 给组件和桥接用的出口：模块里的顶层函数不会自动挂到 window ----------
window.legacy = { openMySkills, openSkillDetail, openUsage, showMobile, pickAvatar, changePassword, pickSessionSection };
