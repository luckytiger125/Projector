// Claude 工作台网页端里仍由老代码渲染的部分：文件库、本机文件上传、技能、用量、手机二维码、头像和改密码。
// 登录、外壳、值班板、对话、命令面板、提示条和通用对话框已经是 Preact 组件（见 src/features/）；
// 它们用到的全局（me、current、toast、dialog、api……）由 bridge.ts 先挂到 window 上，见那个文件顶部的清单。
"use strict";
const $ = id => document.getElementById(id);

// ---------- 静态图标（只剩老代码自己拥有的 DOM：文件库、拖拽区、关闭按钮） ----------
function paintStatic() {
  $("dzOrb").innerHTML = orb(64, "busy");
  $("frefDir").innerHTML = icon("clip", 14) + "引用此文件夹";
  $("fback").innerHTML = icon("chevL");
  $("fref").innerHTML = icon("clip", 14) + "引用到对话";
  $("flocal").innerHTML = icon("external", 14) + "用本机程序打开";
  $("fdown").innerHTML = icon("download", 14) + "下载";
  $("fUpFile").innerHTML = icon("upload", 14) + "上传文件";
  $("fUpDir").innerHTML = icon("folder", 14) + "上传文件夹";
  $("fMkdir").innerHTML = icon("plus", 14) + "新建文件夹";
  $("fTrash").innerHTML = icon("trash", 14) + "回收站";
  $("fren").innerHTML = icon("edit", 16);
  $("fdel").innerHTML = icon("trash", 16);
  $("fkb").innerHTML = icon("book", 14) + "整理进知识库";
  $("fKbDir").innerHTML = icon("book", 14) + "整理进知识库";
  document.querySelectorAll(".closebtn").forEach(b => b.innerHTML = icon("x"));
}
paintStatic();

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


// ---------- 本机文件：上传到台式机工作区，处理完同步回来 ----------
async function uploadFiles(files, name) {
  // files: [{file: File, rel: "子目录/a.txt"}]
  if (!files.length) return;
  const total = files.reduce((n, f) => n + f.file.size, 0);
  if (total > 2 * 1073741824) return toast("一次最多上传 2 GB", "err");
  const sid = await ensureSession(name);
  const link = await post(`/api/sessions/${sid}/links`, { name });
  let done = 0;
  for (const f of files) {
    if (++done % 5 === 1 || files.length < 6) flash(`正在上传 ${done}/${files.length}：${f.rel}`, 1400);
    await api(`/api/sessions/${sid}/links/${link.id}/file?path=${encodeURIComponent(f.rel)}`, { method: "PUT", body: f.file, raw: true });
  }
  await post(`/api/sessions/${sid}/links/${link.id}/snapshot`);
  links = await api(`/api/sessions/${sid}/links`);
  addRef({ abs: link.abs, name: link.name, dir: true });
  toast(`已上传 ${files.length} 个文件（${fsize(total)}），已引用到对话里`, "ok");
}

function openLocalDialog() {
  if (!isMine()) return;
  const buttons = [
    { label: "选择文件", icon: "file", onClick: () => { $("uploadInput").click(); } },
    { label: "选择文件夹", icon: "folder", onClick: () => { $("uploadDirInput").click(); } },
  ];
  if (IS_DESKTOP) buttons.push({ label: "添加本机文件夹", icon: "sync", primary: true, onClick: addLocalFolder });
  dialog("把本机文件交给 Claude", `
    <p style="margin:0 0 10px">文件会上传到台式机上<b>你自己的工作区</b>（别人看不到），Claude 在那里用台式机的技能处理。</p>
    ${IS_DESKTOP ? `<div class="card" style="margin:0 0 10px"><h4>${icon("sync", 16)}添加本机文件夹</h4><div class="muted" style="font-size:13px">处理完可以一键把改动同步回这台电脑的原文件夹，覆盖前会自动备份。</div></div>` : ""}
    <p class="muted" style="margin:0;font-size:13px">也可以直接把文件拖进窗口。${IS_DESKTOP ? "" : "处理结果可以在“文件库 → 我的文件”里下载。"}</p>`, buttons);
}

