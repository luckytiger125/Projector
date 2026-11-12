// 笔记页签：左边是列表（类型和标签筛选、搜索结果），右边是正文 / 编辑器 / 空白提示。手机上列表和正文是两级。
import { cleanSnippet } from "../../lib/textcodec";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { orb } from "../../lib/avatars";
import { KIND_COLOR, kindOf } from "../../lib/filekind";
import { baseName, fdate, rel, shortPath } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { linkifyPaths } from "../../lib/linkify";
import { md } from "../../lib/markdown";
import { linkify, stripTitleHeading } from "../../lib/wikilink";
import { closeOverlay, replace } from "../../router";
import { isMine } from "../../stores/chat";
import { addRef, composerInput } from "../../stores/composer";
import { showFiles } from "../../stores/files";
import { roots } from "../../stores/roots";
import {
  KB_TYPES, clearSearch, kbData, kbEditing, kbGo, kbNote, kbNoteError, kbNoteLoading, kbQuery, kbResults, kbSel, kbTag, kbType, kcls, openNote,
  sectionMatch, startEdit, toggleStatus, visibleNotes,
} from "../../stores/kb";
import type { KbBrief, KbHit, KbNoteDetail } from "../../stores/kb";
import { toast } from "../../stores/ui";
import { askDelete, openHistory, organize } from "./actions";

// ---------- 列表 ----------
function Filter() {
  const visible = visibleNotes.value;
  const results = kbResults.value;
  const by: Record<string, number> = {};
  for (const n of visible) by[n.type] = (by[n.type] || 0) + 1;
  const pill = (label: string, val: string, n: number) => (
    <button key={val} type="button" class={"pill" + (kbType.value === val && !results ? " on" : "")} onClick={() => { kbType.value = val; }}>
      {val ? <i class={"kdot k-" + kcls(val)} /> : null}{label}<small>{n}</small>
    </button>
  );
  return (
    <div class="pills kb-filter">
      {results
        ? <>
            <span class="pill on"><Icon name="search" size={13} />“{kbQuery.value.trim()}” 的结果<small>{results.length}</small></span>
            <button type="button" class="pill" onClick={clearSearch}><Icon name="x" size={12} />清除</button>
          </>
        : <>{pill("全部", "", visible.length)}{Object.keys(KB_TYPES).map((t) => pill(t, t, by[t] || 0))}</>}
      {kbTag.value && !results
        ? <span class="pill on tagf">#{kbTag.value}<button type="button" aria-label="去掉标签筛选" onClick={() => { kbTag.value = ""; }}><Icon name="x" size={12} /></button></span>
        : null}
    </div>
  );
}

function Row({ n, i, hit }: { n: KbBrief | KbHit; i: number; hit: boolean }) {
  const on = n.path === kbSel.value;
  return (
    <a class={`note-row k-${kcls(n.type)}${on ? " on" : ""}${n.status === "过时" ? " old" : ""}`} data-kp={n.path} style={`animation-delay:${Math.min(i, 20) * 14}ms`}
      onClick={() => openNote(n.path)}>
      <h5>
        <i class={"kdot k-" + kcls(n.type)} /><span class="tt">{n.title}</span>
        <span class="nr-tags">
          {n.section ? <span class="tag">{n.section}</span> : null}
          {n.source_state ? <span class="tag warn" title="原文件改过">!</span> : null}
          {n.status === "过时" ? <span class="tag">过时</span> : null}
        </span>
      </h5>
      <p><span class="sm">{hit ? cleanSnippet((n as KbHit).snippet) : (n.summary || n.type)}</span><span class="tm">{rel(n.mtime)}</span></p>
    </a>
  );
}

function List() {
  const results = kbResults.value;
  const all = kbData.value!.notes;
  const items: Array<KbBrief | KbHit> = results || all.filter((n) => sectionMatch(n) && (!kbType.value || n.type === kbType.value) && (!kbTag.value || n.tags.includes(kbTag.value)));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }, [kbSel.value]);
  return (
    <aside class="pane narrow">
      <Filter />
      <div ref={box}>
        {items.length
          ? items.map((n, i) => <Row key={n.path} n={n} i={i} hit={!!results} />)
          : <div class="kb-hint kb-none">{results ? <>没有找到相关的笔记<br />换个说法试试，或者直接问 Claude</> : "这里还没有笔记"}</div>}
      </div>
    </aside>
  );
}

// ---------- 正文 ----------
function Empty() {
  return (
    <div class="kb-empty">
      <span dangerouslySetInnerHTML={{ __html: orb(54) }} />
      <p>选一条笔记来看<br /><small>或者点右上角“新建笔记”</small></p>
    </div>
  );
}

/** 笔记正文：经 md() 净化后才进页面；提到的文件库路径变成可点的文件名小标签 */
function NoteBody({ html }: { html: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => { if (el.current) linkifyPaths(el.current, roots.value); }, [html, roots.value]);
  return <div class="md kv-body" ref={el} dangerouslySetInnerHTML={{ __html: html }} />;
}

