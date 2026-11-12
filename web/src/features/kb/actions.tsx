// 知识库的几个操作和对话框：沉淀经验、整理进知识库、点 [[链接]] 打开（没有就问要不要新建）、删除确认、历史版本。
// 文字都从老代码（kb.js）原样搬来。
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { api, post } from "../../lib/api";
import { orb } from "../../lib/avatars";
import { baseName, ftime } from "../../lib/format";
import { navigate, overlayRoute, replace } from "../../router";
import { currentSess, current, isMine, upsertSession } from "../../stores/chat";
import {
  UNCATEGORIZED, deleteNote, kbData, kbFind, kbGo, kbLoad, kbSection, kbSections, kbTab, loadKbSections, openNote, restoreVersion, startEdit,
} from "../../stores/kb";
import type { KbNoteDetail } from "../../stores/kb";
import { openDialog, toast } from "../../stores/ui";

// ---------- 沉淀经验 ----------
/** 在 Claude 的回答下面点“沉淀成经验”（也是命令面板里的“沉淀经验”） */
export async function distill(): Promise<void> {
  const id = current.peek();
  if (!id || !isMine.peek()) return;
  if (currentSess.peek()?.running) { toast("等这一轮做完再沉淀"); return; }
  try { await post(`/api/sessions/${id}/messages`, { action: "distill" }); }
  catch (e) { toast((e as Error).message, "err"); }
}

// ---------- 打开 ----------
/** 打开 [[名字]]：有就打开，没有就问要不要新建 */
export async function openByName(name: string): Promise<void> {
  if (kbTab.peek() === null && !kbGo("notes")) return;
  if (!kbData.peek()) {
    try { await kbLoad(true); } catch (e) { toast((e as Error).message, "err"); return; }
  }
  const n = kbFind(name);
  if (n) { openNote(n.path); return; }
  openDialog("还没有这条笔记", (
    <>
      <p>知识库里还没有“<b>{name}</b>”。</p>
      <p class="kb-hint">要现在写一条吗？也可以先不管，等以后有人建了它，所有链接会自动连上。</p>
    </>
  ), [{ label: "以后再说" }, {
    label: "新建", primary: true, icon: "plus",
    onClick: () => { if (kbTab.peek() !== "notes") kbGo("notes"); startEdit(null, { title: name, type: "主题" }); },
  }]);
}

/** 打开知识库里的某条笔记（相对路径）：值班板、文件路径小标签用 */
export function openPath(rel: string): void { openNote(rel); }

// ---------- 删除 ----------
export function askDelete(d: KbNoteDetail): void {
  const n = d.note;
  openDialog("删除笔记", (
    <>
      <p>删除“<b>{n.title}</b>”？</p>
      <p class="kb-hint">会放进回收站，30 天内可以恢复。链接到它的 {d.backlinks.length} 条笔记会显示成“还没写”。</p>
    </>
  ), [{ label: "取消" }, { label: "删除", danger: true, onClick: () => deleteNote(n) }]);
}

// ---------- 历史版本 ----------
interface Version { id: number; by_name?: string; note?: string; created: number; size?: number }
const histSel = signal<number | null>(null);

function HistoryBody({ versions }: { versions: Version[] }) {
  const id = histSel.value;
  const [text, setText] = useState("读取中…");
  useEffect(() => {
    if (id === null) return;
    let live = true;
    setText("读取中…");
    api<{ content: string }>("/api/kb/history/" + id).catch((e: Error) => ({ content: e.message })).then((r) => { if (live) setText(r.content); });
    return () => { live = false; };
  }, [id]);
  return (
    <div class="kb-hist">
      <div class="kb-hist-list">
        {versions.map((x) => (
          <div key={x.id} class={x.id === id ? "on" : ""} onClick={() => { histSel.value = x.id; }}>
            <b>{ftime(x.created)}</b>
            <span>{x.by_name || ""} · {x.note || ""}</span>
          </div>
        ))}
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export async function openHistory(n: KbNoteDetail["note"]): Promise<void> {
  let v: Version[];
  try { v = (await api<{ versions: Version[] }>("/api/kb/history?path=" + encodeURIComponent(n.path))).versions; }
  catch (e) { toast((e as Error).message, "err"); return; }
  if (!v.length) { toast("这条笔记还没有历史版本"); return; }
  histSel.value = v[0].id;
  openDialog(`“${n.title}” 的历史版本`, <HistoryBody versions={v} />, [
    { label: "关闭" },
    {
      label: "恢复到这个版本", primary: true, icon: "history",
      onClick: async () => {
        const sel = histSel.peek();
        if (sel === null || sel === v[0].id) { toast("这已经是最新的版本"); return false; }
        await restoreVersion(n.path, sel);
      },
    },
  ], true);
}

// ---------- 整理进知识库 ----------
const orgSection = signal(0);

function OrganizeBody({ name }: { name: string }) {
  return (
    <>
      <div class="kb-org">
        <span class="kb-org-orb" dangerouslySetInnerHTML={{ __html: orb(46) }} />
        <div>
          <p>Claude 会读一遍“<b>{name}</b>”，为重要的文件写<b>文件卡片</b>：摘要、关键信息（金额、日期、对方……）、原文件位置，并和相关的项目、客户连起来。</p>
          <p class="kb-hint">会新开一个会话来做，你可以随时去看进度。文件夹很大时会先做最重要的 30 个文件。</p>
        </div>
      </div>
      <select class="kb-select" title="分区" value={String(orgSection.value)} onChange={(e) => { orgSection.value = Number((e.target as HTMLSelectElement).value); }}>
        <option value="0">未分类</option>
        {kbSections.value.filter((s) => !s.archived).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
      </select>
    </>
  );
}

/** 打开会话：从弹层里点进会话时替换弹层这一条历史，免得后退又回到弹层 */
export function goSession(id: string): void {
  const to = "/s/" + id;
  if (overlayRoute.peek()) replace(to, { force: true }); else navigate(to, { force: true });
}

/** 文件库里点“整理进知识库”：新开一个会话让 Claude 写文件卡片 */
export async function organize(paths: string[], label?: string): Promise<void> {
  if (!kbSections.peek().length) await loadKbSections();
  const name = label || baseName(paths[0]);
  const sec = kbSection.peek();
  orgSection.value = Number(currentSess.peek()?.section_id ?? (sec && sec !== UNCATEGORIZED ? (kbSections.peek().find((s) => s.name === sec)?.id ?? 0) : 0)) || 0;
  openDialog("整理进知识库", <OrganizeBody name={name} />, [{ label: "取消" }, {
    label: "开始整理", primary: true, icon: "book",
    onClick: async () => {
      const s = await post("/api/sessions", { title: ("整理：" + name).slice(0, 20), section_id: orgSection.peek() });
      upsertSession(s);
      await post(`/api/sessions/${s.id}/messages`, { action: "organize", refs: paths });
      goSession(s.id);
    },
  }]);
}