$("uploadInput").onchange = async e => {
  const files = [...e.target.files].map(f => ({ file: f, rel: f.name }));
  e.target.value = "";
  try { await uploadFiles(files, "上传的文件"); } catch (err) { toast(err.message, "err"); }
};
$("uploadDirInput").onchange = async e => {
  const list = [...e.target.files];
  e.target.value = "";
  if (!list.length) return;
  const top = list[0].webkitRelativePath.split("/")[0];
  const files = list.map(f => ({ file: f, rel: f.webkitRelativePath.split("/").slice(1).join("/") || f.name }));
  try { await uploadFiles(files, top); } catch (err) { toast(err.message, "err"); }
};

async function addLocalFolder() {
  try {
    const sid = await ensureSession("本机文件");
    flash("选好文件夹后开始上传，文件多的话要等一会儿…", 3000);
    const r = await invoke("upload_local_folder", { sessionId: sid, token });
    if (!r) return;  // 取消了
    links = await api(`/api/sessions/${sid}/links`);
    addRef({ abs: r.abs, name: r.name, dir: true });
    toast(`已上传 ${r.files} 个文件（${fsize(r.bytes)}），已引用到对话里`, "ok");
  } catch (err) { toast(String(err), "err", 6000); }
}

// 拖文件进窗口
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", e => {
  if (!hasFiles(e) || !me) return;
  const toLibrary = $("filesBox").classList.contains("show") && F.mode === "browse";
  if (!toLibrary && !isMine()) return;
  dragDepth++;
  const pub = toLibrary && !F.path.startsWith("ws:");
  $("dropzone").querySelector(".dz div").textContent = toLibrary ? (pub ? "松手，上传到公共文件库（所有人可见）" : "松手，上传到我的文件（仅自己可见）") : "松手，交给 Claude";
  $("dropzone").querySelector(".dz p").textContent = toLibrary ? (F.writable ? F.abs : "这个位置只能看，不能上传") : "文件会上传到你自己的工作区";
  $("dropzone").classList.add("show");
});
window.addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("dropzone").classList.remove("show"); } });
window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("dropzone").classList.remove("show");
  const toLibrary = $("filesBox").classList.contains("show") && F.mode === "browse";
  if (!me || (!toLibrary && !isMine())) return;
  if (toLibrary && !F.writable) return toast("这个位置只能看，不能上传", "err");
  const files = [];
  const walk = (entry, prefix) => new Promise(resolve => {
    if (entry.isFile) entry.file(f => { files.push({ file: f, rel: prefix + f.name }); resolve(); }, resolve);
    else if (entry.isDirectory) {
      const reader = entry.createReader(), all = [];
      const read = () => reader.readEntries(async batch => {
        if (!batch.length) { for (const c of all) await walk(c, prefix + entry.name + "/"); resolve(); }
        else { all.push(...batch); read(); }
      }, resolve);
      read();
    } else resolve();
  });
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) for (const en of entries) await walk(en, "");
  else files.push(...[...e.dataTransfer.files].map(f => ({ file: f, rel: f.name })));
  if (toLibrary) return uploadToLibrary(files);
  // 只拖了一个文件夹：去掉最外层，直接用文件夹名
  let name = "上传的文件";
  if (entries.length === 1 && entries[0].isDirectory) {
    name = entries[0].name;
    files.forEach(f => { f.rel = f.rel.slice(name.length + 1); });
  }
  try { await uploadFiles(files, name); } catch (err) { toast(err.message, "err"); }
});


