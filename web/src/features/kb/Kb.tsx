// 知识库：盖在主界面上的一张册页，三个页签（首页 / 笔记 / 关系图谱），网址 /kb、/kb/notes?note=…、/kb/graph。
// 数据和操作在 stores/kb.ts，网址同步和离开守卫在 stores/kbsync.ts。
import { Sheet } from "../../components/Sheet";
import type { SheetTab } from "../../components/Sheet";
import { Icon } from "../../lib/icons";
import { closeOverlay, overlayRoute } from "../../router";
import { me } from "../../stores/auth";
import {
  UNCATEGORIZED, clearSearch, kbData, kbEditing, kbGo, kbLoadError, kbQuery, kbSection, kbSections, lastNote, onSearchInput, setSection, startEdit,
} from "../../stores/kb";
import type { KbTab } from "../../router";
import { Editor, cancelEdit } from "./Editor";
import { Graph } from "./GraphTab";
import { Home } from "./Home";
import { Notes } from "./Notes";
import { showFiles } from "../../stores/files";

const TABS: Array<[KbTab, string]> = [["home", "首页"], ["notes", "笔记"], ["graph", "关系图谱"]];

/** 分区条：全部 / 未分类 / 各分区。三个页签共用，选了哪个分区，首页、笔记、图谱都只看它 */
function SectionBar() {
  const cur = kbSection.value;
  const item = (val: string, label: string) => (
    <button key={val} type="button" class={"pill" + (cur === val ? " on" : "")} onClick={() => void setSection(val)}>{label}</button>
  );
  return (
    <div class="kb-secbar pills" role="group" aria-label="分区">
      {item("", "全部")}{item(UNCATEGORIZED, "未分类")}
      {kbSections.value.filter((s) => !s.archived).map((s) => item(s.name, s.name))}
    </div>
  );
}

export function KbSheet() {
  const r = overlayRoute.value;
  if (!r || r.name !== "kb" || !me.value) return null;
  const tab = r.tab;
  const editing = kbEditing.value;
  const detail = tab === "notes" && (!!r.note || !!editing);   // 手机上：正在看正文或编辑，是第二级

  const tabs: SheetTab[] = TABS.map(([k, label]) => ({
    key: k, label, on: tab === k,
    onClick: () => { clearSearch(); kbGo(k, k === "notes" ? lastNote.peek() : undefined); },
  }));
  const newNote = () => {
    if (tab !== "notes" && !kbGo("notes")) return;
    startEdit(null);
  };
  // 手机上左上角的返回：编辑中就是放弃编辑，看正文就回到列表，其余是关闭
  const back = () => {
    if (editing) { cancelEdit(); return; }
    if (r.note) kbGo("notes"); else closeOverlay();
  };

  return (
    <Sheet
      class="kb" kicker="大家做过的事，都记在这里" title="知识库" keepOnBackdrop detail={detail}
      onClose={() => closeOverlay()} onBack={detail ? back : undefined}
      actions={(
        <>
          <button class="btn sm" type="button" aria-label="整理重要文件" onClick={() => showFiles()}><Icon name="folder" size={14} /><span class="lb">整理重要文件</span></button>
          <button class="btn primary sm" type="button" aria-label="新建笔记" onClick={newNote}><Icon name="plus" size={14} /><span class="lb">新建笔记</span></button>
        </>
      )}
      tabs={tabs}
      search={(
        <label class="searchbox">
          <Icon name="search" size={15} />
          <input value={kbQuery.value} placeholder="搜索经验、文件卡片、主题…" onInput={(e) => onSearchInput((e.target as HTMLInputElement).value)} />
        </label>
      )}
      below={<SectionBar />}
    >
      {!kbData.value
        ? <div class="pane"><div class="kb-empty">{kbLoadError.value ? <p class="err">{kbLoadError.value}</p> : <p class="kb-hint">读取中…</p>}</div></div>
        : tab === "home" ? <Home />
        : tab === "notes" ? <Notes editor={editing ? <Editor key={editing.id} e={editing} /> : null} />
        : <Graph />}
    </Sheet>
  );
}
