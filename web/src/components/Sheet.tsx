// 弹层骨架：一张压在页面上的册页。标题栏（眉题 + 标题 + 工具 + 关闭）、页签和搜索的工具条、内容区。
// 桌面上盖在主界面上，手机上是全屏页（左上角是返回）。文件库、知识库、技能、用量、后台都用它，样式在 sheet.css。
import type { ComponentChildren } from "preact";
import { Icon } from "../lib/icons";

export interface SheetTab {
  key: string;
  label: ComponentChildren;
  on: boolean;
  onClick: () => void;
  /** 悬停提示 */
  title?: string;
}

export interface SheetProps {
  /** 标题上面的小字（眉题） */
  kicker?: string;
  title: ComponentChildren;
  /** 标题栏右边、关闭按钮前面的工具按钮 */
  actions?: ComponentChildren;
  /** 标题栏上的一行说明文字（比如步骤记录的“只显示最近 N 条”） */
  note?: string;
  tabs?: SheetTab[];
  /** 页签行右侧，一般是搜索框 */
  search?: ComponentChildren;
  /** 工具条下面、内容区上面（进度条、提示）。没有页签也没有搜索时，工具条只留一条粗线 */
  below?: ComponentChildren;
  /** 关闭：× 按钮、点遮罩 */
  onClose: () => void;
  /** 手机上左上角的返回；不传就是关闭 */
  onBack?: () => void;
  /** 手机上正在看第二级（预览、正文）：内容区里只显示 .pane.preview */
  detail?: boolean;
  /** 点遮罩不关闭（知识库：编辑中不小心点到外面会丢字，老代码也是这样） */
  keepOnBackdrop?: boolean;
  /** 给 .sheet 加的 class（比如 files、kb） */
  class?: string;
  children: ComponentChildren;
}

export function SheetTabs({ tabs }: { tabs: SheetTab[] }) {
  return (
    <nav class="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={t.on} class={t.on ? "on" : ""} title={t.title} onClick={t.onClick}>{t.label}</button>
      ))}
    </nav>
  );
}

export function Sheet(p: SheetProps) {
  const hasBar = !!(p.tabs && p.tabs.length) || !!p.search;
  return (
    <div class="veil" onMouseDown={(e) => { if (e.target === e.currentTarget && !p.keepOnBackdrop) p.onClose(); }}>
      <section class={"sheet" + (p.detail ? " m-detail" : "") + (p.class ? " " + p.class : "")} role="dialog" aria-modal="true" aria-label={typeof p.title === "string" ? p.title : p.kicker}>
        <header class="sheet-head">
          <button class="icon-btn m-back" type="button" title="返回" aria-label="返回" onClick={() => (p.onBack || p.onClose)()}><Icon name="chevL" size={20} /></button>
          <div class="ttl">
            {p.kicker ? <div class="kicker"><span>{p.kicker}</span></div> : null}
            <h3>{p.title}</h3>
          </div>
          {p.note ? <span class="note">{p.note}</span> : null}
          {p.actions ? <div class="tools">{p.actions}</div> : null}
          <button class="icon-btn x" type="button" title="关闭" aria-label="关闭" onClick={p.onClose}><Icon name="x" size={18} /></button>
        </header>
        <div class={"sheet-bar" + (hasBar ? "" : " rule")}>
          {p.tabs && p.tabs.length ? <SheetTabs tabs={p.tabs} /> : null}
          {p.search}
        </div>
        {p.below}
        <div class={"sheet-body" + (p.detail ? " m-detail" : "")}>{p.children}</div>
      </section>
    </div>
  );
}