async function syncBack(lid) {
  const sid = current;
  const link = links.find(l => l.id === lid);
  let ch;
  try { ch = await api(`/api/sessions/${sid}/links/${lid}/changes`); } catch (e) { return toast(e.message, "err"); }
  const n = ch.added.length + ch.modified.length;
  const local = IS_DESKTOP ? await invoke("local_link_path", { linkId: lid }).catch(() => null) : null;
  const row = (it, tag, cls) => `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--line)">
     <span class="status ${cls}">${tag}</span><a class="fpath" data-fp="${esc(it.path)}" style="flex:1">${esc(it.rel)}</a><span class="muted" style="font-size:12px">${fsize(it.size)}</span>
     ${local ? "" : `<a class="btn small" href="/api/files/raw?path=${encodeURIComponent(it.path)}&download=1" download>${icon("download", 13)}</a>`}</div>`;
  const body = n || ch.deleted.length ? `
    ${ch.added.map(i => row(i, "新增", "approved")).join("")}
    ${ch.modified.map(i => row(i, "修改", "pending")).join("")}
    ${ch.deleted.map(r => `<div class="muted" style="padding:5px 0;font-size:13px">Claude 删除了 ${esc(r)}（同步时不会删除你电脑上的文件）</div>`).join("")}
    <p class="muted" style="font-size:13px;margin:12px 0 0">${local ? `会写回到：<code>${esc(local)}</code><br>被覆盖的文件会先备份到那里的 “.projector备份” 文件夹。` :
      IS_DESKTOP ? "这个文件夹不是在这台电脑上添加的，只能逐个下载。" : "浏览器不能直接写回你的文件夹，请逐个下载；用桌面软件“添加本机文件夹”可以一键同步。"}</p>`
    : `<div style="text-align:center;padding:20px 0">${orb(48)}<p class="muted">Claude 还没有改动这个文件夹里的文件。</p></div>`;
  dialog(`“${link ? link.name : ""}” 的改动`, body, local && n ? [{
    label: `同步 ${n} 个文件回本机`, icon: "sync", primary: true, onClick: async () => {
      const r = await invoke("sync_back", { sessionId: sid, linkId: lid, token });
      toast(`已写回 ${r.written} 个文件` + (r.backups ? `，备份了 ${r.backups} 个原文件` : ""), "ok");
    },
  }] : [], true);
  $("dlgBody").onclick = e => { const a = e.target.closest("[data-fp]"); if (a) { closeDialog(); showFiles(a.dataset.fp); } };
}

// ---------- 文件浏览和预览 ----------
// 模式：browse 浏览；workdir 选工作文件夹

const F = { roots: [], office: false, path: "ws:", abs: "", entries: [], sel: null, selEntry: null, searching: false, opened: false, mode: "browse", writable: false };
const EXT = {
  image: "png jpg jpeg gif webp bmp svg ico avif tif tiff heic",
  pdf: "pdf",
  video: "mp4 webm mov m4v ogv",
  audio: "mp3 wav ogg m4a flac aac opus",
  md: "md markdown",
  text: "txt log json xml yaml yml ini cfg conf toml py js ts jsx tsx css html htm vue bat cmd ps1 sh c cpp h hpp cs java kt go rs rb php sql lua r m srt properties env gitignore",
  docx: "docx",
  sheet: "xlsx xlsm xls csv ods",
  office: "doc ppt pptx rtf odt odp wps et dps pps ppsx",
};
const kindOf = name => {
  const ext = (name.split(".").pop() || "").toLowerCase();
  for (const k in EXT) if (EXT[k].split(" ").includes(ext)) return k;
  return "other";
};
// 文件类型色块：扩展名缩写 + 颜色
const KIND_COLOR = { image: "#c46ad6", pdf: "#d9443a", video: "#7a5cf0", audio: "#e0559b", md: "#5b6b7a", text: "#7d8a96", docx: "#2f6fd6", sheet: "#1f9a5a", office: "#e2742c", other: "#a39a8c" };
function fileBadge(e) {
  if (e.dir) return `<span class="fk" style="background:linear-gradient(135deg,#f3b45a,#e8892e)">${icon("folder", 15)}</span>`;
  const k = kindOf(e.name), ext = (e.name.includes(".") ? e.name.split(".").pop() : "").slice(0, 4).toUpperCase() || "FILE";
  return `<span class="fk" style="background:${KIND_COLOR[k]}">${esc(ext)}</span>`;
}
const fileUrl = (p, extra = "") => `/api/files/${extra || "raw"}?path=${encodeURIComponent(p)}`;

function renderCrumbs(crumbs) {
  $("crumbs").innerHTML = crumbs.map(c => `<a data-go="${esc(c.path)}">${esc(c.label)}</a>`).join(" / ") + (F.searching ? " / 搜索结果" : "");
  const ws = F.path.startsWith("ws:");
  $("areas").querySelectorAll("button").forEach(b => b.classList.toggle("on", (b.dataset.area === "ws:") === ws));
  // 当前在哪一块，一眼能看出来
  const sc = $("fScope");
  sc.className = "tag " + (ws ? "admin" : "warn");
  sc.textContent = ws ? "仅自己可见" : "所有人可见";
}

