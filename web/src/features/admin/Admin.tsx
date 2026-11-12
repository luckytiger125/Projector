// 管理后台：盖在主界面上的一张册页，八个页签。网址 /admin/{tab}，数据在 stores/admin.ts。只有管理员能打开。
import type { SheetTab } from "../../components/Sheet";
import { Sheet } from "../../components/Sheet";
import { closeOverlay, overlayRoute, replace } from "../../router";
import type { AdminTab } from "../../router";
import { closeChat, error, pendingCount, state } from "../../stores/admin";
import { me } from "../../stores/auth";
import { ChatsList, ChatView } from "./Chats";
import { FileOpsTab } from "./FileOps";
import { LibraryTab } from "./Library";
import { ReviewTab } from "./Review";
import { SectionsTab } from "./Sections";
import { SettingsTab } from "./Settings";
import { UsageTab } from "./Usage";
import { UsersTab } from "./Users";

const TABS: Array<[AdminTab, string]> = [
  ["users", "用户"], ["chats", "聊天记录"], ["library", "技能库"], ["review", "待审核"],
  ["files", "文件记录"], ["usage", "用量"], ["sections", "分区"], ["settings", "设置"],
];

function Tab({ tab }: { tab: AdminTab }) {
  switch (tab) {
    case "users": return <UsersTab />;
    case "library": return <LibraryTab />;
    case "review": return <ReviewTab />;
    case "files": return <FileOpsTab />;
    case "usage": return <UsageTab />;
    case "sections": return <SectionsTab />;
    case "settings": return <SettingsTab />;
    default: return null;
  }
}

export function AdminSheet() {
  const r = overlayRoute.value;
  if (!r || r.name !== "admin" || !me.value || me.value.role !== "admin") return null;
  const n = pendingCount.value;
  const tabs: SheetTab[] = TABS.map(([key, label]) => ({
    key,
    label: key === "review" && n ? <>{label} <sup>{n}</sup></> : label,
    on: r.tab === key,
    onClick: () => { replace({ name: "admin", tab: key }, { force: true }); },
  }));
  const sid = r.tab === "chats" ? r.session : undefined;
  const ready = state.value === "ok";
  let body;
  if (state.value === "loading") body = <div class="empty">读取中…</div>;
  else if (state.value === "error") body = <div class="ad-err">{error.value}</div>;
  return (
    <Sheet class="ad" kicker="Projector · 综合部工作台" title="管理后台" tabs={tabs} onClose={() => closeOverlay()}
      detail={!!sid} onBack={sid ? closeChat : undefined}>
      {r.tab === "chats" ? (
        <>
          <div class={"pane ad-list" + (sid ? " split" : "")}>{ready ? <ChatsList sid={sid} /> : body}</div>
          {sid && <div class="pane preview ad-view"><ChatView sid={sid} /></div>}
        </>
      ) : <div class="pane">{ready ? <Tab tab={r.tab} /> : body}</div>}
    </Sheet>
  );
}
