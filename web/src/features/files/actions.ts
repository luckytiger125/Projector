// 文件库里用户能做的事：新建文件夹、改名、删除、上传到公共文件库（含确认和同名处理）、回收站的恢复和彻底删除、
// 引用到对话、选工作文件夹、整理进知识库。提示文字都沿用老代码。
import { createElement } from "preact";
import { api, post } from "../../lib/api";
import { invoke } from "../../lib/desktop";
import { baseName, shortPath } from "../../lib/format";
import { closeOverlay } from "../../router";
import { token } from "../../stores/auth";
import { current } from "../../stores/chat";
import { addRef, composerInput, workDir } from "../../stores/composer";
import {
  clearSel, dirAbs, dirPath, go, loadTrash, progress, refresh, sel, writable,
} from "../../stores/files";
import type { FileEntry, TrashItem } from "../../stores/files";
import { roots } from "../../stores/roots";
import { organize as organizeKb } from "../kb/actions";
import { confirmBox, openDialog, promptBox, toast } from "../../stores/ui";


// ---------- 新建、改名、删除 ----------
export async function mkdirHere(): Promise<void> {
  const name = await promptBox({ title: "新建文件夹", message: "新文件夹的名字" });
  if (!name || !name.trim()) return;
  try {
    const e = await post("/api/files/mkdir", { path: dirPath.value, name: name.trim() });
    toast("已新建文件夹：" + e.name, "ok", 2000);
    await refresh();
  } catch (err) { toast((err as Error).message, "err"); }
}

export async function renameEntry(e: FileEntry): Promise<void> {
  const name = await promptBox({ title: "重命名", message: "改成什么名字？", value: e.name });
  if (!name || name.trim() === e.name) return;
  try {
    const r = await post("/api/files/rename", { path: e.path, name: name.trim() });
    toast("已改名为 " + r.name, "ok", 2000);
    if (sel.value?.path === e.path) go(r.path);   // 正在预览它：网址跟着新名字，预览重新读
    else await refresh();
  } catch (err) { toast((err as Error).message, "err"); }
}

export async function deleteEntries(list: FileEntry[]): Promise<void> {
  const message = createElement("div", { class: "fx-del" },
    createElement("p", null, `把下面的${list.length > 1 ? " " + list.length + " 项" : ""}移到回收站？30 天内可以恢复。`),
    createElement("ul", null, list.map((e) => createElement("li", { key: e.path }, (e.dir ? "📁 " : "") + e.name))));
  const ok = await new Promise<boolean>((resolve) => {
    openDialog("移到回收站", message, [
      { label: "取消", onClick: () => resolve(false) },
      { label: "移到回收站", primary: true, onClick: () => resolve(true) },
    ], false, { onDismiss: () => resolve(false) });
  });
  if (!ok) return;
  try {
    const r = await post("/api/files/delete", { paths: list.map((e) => e.path) });
    if (r.failed.length) toast("有 " + r.failed.length + " 项没删掉：" + r.failed[0].error, "err", 6000);
    if (r.deleted.length) toast(`已移到回收站：${r.deleted.map((d: { name: string }) => d.name).join("、")}`, "ok");
    if (list.some((e) => e.path === sel.value?.path)) { clearSel(); go(dirPath.value); }
    await refresh();
  } catch (err) { toast((err as Error).message, "err"); }
}

// ---------- 上传到文件库当前打开的文件夹 ----------
export interface UpFile { file: File; rel: string }

/** 同名文件怎么办：覆盖 / 保留两份 / 跳过，可以勾“后面都这样”。关掉对话框等于“跳过，后面都跳过” */
export function askConflict(name: string): Promise<{ mode: "skip" | "rename" | "overwrite"; all: boolean }> {
  const st = { all: false };
  return new Promise((resolve) => {
    const body = createElement("div", null,
      createElement("p", null, "这个文件夹里已经有 ", createElement("b", null, name), " 了。"),
      createElement("p", { class: "fx-sub" }, "选“覆盖”的话，旧文件会放进回收站，30 天内可以找回。"),
      createElement("label", { class: "chk" },
        createElement("input", { type: "checkbox", onChange: (e: Event) => { st.all = (e.target as HTMLInputElement).checked; } }),
        "后面再遇到同名文件也这样处理"));
    const pick = (mode: "skip" | "rename" | "overwrite") => () => { resolve({ mode, all: st.all }); };
    openDialog("有同名文件", body, [
      { label: "跳过", onClick: pick("skip") },
      { label: "保留两份", onClick: pick("rename") },
      { label: "覆盖", primary: true, onClick: pick("overwrite") },
    ], false, { onDismiss: () => resolve({ mode: "skip", all: true }) });
  });
}

let skipLibConfirm = false;   // 本次页面会话内不再提示（刷新后恢复）