function renderList() {
  const list = F.entries;
  $("flist").innerHTML = list.length ? list.map((e, i) => `
    <div class="fi ${e.path === F.sel ? "sel" : ""}" data-i="${i}" title="${esc(e.abs)}" style="animation-delay:${Math.min(i, 25) * 12}ms">
      ${fileBadge(e)}
      <span class="n">${esc(e.name)}${F.searching ? `<span class="sub">${esc(e.path)}</span>` : ""}</span>
      <span class="s">${e.dir ? "" : fsize(e.size) + " · "}${fdate(e.mtime)}</span>
      ${F.writable && F.mode === "browse" && !F.searching ? `<span class="acts"><button class="iconbtn" data-ren="${i}" title="重命名">${icon("edit", 14)}</button><button class="iconbtn del" data-delf="${i}" title="删除（进回收站）">${icon("trash", 14)}</button></span>` : ""}
    </div>`).join("") : `<div class="empty-note" style="padding:24px;text-align:center">这里是空的${F.writable && F.mode === "browse" ? "<br>可以把文件拖进来上传" : ""}</div>`;
  const sel = $("flist").querySelector(".sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function fileEmpty(text, ic = "file") {
  $("fcontent").innerHTML = `<div class="center"><div class="big">${icon(ic, 28)}</div>${text}</div>`;
}

async function openDir(path) {
  $("fq").value = ""; F.searching = false;
  $("flist").innerHTML = '<div class="empty-note" style="padding:14px">读取中…</div>';
  try {
    const d = await api("/api/files?path=" + encodeURIComponent(path));
    Object.assign(F, { roots: d.roots, office: d.office, path: d.path, abs: d.abs, entries: d.entries, writable: d.writable });
    renderCrumbs(d.crumbs);
    paintFileTools();
    if (F.mode === "workdir") $("pickText").textContent = "当前：" + d.abs;
    if (d.select) { const e = d.entries.find(x => x.path === d.select); if (e) return preview(e); }
    renderList();
  } catch (e) { $("flist").innerHTML = `<div class="err" style="padding:14px">${esc(e.message)}</div>`; }
}

let searchTimer;
$("fq").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("fq").value.trim();
  if (!q) return openDir(F.path);
  searchTimer = setTimeout(async () => {
    $("flist").innerHTML = '<div class="empty-note" style="padding:14px">搜索中…</div>';
    try {
      const d = await api(`/api/files/search?path=${encodeURIComponent(F.path)}&q=${encodeURIComponent(q)}`);
      if ($("fq").value.trim() !== q) return;
      F.searching = true; F.entries = d.results; renderList();
      if (d.partial) $("flist").insertAdjacentHTML("beforeend", '<div class="empty-note" style="padding:10px">结果太多，只显示一部分，换个更具体的词试试</div>');
    } catch (e) { $("flist").innerHTML = `<div class="err" style="padding:14px">${esc(e.message)}</div>`; }
  }, 350);
});

