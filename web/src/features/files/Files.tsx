// 文件库：我的文件 / 公共文件库（目录列表 + 预览）和回收站，盖在主界面上的一张册页。网址见 stores/files.ts。
import { useEffect } from "preact/hooks";
import { Sheet } from "../../components/Sheet";
import type { SheetTab } from "../../components/Sheet";
import { orb } from "../../lib/avatars";
import { fdate, fsize, ftime } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { closeOverlay, overlayRoute, replace } from "../../router";
import { me } from "../../stores/auth";
import { isMine } from "../../stores/chat";
import {
  clearSel, crumbs, dirAbs, dirPath, entries, fileUrl, filesRoute, go, listError, listState, mode, onSearchInput, progress,
  query, searchBusy, searchPartial, searching, sel, trash, trashError, writable,
} from "../../stores/files";
import type { FileEntry, TrashItem } from "../../stores/files";
import { kbData } from "../../stores/kb";
import {
  deleteEntries, mkdirHere, organize, pickWorkDir, purgeItem, referDir, renameEntry, restoreItem, trashWhere,
} from "./actions";
import { pickers } from "./local";
import { Preview } from "./Preview";

const gotoTrash = (): void => { replace({ name: "files", trash: true }, { force: true }); };

function tabsFor(active: "ws" | "pub" | "trash", workdir: boolean): SheetTab[] {
  const t: SheetTab[] = [
    { key: "ws", label: "我的文件", title: "只有自己能看", on: active === "ws", onClick: () => go("ws:") },
    { key: "pub", label: "公共文件库", title: "所有人可见", on: active === "pub", onClick: () => go("") },
  ];
  if (!workdir) t.push({ key: "trash", label: "回收站", on: active === "trash", onClick: gotoTrash });
  return t;
}

function Row({ e, i }: { e: FileEntry; i: number }) {
  const workdir = mode.value === "workdir";
  const canEdit = writable.value && !workdir && !searching.value;
  const on = sel.value?.path === e.path;
  const open = () => { if (workdir && !e.dir) return; go(e.path); };
  return (
    <tr class={on ? "on" : ""} onClick={open} style={`animation-delay:${Math.min(i, 25) * 12}ms`}>
      <td class="nmc">
        <button class="nm" type="button" title={e.abs} onClick={(ev) => { ev.stopPropagation(); open(); }}>
          <Icon name={e.dir ? "folder" : "file"} size={16} />
          <span>{e.name}{searching.value && <small class="fx-where">{e.path}</small>}</span>
        </button>
      </td>
      <td class="num sub">{e.dir ? "—" : fsize(e.size)}</td>
      <td class="num sub">{fdate(e.mtime)}</td>
      <td class="r" onClick={(ev) => ev.stopPropagation()}>
        {!e.dir && <a class="icon-btn" title="下载" aria-label="下载" href={fileUrl(e.path) + "&download=1"} download={e.name}><Icon name="download" size={16} /></a>}
        {canEdit && <button class="icon-btn" title="重命名" aria-label="重命名" onClick={() => void renameEntry(e)}><Icon name="edit" size={16} /></button>}
        {canEdit && <button class="icon-btn del" title="删除（进回收站）" aria-label="删除（进回收站）" onClick={() => void deleteEntries([e])}><Icon name="trash" size={16} /></button>}
      </td>
    </tr>
  );
}