/** 上传到公共文件库前的确认：true 继续，false 取消，"ws" 改去“我的文件” */
function confirmLibUpload(files: UpFile[]): Promise<boolean | "ws"> {
  const st = { all: false };
  return new Promise((resolve) => {
    const n = new Set(files.map((f) => f.rel.split("/")[0])).size;
    const body = createElement("div", null,
      createElement("p", null, "这些文件会放进", createElement("b", null, "公共文件库"), "，", createElement("b", null, "所有同事都能看到"),
        "。个人文件（工资、合同、证件等）请放到“我的文件”。"),
      createElement("p", { class: "fx-sub" }, `共 ${files.length} 个文件${n < files.length ? `（${n} 项）` : ""}，目标文件夹：${dirAbs.value || "文件库根目录"}`),
      createElement("label", { class: "chk" },
        createElement("input", { type: "checkbox", onChange: (e: Event) => { st.all = (e.target as HTMLInputElement).checked; } }),
        "这次不再提示"));
    openDialog("上传到公共文件库？", body, [
      { label: "取消", onClick: () => resolve(false) },
      { label: "去我的文件", onClick: () => { resolve("ws"); go("ws:"); } },
      { label: "确认上传", primary: true, onClick: () => { if (st.all) skipLibConfirm = true; resolve(true); } },
    ], false, { onDismiss: () => resolve(false) });
  });
}

export async function uploadToLibrary(files: UpFile[]): Promise<void> {
  if (!files.length || !writable.value) return;
  if (!dirPath.value.startsWith("ws:") && !skipLibConfirm && (await confirmLibUpload(files)) !== true) return;
  const dir = dirPath.value, total = files.reduce((n, f) => n + f.file.size, 0);
  let sent = 0, ok = 0, skipped = 0;
  let policy: string | null = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    progress.value = { done: sent, total, text: `正在上传 ${i + 1}/${files.length}：${f.rel}` };
    let mode: string = policy || "ask";
    for (;;) {
      try {
        await api(`/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.rel)}&on_conflict=${mode}`,
          { method: "PUT", body: f.file, raw: true });
        ok++;
        break;
      } catch (err) {
        const msg = (err as Error).message;
        let info: { exists?: boolean; name?: string } | null = null;
        try { info = JSON.parse(msg); } catch { /* 不是同名冲突 */ }
        if (info && info.exists) {
          progress.value = { done: sent, total, text: `等你决定：${info.name}` };
          const c = await askConflict(info.name || f.rel);
          if (c.all) policy = c.mode;
          if (c.mode === "skip") { skipped++; break; }
          mode = c.mode;
          continue;
        }
        toast(`${f.rel} 上传失败：${msg}`, "err", 6000);
        break;
      }
    }
    sent += f.file.size;
  }
  progress.value = null;
  toast(`已上传 ${ok} 个文件${skipped ? `，跳过 ${skipped} 个` : ""}`, "ok");
  if (dirPath.value === dir) void refresh();
}

// ---------- 回收站 ----------
export async function restoreItem(t: TrashItem): Promise<void> {
  try {
    const r = await post(`/api/trash/${t.id}/restore`);
    toast(r.renamed ? `已恢复（原位置有同名文件，改名为 ${baseName(r.restored)}）` : "已恢复到原来的位置", "ok", 4000);
    await loadTrash();
  } catch (err) { toast((err as Error).message, "err"); }
}

export async function purgeItem(t: TrashItem): Promise<void> {
  if (!(await confirmBox({ title: "彻底删除", message: "彻底删除后就找不回来了，确定吗？", ok: "彻底删除", danger: true }))) return;
  try {
    await api(`/api/trash/${t.id}`, { method: "DELETE" });
    await loadTrash();
  } catch (err) { toast((err as Error).message, "err"); }
}

/** 回收站一行的“原位置”文字：沿用老代码 */
export function trashWhere(t: TrashItem): string {
  const where = t.can_restore === false && t.owner_name ? t.owner_name + " 的个人文件"
    : t.orig_virtual?.startsWith("ws:") ? "原来在 我的文件/" + t.orig_virtual.slice(3)   // 自己的个人文件：按“我的文件”里的路径显示
    : t.orig_path ? "原来在 " + (shortPath(t.orig_path, roots.value) || "") : t.personal ? "个人文件" : "";
  return where;
}

// ---------- 引用、选工作文件夹、整理进知识库 ----------
export function referEntry(e: FileEntry): void {
  addRef(e);
  toast("已引用：" + e.name, "ok", 2000);
}

export function referDir(): void {
  addRef({ abs: dirAbs.value, name: baseName(dirAbs.value), dir: true });
  closeOverlay();
  composerInput.focus();
}

/** 选这个文件夹作为工作文件夹：有会话就改会话，没有就先记在输入区里 */
export async function pickWorkDir(): Promise<void> {
  try {
    if (current.value) await post("/api/sessions/" + current.value, { work_dir: dirAbs.value }, "PATCH");
    else workDir.value = dirAbs.value;
    closeOverlay();
    toast("工作文件夹：" + baseName(dirAbs.value), "ok");
  } catch (e) { toast((e as Error).message, "err"); }
}

/** 让 Claude 读一遍写文件卡片（对话框在 features/kb） */
export function organize(paths: string[], label: string): void {
  void organizeKb(paths, label);
}

// ---------- 用本机程序打开（桌面壳） ----------
export async function openLocal(path: string): Promise<void> {
  try {
    await invoke("open_remote_file", { path, token: token.value });
    toast("已用本机程序打开。这是一份副本，修改后不会保存回台式机。", "ok", 5000);
  } catch (err) { toast(String(err), "err", 6000); }
}