async function preview(e) {
  if (e.dir) return openDir(e.path);
  F.sel = e.path; F.selEntry = e; renderList();
  $("fbody").classList.add("viewing");
  $("fname").textContent = e.name; $("fname").title = e.abs;
  $("fdown").hidden = false; $("fdown").href = fileUrl(e.path) + "&download=1"; $("fdown").setAttribute("download", e.name);
  $("fref").hidden = !isMine();
  $("flocal").hidden = !IS_DESKTOP;
  $("fren").hidden = $("fdel").hidden = !(F.writable && F.mode === "browse");
  $("fkb").hidden = F.mode !== "browse" || !!(window.kbRelOf && kbRelOf(e.abs));
  const box = $("fcontent");
  const kind = kindOf(e.name);
  const url = fileUrl(e.path);
  // 预览不了时的提示：桌面软件里给“用本机程序打开”，浏览器里给“下载”
  const cannot = why => fileEmpty(`<b style="color:var(--ink)">${esc(e.name)}</b><br>${fsize(e.size)} · ${fdate(e.mtime)}<br><br>${why}<br>`
    + (IS_DESKTOP ? `可以用这台电脑上的软件打开。<br><button class="btn primary" data-local>${icon("external", 15)}用本机程序打开</button>`
                  : `可以下载后用本机软件打开。<br><a class="btn primary" href="${url}&download=1" download="${esc(e.name)}">${icon("download", 15)}下载</a>`), "file");
  fileEmpty("加载中…", "clock");
  try {
    if (kind === "image") box.innerHTML = `<img src="${url}" alt="">`;
    else if (kind === "pdf") box.innerHTML = `<iframe src="${url}"></iframe>`;
    else if (kind === "video") box.innerHTML = `<video src="${url}" controls></video>`;
    else if (kind === "audio") box.innerHTML = `<audio src="${url}" controls></audio>`;
    else if (kind === "md" || kind === "text") {
      const d = await api("/api/files/text?path=" + encodeURIComponent(e.path));
      if (F.sel !== e.path) return;
      const note = d.truncated ? '<div class="empty-note" style="padding:8px 18px">文件太大，只显示前 1 MB</div>' : "";
      box.innerHTML = note + (kind === "md" ? `<div class="mdv md">${md(d.text)}</div>` : `<pre>${esc(d.text)}</pre>`);
    } else if (kind === "docx") {
      if (e.size > 50 * 1048576) return cannot("文件太大，不适合在这里预览。");
      const docx = await loadDocx();
      const blob = await fetch(url).then(r => r.ok ? r.blob() : Promise.reject(new Error("读取失败")));
      if (F.sel !== e.path) return;
      box.innerHTML = "";
      await docx.renderAsync(blob, box, null, { inWrapper: true, ignoreLastRenderedPageBreak: true });
    } else if (kind === "sheet") {
      if (e.size > 30 * 1048576) return cannot("表格太大，不适合在这里预览。");
      const XLSX = await loadXlsx();
      const buf = await fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error("读取失败")));
      if (F.sel !== e.path) return;
      const wb = XLSX.read(buf, { type: "array", codepage: 936 });
      const show = name => {
        const html = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: "", footer: "" });
        box.innerHTML = `<div class="sheet"><div class="tabs">${wb.SheetNames.map(n => `<button class="${n === name ? "on" : ""}" data-sheet="${esc(n)}">${esc(n)}</button>`).join("")}</div>`
          + `${sanitizeHtml(html)}</div>`;
        box.querySelectorAll("[data-sheet]").forEach(b => b.onclick = () => show(b.dataset.sheet));
      };
      show(wb.SheetNames[0]);
    } else if (kind === "office") {
      if (!F.office) return cannot("这种格式需要台式机装了 LibreOffice 才能预览。");
      box.innerHTML = `<iframe src="${fileUrl(e.path, "pdf")}"></iframe>`;
    } else {
      cannot("这种格式不能在这里预览。");
    }
  } catch (err) { if (F.sel === e.path) cannot("预览失败：" + esc(err.message)); }
  // 图片、视频、音频格式浏览器不支持时（比如 HEIC、TIFF、部分视频编码）
  const media = box.querySelector("img, video, audio");
  if (media) media.onerror = () => { if (F.sel === e.path) cannot("这个文件的格式或编码这里放不了。"); };
  window.kbFileBanner?.(e);
}

function showFiles(path = null, mode = "browse") {
  F.mode = mode;
  $("pickbar").hidden = mode !== "workdir";
  $("ftools").hidden = mode !== "browse";
  $("frefDir").hidden = mode !== "browse" || !isMine();
  if (mode === "workdir") $("pickText").textContent = "选一个文件夹作为这个会话的工作文件夹";
  if (!F.sel) fileEmpty("选择左边的文件预览", "eye");
  $("filesBox").classList.add("show");
  if (path !== null) openDir(path);
  else if (!F.opened || mode === "workdir") openDir(F.path);
  F.opened = true;
}

// ---------- 文件库管理：上传、新建、改名、删除、回收站 ----------

function paintFileTools() {
  const w = F.writable;
  for (const id of ["fUpFile", "fUpDir", "fMkdir"]) $(id).disabled = !w;
  $("fRO").hidden = w;
  // 整个文件库太大，不能一次整理；知识库自己也不用整理
  $("fKbDir").hidden = !F.path || F.path === "ws:" || !!(window.kbRelOf && kbRoot() && F.abs.replaceAll("\\", "/").toLowerCase().startsWith(kbRoot().replaceAll("\\", "/").toLowerCase()));
  $("fRO").textContent = "这个位置只能看，不能修改";
}

async function mkdirHere() {
  const name = prompt("新文件夹的名字");
  if (!name || !name.trim()) return;
  try {
    const e = await post("/api/files/mkdir", { path: F.path, name: name.trim() });
    toast("已新建文件夹：" + e.name, "ok", 2000);
    await openDir(F.path);
  } catch (err) { toast(err.message, "err"); }
}