function List() {
  const list = entries.value;
  const st = listState.value;
  const workdir = mode.value === "workdir";
  let body;
  if (st === "loading" && !list.length) body = <tr><td class="ctr" colSpan={4}>读取中…</td></tr>;
  else if (st === "error") body = <tr><td class="ctr err" colSpan={4}>{listError.value}</td></tr>;
  else if (searchBusy.value && !searching.value) body = <tr><td class="ctr" colSpan={4}>搜索中…</td></tr>;
  else if (!list.length) body = <tr><td class="ctr" colSpan={4}>这里是空的{writable.value && !workdir ? <><br />可以把文件拖进来上传</> : null}</td></tr>;
  else body = list.map((e, i) => <Row key={e.path + ":" + e.name} e={e} i={i} />);
  return (
    <table class="ledger fx-ledger">
      <thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th /></tr></thead>
      <tbody>{body}</tbody>
      {searching.value && searchPartial.value && <tfoot><tr><td class="ctr" colSpan={4}>结果太多，只显示一部分，换个更具体的词试试</td></tr></tfoot>}
    </table>
  );
}

function Crumbs() {
  const cs = crumbs.value;
  const ws = dirPath.value.startsWith("ws:");
  const browse = mode.value === "browse";
  const kb = kbData.value;
  // 整个文件库太大，不能一次整理；知识库自己也不用整理
  const underKb = !!(kb && kb.root && dirAbs.value.replaceAll("\\", "/").toLowerCase().startsWith(kb.root.replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase()));
  const canOrganize = !!dirPath.value && dirPath.value !== "ws:" && !underKb;
  return (
    <div class="crumbs">
      {cs.map((c, i) => {
        const last = i === cs.length - 1 && !searching.value;
        return (
          <span key={i} class="fx-crumb">
            {i > 0 && <Icon name="chevR" size={13} class="fx-sep" />}
            {last ? <b>{c.label}</b> : <a class="link" role="button" tabIndex={0} onClick={() => go(c.path)} onKeyDown={(ev) => { if (ev.key === "Enter") go(c.path); }}>{c.label}</a>}
          </span>
        );
      })}
      {searching.value && <span class="fx-crumb"><Icon name="chevR" size={13} class="fx-sep" /><b>搜索结果</b></span>}
      <span class="sp" />
      <span class={"tag" + (ws ? "" : " warn")}>{ws ? "仅自己可见" : "所有人可见"}</span>
      {browse && !writable.value && <span class="fx-sub">这个位置只能看，不能修改</span>}
      {browse && isMine.value && <button class="btn ghost sm" title="把当前文件夹引用到对话里" onClick={referDir}><Icon name="clip" size={14} />引用此文件夹</button>}
      {browse && canOrganize && <button class="btn ghost sm" title="让 Claude 读这个文件夹，为重要文件写文件卡片存进知识库" onClick={() => organize([dirPath.value], dirAbs.value.split(/[\\/]/).filter(Boolean).pop() || dirAbs.value)}><Icon name="book" size={14} />整理进知识库</button>}
    </div>
  );
}

function Browse() {
  const m = mode.value;
  const workdir = m === "workdir";
  const w = writable.value;
  const s = sel.value;
  const ws = dirPath.value.startsWith("ws:");
  const prog = progress.value;
  // 选中的行滚到可见
  useEffect(() => { document.querySelector(".fx-ledger tr.on")?.scrollIntoView({ block: "nearest" }); }, [s?.path, entries.value]);
  const back = () => { if (s) { clearSel(); replace(filesRoute(dirPath.value), { force: true }); } else closeOverlay(); };
  const actions = !workdir ? (
    <>
      <button class="btn sm" type="button" disabled={!w} title="新建文件夹" aria-label="新建文件夹" onClick={() => void mkdirHere()}><Icon name="plus" size={14} /><span class="lb">新建文件夹</span></button>
      <button class="btn sm" type="button" disabled={!w} title="上传文件夹" aria-label="上传文件夹" onClick={() => pickers.libDir?.click()}><Icon name="folder" size={14} /><span class="lb">上传文件夹</span></button>
      <button class="btn primary sm" type="button" disabled={!w} title="上传文件" aria-label="上传文件" onClick={() => pickers.libFile?.click()}><Icon name="upload" size={14} /><span class="lb">上传文件</span></button>
    </>
  ) : null;
  const search = (
    <label class="searchbox"><Icon name="search" size={14} />
      <input placeholder="搜索文件名…" value={query.value} onInput={(e) => onSearchInput((e.target as HTMLInputElement).value)} />
    </label>
  );
  const below = (
    <>
      {workdir && (
        <div class="fx-pickbar">
          <span>{listState.value === "ok" ? "当前：" + dirAbs.value : "选一个文件夹作为这个会话的工作文件夹"}</span>
          <button class="btn primary sm" onClick={() => void pickWorkDir()}>选这个文件夹</button>
        </div>
      )}
      {prog && (
        <div class="fx-prog" role="progressbar" aria-valuenow={prog.total ? Math.round(prog.done / prog.total * 100) : 0}>
          <i style={`width:${prog.total ? Math.round(prog.done / prog.total * 100) : 0}%`} /><span>{prog.text}</span>
        </div>
      )}
    </>
  );
  return (
    <Sheet class="fx" kicker="文件库" title={ws ? "我的文件" : "公共文件库"} actions={actions} tabs={tabsFor(ws ? "ws" : "pub", workdir)} search={search}
      below={below} detail={!!s} onClose={() => closeOverlay()} onBack={back}>
      <div class="pane fx-list">
        <Crumbs />
        <List />
      </div>
      <Preview />
    </Sheet>
  );
}

