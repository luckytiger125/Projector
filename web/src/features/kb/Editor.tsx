// 新建 / 编辑笔记：标题、类型、标签、摘要、分区、原文件路径（文件卡片）、正文，正文里输入 [[ 弹出笔记名联想。
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isMac } from "../../lib/desktop";
import { Icon } from "../../lib/icons";
import { wikiQueryAt } from "../../lib/wikilink";
import {
  KB_TYPES, UNCATEGORIZED, kbData, kbDirty, kbFind, kbSection, kbSections, kcls, saveNote, stopEdit,
} from "../../stores/kb";
import type { KbEditing } from "../../stores/kb";
import { toast } from "../../stores/ui";

/** 取消编辑：改过就先问（文字和老代码一样） */
export function cancelEdit(): void {
  if (kbDirty.peek() && !confirm("放弃这次修改？")) return;
  stopEdit();
}

export function Editor({ e }: { e: KbEditing }) {
  const d = e.d;
  const n = d ? d.note : { title: e.preset.title || "", type: e.preset.type || "经验", tags: [] as string[], summary: "", body: "", source: "", mtime: 0, section: "" };
  const curSec = d ? (n.section || "") : (kbSection.peek() && kbSection.peek() !== UNCATEGORIZED ? kbSection.peek() : "");
  const types = [...Object.keys(KB_TYPES), ...(Object.keys(KB_TYPES).includes(n.type) ? [] : [n.type])];
  const [title, setTitle] = useState(n.title);
  const [type, setType] = useState(n.type);
  const [tags, setTags] = useState(n.tags.join("，"));
  const [summary, setSummary] = useState(n.summary);
  const [section, setSection] = useState(curSec);
  const [source, setSource] = useState(n.source || "");
  const [body, setBody] = useState(n.body);
  const [saving, setSaving] = useState(false);
  const titleEl = useRef<HTMLInputElement>(null);
  const bodyEl = useRef<HTMLTextAreaElement>(null);
  const dirty = () => { kbDirty.value = true; };

  useEffect(() => {
    const t = setTimeout(() => (n.title ? bodyEl.current : titleEl.current)?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // 保存永远读最新填的内容（快捷键和重绘之间可能隔着一次排队的渲染）
  const latest = useRef({ title, type, tags, summary, section, source, body });
  latest.current = { title, type, tags, summary, section, source, body };
  const save = async () => {
    const f = latest.current;
    const ti = f.title.trim();
    if (!ti) { toast("请写个标题", "err"); return; }
    setSaving(true);
    try {
      await saveNote(d, {
        title: ti, type: f.type, tags: f.tags.split(/[,，、\s]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean),
        summary: f.summary.trim(), body: f.body, section: f.section, source: f.source.trim(),
      });
    } catch (err) { toast((err as Error).message, "err"); setSaving(false); }
  };

  // ---------- 正文里输入 [[ 时弹出笔记名候选 ----------
  const [items, setItems] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const start = useRef(-1);
  const caret = useRef<number | null>(null);
  const closeSug = () => setItems([]);
  const update = (ta: HTMLTextAreaElement, keepSel = false) => {
    const q = wikiQueryAt(ta.value.slice(0, ta.selectionStart));
    if (!q) { closeSug(); return; }
    start.current = q.from;
    const low = q.query.toLowerCase();
    const list = (kbData.peek()?.notes || []).map((x) => x.title).filter((t) => t.toLowerCase().includes(low)).slice(0, 8);
    if (q.query.trim() && !list.some((t) => t.toLowerCase() === low)) list.push(q.query.trim());
    if (!list.length) { closeSug(); return; }
    setItems(list);
    setSel(keepSel ? (s) => Math.min(s, list.length - 1) : 0);
  };
  const pick = (i: number) => {
    const it = items[i], ta = bodyEl.current;
    if (!it || !ta) return;
    const end = ta.selectionStart;
    const after = ta.value.slice(end).startsWith("]]") ? ta.value.slice(end + 2) : ta.value.slice(end);
    caret.current = start.current + it.length + 2;
    setBody(ta.value.slice(0, start.current) + it + "]]" + after);
    closeSug(); dirty();
  };
  // 选中候选后正文重绘，再把光标放到 ]] 后面
  useLayoutEffect(() => {
    const ta = bodyEl.current;
    if (ta && caret.current !== null) { ta.setSelectionRange(caret.current, caret.current); ta.focus(); caret.current = null; }
  }, [body]);
  const onBodyKey = (ev: KeyboardEvent) => {
    if (!items.length) return;
    if (ev.key === "ArrowDown") { ev.preventDefault(); setSel((sel + 1) % items.length); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setSel((sel - 1 + items.length) % items.length); }
    else if ((ev.key === "Enter" || ev.key === "Tab") && !ev.isComposing) { ev.preventDefault(); pick(sel); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeSug(); }
  };

  return (
    <div class="kb-editor" onKeyDown={(ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); void save(); } }}>
      <div class="kv-bar">
        <span class="kb-hint">{d ? "编辑笔记" : "新建笔记"}</span><span class="sp" />
        <span class="kb-hint ke-kbd">{isMac() ? "⌘" : "Ctrl"} S 保存</span>
        <button class="btn ghost sm" type="button" onClick={cancelEdit}>取消</button>
        <button class="btn primary sm" type="button" disabled={saving} onClick={() => void save()}><Icon name="check" size={14} />保存</button>
      </div>
      <div class="kedit">
        <input class="ke-title" ref={titleEl} placeholder="标题：写成以后别人会搜的样子" value={title} maxLength={80}
          onInput={(ev) => { setTitle((ev.target as HTMLInputElement).value); dirty(); }} />
        <div class="ke-row">
          <span class="kb-seg" role="group" aria-label="类型">
            {types.map((t) => <button key={t} type="button" class={t === type ? "on" : ""} onClick={() => { setType(t); dirty(); }}>{t}</button>)}
          </span>
          <input class="input ke-in" placeholder="标签，用逗号分开" value={tags} onInput={(ev) => { setTags((ev.target as HTMLInputElement).value); dirty(); }} />
        </div>
        <input class="input" placeholder="一句话摘要（可选）：这条笔记解决什么问题" value={summary} maxLength={200}
          onInput={(ev) => { setSummary((ev.target as HTMLInputElement).value); dirty(); }} />
        <select class="kb-select" title="分区" value={section} onChange={(ev) => { setSection((ev.target as HTMLSelectElement).value); dirty(); }}>
          <option value="">未分类</option>
          {curSec && !kbSections.value.some((s) => !s.archived && s.name === curSec) ? <option value={curSec}>{curSec}（已下架）</option> : null}
          {kbSections.value.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        {type === "文件卡片"
          ? <input class="input" placeholder="原文件或文件夹的完整路径（文件卡片用，可选）" value={source} onInput={(ev) => { setSource((ev.target as HTMLInputElement).value); dirty(); }} />
          : null}
        <div class="ke-body">
          <textarea ref={bodyEl} value={body}
            placeholder={"正文，支持 Markdown：## 小标题、- 列表、**加粗**。\n输入 [[ 可以链接到其他笔记，比如 [[客户A]]。"}
            onInput={(ev) => { const ta = ev.target as HTMLTextAreaElement; setBody(ta.value); dirty(); update(ta); }}
            onClick={(ev) => update(ev.target as HTMLTextAreaElement, true)}
            onBlur={() => setTimeout(closeSug, 150)}
            onKeyDown={onBodyKey} />
          {items.length > 0 && (
            <div class="ke-sug" onMouseDown={(ev) => { const it = (ev.target as Element).closest("[data-i]") as HTMLElement | null; if (it) { ev.preventDefault(); pick(Number(it.dataset.i)); } }}>
              <div class="ke-sh">链接到笔记</div>
              {items.map((t, i) => {
                const note = kbFind(t);
                return (
                  <div key={t} class={"ke-si" + (i === sel ? " on" : "")} data-i={i}>
                    {note ? <i class={"kdot k-" + kcls(note.type)} /> : <Icon name="plus" size={12} />}
                    <span>{t}</span>{note ? null : <small>新的</small>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