async function renameEntry(e) {
  const name = prompt("改成什么名字？", e.name);
  if (!name || name.trim() === e.name) return;
  try {
    const r = await post("/api/files/rename", { path: e.path, name: name.trim() });
    toast("已改名为 " + r.name, "ok", 2000);
    if (F.sel === e.path) { F.sel = r.path; }
    await openDir(F.path);
  } catch (err) { toast(err.message, "err"); }
}

async function deleteEntries(list) {
  const names = list.map(e => (e.dir ? "📁 " : "") + e.name).join("\n");
  if (!confirm(`把下面的${list.length > 1 ? " " + list.length + " 项" : ""}移到回收站？30 天内可以恢复。\n\n${names}`)) return;
  try {
    const r = await post("/api/files/delete", { paths: list.map(e => e.path) });
    if (r.failed.length) toast("有 " + r.failed.length + " 项没删掉：" + r.failed[0].error, "err", 6000);
    if (r.deleted.length) toast(`已移到回收站：${r.deleted.map(d => d.name).join("、")}`, "ok");
    if (list.some(e => e.path === F.sel)) { F.sel = null; fileEmpty("选择左边的文件预览", "eye"); $("fbody").classList.remove("viewing"); }
    await openDir(F.path);
  } catch (err) { toast(err.message, "err"); }
}

// 同名文件怎么办：覆盖 / 保留两份 / 跳过，可以勾“后面都这样”
function askConflict(name) {
  return new Promise(resolve => {
    let done = false;
    const pick = mode => () => { done = true; resolve({ mode, all: $("dlgBody").querySelector("#cfAll")?.checked }); };
    dialog("有同名文件", `<p style="margin:0 0 10px">这个文件夹里已经有 <b>${esc(name)}</b> 了。</p>
      <p class="muted" style="font-size:13px;margin:0 0 10px">选“覆盖”的话，旧文件会放进回收站，30 天内可以找回。</p>
      <label class="switch"><input type="checkbox" id="cfAll"><span class="sw"></span>后面再遇到同名文件也这样处理</label>`,
      [{ label: "跳过", onClick: pick("skip") }, { label: "保留两份", onClick: pick("rename") }, { label: "覆盖", primary: true, onClick: pick("overwrite") }]);
    const timer = setInterval(() => {
      if (!dialogOpen()) { clearInterval(timer); if (!done) resolve({ mode: "skip", all: true }); }
    }, 200);
  });
}

function progress(done, total, text) {
  $("fprog").hidden = total === 0;
  $("fprogBar").style.width = total ? Math.round(done / total * 100) + "%" : "0";
  $("fprogText").textContent = text || "";
}

// 把本机文件上传到文件库当前打开的文件夹；files: [{file, rel}]
let skipLibConfirm = false;  // 本次页面会话内不再提示（刷新后恢复）
function confirmLibUpload(files) {
  return new Promise(resolve => {
    let done = false;
    const fin = v => () => { done = true; if (v === true && $("dlgBody").querySelector("#luAll")?.checked) skipLibConfirm = true; resolve(v); };
    const n = new Set(files.map(f => f.rel.split("/")[0])).size;
    dialog("上传到公共文件库？", `<p style="margin:0 0 10px">这些文件会放进<b>公共文件库</b>，<b>所有同事都能看到</b>。个人文件（工资、合同、证件等）请放到“我的文件”。</p>
      <p class="muted" style="font-size:13px;margin:0 0 10px">共 ${files.length} 个文件${n < files.length ? `（${n} 项）` : ""}，目标文件夹：${esc(F.abs || "文件库根目录")}</p>
      <label class="switch"><input type="checkbox" id="luAll"><span class="sw"></span>这次不再提示</label>`,
      [{ label: "取消", onClick: fin(false) }, { label: "去我的文件", onClick: () => { fin("ws")(); openDir("ws:"); } }, { label: "确认上传", primary: true, onClick: fin(true) }]);
    const timer = setInterval(() => {
      if (!dialogOpen()) { clearInterval(timer); if (!done) resolve(false); }
    }, 200);
  });
}

