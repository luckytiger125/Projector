// 预览区：标题栏（文件名 + 操作按钮）+ 内容。文本、代码、Markdown、图片、PDF、音视频、docx、xlsx / csv、
// Office（LibreOffice 转 PDF）；放不了的给提示，桌面软件里给“用本机程序打开”，浏览器里给“下载”。
// 用户内容进页面前都已净化（Markdown、表格 HTML），文本走 JSX 自动转义。docx / xlsx 的库只在预览时才加载。
import { useEffect, useRef, useState } from "preact/hooks";
import { isDesktop } from "../../lib/desktop";
import { fdate, fsize } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { loadDocx } from "../../lib/vendor";
import { replace } from "../../router";
import { isMine } from "../../stores/chat";
import { fileUrl, kbBanner, kbRelOf, mode, preview, previewCannot, sel, writable } from "../../stores/files";
import type { FileEntry, PreviewBody } from "../../stores/files";
import { organize, openLocal, referEntry, renameEntry, deleteEntries } from "./actions";
import { kbData } from "../../stores/kb";

function Cannot({ e, why }: { e: FileEntry; why: string }) {
  const desktop = isDesktop();
  const url = fileUrl(e.path);
  return (
    <div class="fx-center">
      <div class="fx-big"><Icon name="file" size={28} /></div>
      <b class="fx-nm">{e.name}</b>
      <div class="fx-sub">{fsize(e.size)} · {fdate(e.mtime)}</div>
      <p>{why}</p>
      {desktop
        ? <><p>可以用这台电脑上的软件打开。</p><button class="btn primary" onClick={() => void openLocal(e.path)}><Icon name="external" size={15} />用本机程序打开</button></>
        : <><p>可以下载后用本机软件打开。</p><a class="btn primary" href={url + "&download=1"} download={e.name}><Icon name="download" size={15} />下载</a></>}
    </div>
  );
}

function DocxView({ blob }: { blob: Blob }) {
  const box = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setErr("");
    (async () => {
      const docx = await loadDocx();
      if (!live || !box.current) return;
      box.current.innerHTML = "";
      await docx.renderAsync(blob, box.current, null, { inWrapper: true, ignoreLastRenderedPageBreak: true });
      // 预览区比纸张窄时整体缩小，免得要左右拖
      const el = box.current, page = el.querySelector<HTMLElement>("section.docx");
      if (live && page && page.offsetWidth > el.clientWidth - 8) {
        const z = (el.clientWidth - 8) / page.offsetWidth;
        el.querySelector<HTMLElement>(".docx-wrapper")?.style.setProperty("zoom", String(Math.max(0.3, z)));
      }
    })().catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [blob]);
  if (err) return <div class="err fx-pad">预览失败：{err}</div>;
  return <div class="fx-docx" ref={box} />;
}

function SheetView({ names, render }: { names: string[]; render: (n: string) => string }) {
  const [on, setOn] = useState(names[0]);
  useEffect(() => { setOn(names[0]); }, [names]);
  return (
    <div class="fx-sheet">
      <div class="fx-sheet-tabs">
        {names.map((n) => <button key={n} class={n === on ? "on" : ""} onClick={() => setOn(n)}>{n}</button>)}
      </div>
      {/* render 的结果已经过 DOMPurify */}
      <div class="fx-sheet-body" dangerouslySetInnerHTML={{ __html: render(on) }} />
    </div>
  );
}

function Body({ e, p }: { e: FileEntry; p: PreviewBody }) {
  switch (p.t) {
    case "none": return <div class="fx-center"><div class="fx-big"><Icon name="eye" size={28} /></div>选择左边的文件预览</div>;
    case "loading": return <div class="fx-center"><div class="fx-big"><Icon name="clock" size={28} /></div>加载中…</div>;
    case "cannot": return <Cannot e={e} why={p.why} />;
    case "media": {
      const fail = () => previewCannot(e.path, "这个文件的格式或编码这里放不了。");
      if (p.kind === "image") return <img class="fx-img" src={p.url} alt="" onError={fail} />;
      if (p.kind === "video") return <video class="fx-av" src={p.url} controls onError={fail} />;
      if (p.kind === "audio") return <audio class="fx-av" src={p.url} controls onError={fail} />;
      return <iframe class="fx-frame" src={p.url} title={e.name} />;
    }
    case "text":
      return <>{p.truncated && <div class="note-hint fx-pad">文件太大，只显示前 1 MB</div>}<pre class="fx-pre">{p.text}</pre></>;
    case "md":
      return <>{p.truncated && <div class="note-hint fx-pad">文件太大，只显示前 1 MB</div>}<div class="md fx-md" dangerouslySetInnerHTML={{ __html: p.html }} /></>;
    case "docx": return <DocxView blob={p.blob} />;
    case "sheet": return <SheetView names={p.names} render={p.render} />;
  }
}

export function Preview() {
  const e = sel.value;
  const p = preview.value;
  const desktop = isDesktop();
  const browse = mode.value === "browse";
  const kb = kbData.value;
  const banner = kbBanner.value;
  if (!e) {
    return <aside class="pane preview"><div class="fx-center"><div class="fx-big"><Icon name="eye" size={28} /></div>选择左边的文件预览</div></aside>;
  }
  const isKbNote = !!(kb && kbRelOf(kb.root, e.abs));
  const openKb = (path: string) => { replace({ name: "kb", tab: "notes", note: path }, { force: true }); };
  return (
    <aside class="pane preview">
      <div class="crumbs fx-phead">
        <b class="fx-pname" title={e.abs}>{e.name}</b>
        <span class="sp" />
        {isMine.value && <button class="btn ghost sm" onClick={() => referEntry(e)}><Icon name="clip" size={14} />引用到对话</button>}
        {browse && !isKbNote && <button class="btn ghost sm" title="让 Claude 读这份文件，写一张文件卡片存进知识库" onClick={() => organize([e.path], e.name)}><Icon name="book" size={14} />整理进知识库</button>}
        {writable.value && browse && <button class="icon-btn" title="重命名" aria-label="重命名" onClick={() => void renameEntry(e)}><Icon name="edit" size={16} /></button>}
        {writable.value && browse && <button class="icon-btn" title="删除" aria-label="删除" onClick={() => void deleteEntries([e])}><Icon name="trash" size={16} /></button>}
        {desktop && <button class="btn sm" onClick={() => void openLocal(e.path)}><Icon name="external" size={14} />用本机程序打开</button>}
        <a class="btn sm" href={fileUrl(e.path) + "&download=1"} download={e.name}><Icon name="download" size={14} />下载</a>
      </div>
      <div class="fx-content">
        {banner && (
          <div class="fx-banner">
            <Icon name="book" size={15} />
            {banner.kind === "note"
              ? <span>这是知识库里的笔记</span>
              : <span>知识库里有这份文件的卡片：<b>{banner.title}</b>{banner.changed ? <span class="tag warn">文件改过，卡片可能过时</span> : null}</span>}
            <button class="btn sm" onClick={() => openKb(banner.path)}>{banner.kind === "note" ? "在知识库中打开" : "看卡片"}</button>
          </div>
        )}
        <Body e={e} p={p} />
      </div>
    </aside>
  );
}
