// 应用外壳：竖栏、值班目录、主区域（值班板 / 对话）、步骤记录页、通用对话框、提示条、命令面板、登录层。
import { useEffect } from "preact/hooks";
import { MobileSheet } from "./features/account/Mobile";
import { UsageSheet } from "./features/account/Usage";
import { Login } from "./features/auth/Login";
import { Chat } from "./features/chat/Chat";
import { StepsPage } from "./features/chat/StepsPage";
import { FilesHost } from "./features/files/Host";
import { FilesSheet } from "./features/files/Files";
import { Board } from "./features/home/Board";
import { SkillsSheet } from "./features/skills/Skills";
import { DialogHost, Palette, Toasts } from "./features/shell/Overlays";
import { MobileTabs, Rail, Sidebar } from "./features/shell/Shell";
import { closeOverlay, mainRoute, overlayRoute, route } from "./router";
import { loginVisible, me } from "./stores/auth";
import { dialog, dismissDialog, paletteOpen } from "./stores/ui";

declare const window: Window & { kbBeforeClose?: () => boolean };

/** 全局快捷键：Ctrl/⌘+K 命令面板；Esc 按层关闭（命令面板、对话框、文件库和步骤记录页、老弹层） */
function useGlobalKeys() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!me.value) return;
        paletteOpen.value = !paletteOpen.value;
        return;
      }
      if (e.key !== "Escape") return;
      if (paletteOpen.value) { paletteOpen.value = false; return; }
      if (dialog.value) { dismissDialog(); return; }
      for (const id of ["kbBox", "adminBox"]) {
        const box = document.getElementById(id);
        if (!box || !box.classList.contains("show")) continue;
        if (id === "kbBox") window.kbBeforeClose?.(); else box.classList.remove("show");
        return;
      }
      const o = overlayRoute.value?.name;
      if (o === "steps" || o === "files" || o === "skills" || o === "usage" || o === "mobile") closeOverlay();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);
}

export function App() {
  useGlobalKeys();
  const m = mainRoute.value;
  const chat = m.name === "session" || m.name === "new";
  const board = route.value.name === "board";
  const u = me.value;
  return (
    <div class="px">
      <div class={"app " + (chat ? "l2" : "l1")} data-m={board ? "board" : "list"}>
        <Rail level2={chat} />
        {!chat && <MobileTabs />}
        <Sidebar />
        <main class="main">{u ? (chat ? <Chat /> : <Board />) : null}</main>
      </div>
      {u && <StepsPage />}
      {u && <FilesSheet />}
      {u && <SkillsSheet />}
      {u && <UsageSheet />}
      {u && <MobileSheet />}
      <FilesHost />
      <DialogHost />
      <Palette />
      {loginVisible.value && !u && <Login />}
      <Toasts />
    </div>
  );
}