function NoteView({ d }: { d: KbNoteDetail }) {
  const n = d.note;
  const old = n.status === "过时";
  // 正文开头如果是和标题一样的一级标题，就不重复显示了
  const body = stripTitleHeading(n.body, n.title);
  const srcWarn = n.source_state === "changed" ? "原文件在这张卡片写完后改过，内容可能过时" : n.source_state === "missing" ? "原文件已经不在原来的位置了" : "";
  const who = [n.author && `${n.author} 创建`, n.contributors.length && `${n.contributors.join("、")} 补充过`].filter(Boolean).join(" · ");
  const html = body.trim() ? md(linkify(body, d.links)) : '<p class="kb-hint">（还没有正文）</p>';
  const mine = isMine.value;
  const toTag = (t: string) => {
    kbTag.value = t; kbType.value = ""; clearSearch();
    if (window.matchMedia("(max-width: 720px)").matches) kbGo("notes");   // 手机上列表在上一级，回去才看得到筛选结果
  };
  return (
    <>
      <div class="kv-bar">
        <span class="sp" />
        {mine ? <button class="btn ghost sm" type="button" title="把这条笔记交给当前对话里的 Claude"
          onClick={() => { addRef({ abs: n.abs, name: n.title, dir: false }); closeOverlay(); toast("已引用到对话", "ok"); composerInput.focus(); }}><Icon name="clip" size={14} />引用到对话</button> : null}
        <button class="btn ghost sm" type="button" onClick={() => startEdit(d)}><Icon name="edit" size={14} />编辑</button>
        <button class="icon-btn" type="button" title={`历史版本（${d.history}）`} aria-label={`历史版本（${d.history}）`} onClick={() => void openHistory(n)}><Icon name="history" size={17} /></button>
        <button class="icon-btn" type="button" title={old ? "标记为有效" : "标记为过时"} aria-label={old ? "标记为有效" : "标记为过时"} onClick={() => void toggleStatus(n)}><Icon name={old ? "check" : "clock"} size={17} /></button>
        <button class="icon-btn del" type="button" title="删除（进回收站）" aria-label="删除（进回收站）" onClick={() => askDelete(d)}><Icon name="trash" size={17} /></button>
      </div>
      <article class={`article kv k-${kcls(n.type)}${old ? " old" : ""}`}>
        <div class="kv-kick">
          <span class={"ktype k-" + kcls(n.type)}>{n.type}</span>
          {old ? <span class="tag">已过时</span> : null}
          <span class="kb-hint">更新于 {n.updated || fdate(n.mtime)}</span>
        </div>
        <h1 class="kv-title">{n.title}</h1>
        {n.summary ? <p class="kv-sum">{n.summary}</p> : null}
        <div class="kv-props">
          {who ? <span><Icon name="user" size={13} />{who}</span> : null}
          {d.session ? <a role="button" tabIndex={0} onClick={() => replace("/s/" + d.session!.id)}><Icon name="chat" size={13} />来自会话「{d.session.title}」</a> : null}
          {n.tags.map((t) => <a key={t} class="ktag" role="button" tabIndex={0} onClick={() => toTag(t)}>#{t}</a>)}
        </div>
        {n.source ? (
          <div class={"kv-src" + (srcWarn ? " warn" : "")}>
            <span class="fk" style={`background:${KIND_COLOR[kindOf(n.source)] || KIND_COLOR.other}`}><Icon name={/\.[A-Za-z0-9]{1,6}$/.test(n.source) ? "file" : "folder"} size={15} /></span>
            <div><b>{baseName(n.source)}</b><small>{srcWarn || shortPath(n.source_abs || n.source, roots.value)}</small></div>
            {n.source_state !== "missing" ? <button class="btn sm" type="button" onClick={() => showFiles(n.source_abs || n.source)}><Icon name="eye" size={14} />看原文件</button> : null}
            {srcWarn && n.source_state === "changed" && mine
              ? <button class="btn sm primary" type="button" onClick={() => void organize([n.source_abs || n.source], n.title)}><Icon name="sync" size={14} />让 Claude 更新</button> : null}
          </div>
        ) : null}
        <NoteBody html={html} />
        <section class="backlinks kv-back">
          <h6>提到这条的笔记 <small>{d.backlinks.length}</small></h6>
          {d.backlinks.length
            ? d.backlinks.map((b) => (
              <a key={b.path} class={"note-row kv-bl k-" + kcls(b.type)} onClick={() => openNote(b.path)}><h5>{b.title}</h5><p>{cleanSnippet(b.snippet)}</p></a>
            ))
            : <p class="kb-hint">还没有别的笔记链接到这里。在其他笔记里写 <code>{"[[" + n.title + "]]"}</code> 就能连上。</p>}
        </section>
      </article>
    </>
  );
}

function View() {
  const sel = kbSel.value;
  const d = kbNote.value;
  if (!sel) return <Empty />;
  if (kbNoteError.value) return <div class="kb-empty"><p class="err">{kbNoteError.value}</p></div>;
  if (!d || d.note.path !== sel) return kbNoteLoading.value ? <div class="kb-empty"><span dangerouslySetInnerHTML={{ __html: orb(40, "busy") }} /></div> : null;
  return <NoteView key={d.note.path + ":" + d.note.mtime} d={d} />;
}

export function Notes({ editor }: { editor: ComponentChildren }) {
  const editing = kbEditing.value;
  const pane = useRef<HTMLDivElement>(null);
  const sel = kbSel.value;
  useEffect(() => { if (pane.current) pane.current.scrollTop = 0; }, [sel, editing?.id]);
  return (
    <>
      <List />
      <div class="pane preview kb-view" ref={pane}>{editing ? editor : <View />}</div>
    </>
  );
}