async function uploadToLibrary(files) {
  if (!files.length || !F.writable) return;
  if (!F.path.startsWith("ws:") && !skipLibConfirm && (await confirmLibUpload(files)) !== true) return;
  const dir = F.path, total = files.reduce((n, f) => n + f.file.size, 0);
  let sent = 0, ok = 0, skipped = 0, policy = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    progress(sent, total, `正在上传 ${i + 1}/${files.length}：${f.rel}`);
    let mode = policy || "ask";
    for (;;) {
      const r = await fetch(`/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.rel)}&on_conflict=${mode}`,
        { method: "PUT", body: f.file, headers: { Authorization: "Bearer " + token } });
      if (r.ok) { ok++; break; }
      const data = await r.json().catch(() => ({}));
      let info = null;
      try { info = JSON.parse(data.detail); } catch {}
      if (r.status === 409 && info && info.exists) {
        progress(sent, total, `等你决定：${info.name}`);
        const c = await askConflict(info.name);
        if (c.all) policy = c.mode;
        if (c.mode === "skip") { skipped++; break; }
        mode = c.mode;
        continue;
      }
      toast(`${f.rel} 上传失败：${data.detail || r.status}`, "err", 6000);
      break;
    }
    sent += f.file.size;
  }
  progress(0, 0);
  toast(`已上传 ${ok} 个文件${skipped ? `，跳过 ${skipped} 个` : ""}`, "ok");
  if (F.path === dir) openDir(dir);
}

async function openTrash() {
  let d;
  try { d = await api("/api/trash"); } catch (e) { return toast(e.message, "err"); }
  const admin = me.role === "admin";
  const body = dialog("回收站", d.items.length ? `
    <p class="muted" style="margin:0 0 6px;font-size:13px">删除的文件会在这里保留 ${d.days} 天。${admin ? "你是管理员，能看到所有人删除的文件。" : "这里只有你自己删除的文件。"}</p>
    ${d.items.map((t, i) => `<div class="trash-row" style="animation-delay:${Math.min(i, 20) * 25}ms">
      ${fileBadge({ name: t.name, dir: !!t.is_dir })}
      <div class="tn"><b>${esc(t.name)}</b><small title="${esc(t.orig_path)}">${t.can_restore === false && t.owner_name ? esc(t.owner_name) + " 的个人文件" : t.orig_path ? "原来在 " + esc(shortPath(t.orig_path)) : t.personal ? "个人文件" : ""}${t.orig_path || t.personal ? " · " : ""}${t.is_dir ? "文件夹" : fsize(t.size)}</small>
        <small>${admin ? esc(t.who || "") + " · " : ""}${ftime(t.deleted_at)}${t.reason && t.reason !== "删除" ? " · " + esc(t.reason) : ""} · 还剩 ${t.days_left} 天</small></div>
      ${t.can_restore === false ? "" : `<button class="btn small" data-restore="${t.id}">${icon("history", 13)}恢复</button>`}
      ${admin ? `<button class="iconbtn" data-purge="${t.id}" title="彻底删除">${icon("x", 15)}</button>` : ""}
    </div>`).join("")}` : `<div style="text-align:center;padding:24px 0">${orb(48)}<p class="muted">回收站是空的。</p></div>`, [], true);
  body.onclick = async e => {
    const rs = e.target.closest("[data-restore]"), pg = e.target.closest("[data-purge]");
    try {
      if (rs) {
        const r = await post(`/api/trash/${rs.dataset.restore}/restore`);
        toast(r.renamed ? `已恢复（原位置有同名文件，改名为 ${baseName(r.restored)}）` : "已恢复到原来的位置", "ok", 4000);
        if ($("filesBox").classList.contains("show")) openDir(F.path);
        openTrash();
      } else if (pg) {
        if (!confirm("彻底删除后就找不回来了，确定吗？")) return;
        await api(`/api/trash/${pg.dataset.purge}`, { method: "DELETE" });
        openTrash();
      }
    } catch (err) { toast(err.message, "err"); }
  };
}

$("fUpFile").onclick = () => $("fUpIn").click();
$("fUpDir").onclick = () => $("fUpDirIn").click();
$("fMkdir").onclick = mkdirHere;
$("fTrash").onclick = openTrash;
$("fren").onclick = () => F.selEntry && renameEntry(F.selEntry);
$("fdel").onclick = () => F.selEntry && deleteEntries([F.selEntry]);
$("fkb").onclick = () => F.selEntry && window.kbOrganize([F.selEntry.path], F.selEntry.name);
$("fKbDir").onclick = () => window.kbOrganize([F.path], baseName(F.abs));
$("fUpIn").onchange = e => { const fs = [...e.target.files].map(f => ({ file: f, rel: f.name })); e.target.value = ""; uploadToLibrary(fs); };
$("fUpDirIn").onchange = e => {
  const fs = [...e.target.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name }));  // 保留最外层文件夹名
  e.target.value = ""; uploadToLibrary(fs);
};