// ---------- 回收站 ----------
function TrashRow({ t, admin, i }: { t: TrashItem; admin: boolean; i: number }) {
  const where = trashWhere(t);
  return (
    <tr style={`animation-delay:${Math.min(i, 20) * 25}ms`}>
      <td class="nmc"><div class="nm"><Icon name={t.is_dir ? "folder" : "file"} size={16} /><span title={t.name}>{t.name}</span></div></td>
      <td class="sub fx-where-c" title={t.orig_path}>{where}</td>
      <td class="num sub">{admin && t.who ? t.who + " · " : ""}{ftime(t.deleted_at)}{t.reason && t.reason !== "删除" ? " · " + t.reason : ""}</td>
      <td class="num sub">{t.is_dir ? "文件夹" : fsize(t.size)}</td>
      <td class="num sub">还剩 {t.days_left} 天</td>
      <td class="r">
        {t.can_restore === false ? null : <button class="btn sm" onClick={() => void restoreItem(t)}><Icon name="history" size={13} />恢复</button>}
        {admin && <button class="icon-btn" title="彻底删除" aria-label="彻底删除" onClick={() => void purgeItem(t)}><Icon name="x" size={16} /></button>}
      </td>
    </tr>
  );
}

function Trash() {
  const d = trash.value;
  const admin = me.value?.role === "admin";
  let body;
  if (trashError.value) body = <div class="err">{trashError.value}</div>;
  else if (!d) body = <div class="empty">读取中…</div>;
  else if (!d.items.length) body = <div class="fx-none"><span dangerouslySetInnerHTML={{ __html: orb(48) }} /><p class="fx-sub">回收站是空的。</p></div>;
  else body = (
    <>
      <p class="note-hint">删除的文件会在这里保留 {d.days} 天。{admin ? "你是管理员，能看到所有人删除的文件。" : "这里只有你自己删除的文件。"}</p>
      <table class="ledger fx-ledger fx-trash">
        <thead><tr><th>名称</th><th>原位置</th><th>删除时间</th><th>大小</th><th>期限</th><th /></tr></thead>
        <tbody>{d.items.map((t, i) => <TrashRow key={t.id} t={t} admin={admin} i={i} />)}</tbody>
      </table>
    </>
  );
  return (
    <Sheet class="fx" kicker="文件库" title="回收站" tabs={tabsFor("trash", false)} onClose={() => closeOverlay()}>
      <div class="pane">{body}</div>
    </Sheet>
  );
}

export function FilesSheet() {
  const r = overlayRoute.value;
  if (!r || r.name !== "files" || !me.value) return null;
  return r.trash ? <Trash /> : <Browse />;
}