// 把回复里提到的文件库、工作区路径变成可点的链接
function linkifyPaths(container) {
  if (!F.roots.length) return;
  const parts = F.roots.map(root => {
    const sep = root.includes("\\") ? "\\\\" : "/";
    return root.replace(/[\\/]$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + sep;
  });
  const tail = `[^\\s<>"'\`|*?，。；：、！？（）()【】「」]*[^\\s<>"'\`|*?，。；：、！？（）()【】「」.,:;]`;
  const re = new RegExp(`(?:${parts.join("|")})${tail}`, "gi");
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement.closest("a, textarea, .ticket, .chip, .tl") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.match(re)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    node.nodeValue.replace(re, (m, idx) => {
      frag.append(node.nodeValue.slice(last, idx));
      // 显示成“文件名小标签”：完整路径太长，放在悬停提示里
      const a = document.createElement("a");
      const name = baseName(m), isDir = !/\.[A-Za-z0-9]{1,6}$/.test(name);
      a.className = "fchip"; a.dataset.fpath = m; a.title = m + "\n点击预览";
      a.innerHTML = (isDir ? icon("folder", 13) : `<i style="background:${KIND_COLOR[kindOf(name)]}"></i>`) + "<span></span>";
      a.querySelector("span").textContent = name;
      frag.append(a); last = idx + m.length;
    });
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

async function openLocal() {
  const btns = document.querySelectorAll("#flocal, [data-local]");
  btns.forEach(b => { b.disabled = true; });
  try {
    await invoke("open_remote_file", { path: F.sel, token });
    toast("已用本机程序打开。这是一份副本，修改后不会保存回台式机。", "ok", 5000);
  } catch (err) { toast(String(err), "err", 6000); }
  finally { btns.forEach(b => { b.disabled = false; }); }
}

$("areas").onclick = e => { const b = e.target.closest("[data-area]"); if (b) openDir(b.dataset.area); };
$("crumbs").onclick = e => { if (e.target.dataset.go !== undefined) openDir(e.target.dataset.go); };
$("flist").onclick = e => {
  const ren = e.target.closest("[data-ren]"), del = e.target.closest("[data-delf]");
  if (ren) { e.stopPropagation(); return renameEntry(F.entries[+ren.dataset.ren]); }
  if (del) { e.stopPropagation(); return deleteEntries([F.entries[+del.dataset.delf]]); }
  const row = e.target.closest(".fi");
  if (!row) return;
  const en = F.entries[+row.dataset.i];
  if (F.mode === "workdir" && !en.dir) return;
  preview(en);
};
$("fback").onclick = () => $("fbody").classList.remove("viewing");
$("flocal").onclick = openLocal;
$("fcontent").addEventListener("click", e => { if (e.target.closest("[data-local]")) openLocal(); });
$("fref").onclick = () => { addRef(F.selEntry); toast("已引用：" + F.selEntry.name, "ok", 2000); };
$("frefDir").onclick = () => {
  addRef({ abs: F.abs, name: baseName(F.abs), dir: true });
  $("filesBox").classList.remove("show"); composerInput.focus();
};
$("pickOk").onclick = async () => {
  try {
    if (current) await post("/api/sessions/" + current, { work_dir: F.abs }, "PATCH");
    else composer.workDir = F.abs;
    $("filesBox").classList.remove("show");
    toast("工作文件夹：" + baseName(F.abs), "ok");
  } catch (e) { toast(e.message, "err"); }
};

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

// ---------- 命令面板（⌘K / Ctrl+K） ----------

// ---------- 给组件和桥接用的出口：模块里的顶层函数不会自动挂到 window ----------
window.legacy = { linkifyPaths, showFiles, openTrash, openMySkills, openSkillDetail, openUsage, showMobile, pickAvatar, changePassword, pickSessionSection, syncBack, openLocalDialog };
// 文件库的根目录由 stores/roots.ts 持有，这里转发
Object.defineProperty(F, "roots", { get: () => fileRoots.get().roots, set: v => fileRoots.set({ roots: v }) });
Object.defineProperty(F, "office", { get: () => fileRoots.get().office, set: v => fileRoots.set({ office: v }) });
