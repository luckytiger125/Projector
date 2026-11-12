// 本机文件交给 Claude：上传到台式机上自己的工作区、处理完同步回来；桌面壳里还能“添加本机文件夹”、一键同步回本机。
// 桌面壳的命令（upload_local_folder、local_link_path、sync_back）在浏览器里测不了，逻辑照老代码搬。
import { createElement } from "preact";
import { Icon } from "../../lib/icons";
import { orb } from "../../lib/avatars";
import { api, post } from "../../lib/api";
import { invoke, isDesktop } from "../../lib/desktop";
import { fsize } from "../../lib/format";
import { token } from "../../stores/auth";
import { current, ensureSession, isMine, links } from "../../stores/chat";
import { addRef } from "../../stores/composer";
import { showFiles } from "../../stores/files";
import { closeDialog, flash, openDialog, toast } from "../../stores/ui";
import type { UpFile } from "./actions";

/** 隐藏的文件选择框（由 Host 组件挂载时登记） */
export const pickers: { file: HTMLInputElement | null; dir: HTMLInputElement | null; libFile: HTMLInputElement | null; libDir: HTMLInputElement | null } =
  { file: null, dir: null, libFile: null, libDir: null };

/** 上传到台式机上自己的工作区，并把这个文件夹引用到对话里。files: [{file, rel: "子目录/a.txt"}] */
export async function uploadFiles(files: UpFile[], name: string): Promise<void> {
  if (!files.length) return;
  const total = files.reduce((n, f) => n + f.file.size, 0);
  if (total > 2 * 1073741824) { toast("一次最多上传 2 GB", "err"); return; }
  const sid = await ensureSession(name);
  const link = await post(`/api/sessions/${sid}/links`, { name });
  let done = 0;
  for (const f of files) {
    if (++done % 5 === 1 || files.length < 6) flash(`正在上传 ${done}/${files.length}：${f.rel}`, 1400);
    await api(`/api/sessions/${sid}/links/${link.id}/file?path=${encodeURIComponent(f.rel)}`, { method: "PUT", body: f.file, raw: true });
  }
  await post(`/api/sessions/${sid}/links/${link.id}/snapshot`);
  links.value = await api(`/api/sessions/${sid}/links`);
  addRef({ abs: link.abs, name: link.name, dir: true });
  toast(`已上传 ${files.length} 个文件（${fsize(total)}），已引用到对话里`, "ok");
}

/** 桌面壳：选一个本机文件夹，整个传上来并登记，之后可以一键同步回去 */
export async function addLocalFolder(): Promise<void> {
  try {
    const sid = await ensureSession("本机文件");
    flash("选好文件夹后开始上传，文件多的话要等一会儿…", 3000);
    const r = await invoke<{ abs: string; name: string; files: number; bytes: number } | null>("upload_local_folder", { sessionId: sid, token: token.value });
    if (!r) return;   // 取消了
    links.value = await api(`/api/sessions/${sid}/links`);
    addRef({ abs: r.abs, name: r.name, dir: true });
    toast(`已上传 ${r.files} 个文件（${fsize(r.bytes)}），已引用到对话里`, "ok");
  } catch (err) { toast(String(err), "err", 6000); }
}

/** “把本机文件交给 Claude”对话框 */
export function openLocalDialog(): void {
  if (!isMine.value) return;
  const desktop = isDesktop();
  const buttons = [
    { label: "选择文件", icon: "file", onClick: () => { pickers.file?.click(); } },
    { label: "选择文件夹", icon: "folder", onClick: () => { pickers.dir?.click(); } },
    ...(desktop ? [{ label: "添加本机文件夹", icon: "sync", primary: true, onClick: () => { void addLocalFolder(); } }] : []),
  ];
  const body = createElement("div", { class: "fx-local" },
    createElement("p", null, "文件会上传到台式机上", createElement("b", null, "你自己的工作区"), "（别人看不到），Claude 在那里用台式机的技能处理。"),
    desktop ? createElement("div", { class: "fx-card" },
      createElement("h5", null, createElement(Icon, { name: "sync", size: 16 }), "添加本机文件夹"),
      createElement("p", { class: "fx-sub" }, "处理完可以一键把改动同步回这台电脑的原文件夹，覆盖前会自动备份。")) : null,
    createElement("p", { class: "fx-sub" }, "也可以直接把文件拖进窗口。", desktop ? "" : "处理结果可以在“文件库 → 我的文件”里下载。"));
  openDialog("把本机文件交给 Claude", body, buttons);
}

// ---------- 查看改动 / 同步回本机 ----------
interface ChangeItem { path: string; rel: string; size: number }
interface Changes { added: ChangeItem[]; modified: ChangeItem[]; deleted: string[] }

export async function syncBack(lid: string): Promise<void> {
  const sid = current.value;
  const link = links.value.find((l) => l.id === lid) as { name?: string } | undefined;
  let ch: Changes;
  try { ch = await api<Changes>(`/api/sessions/${sid}/links/${lid}/changes`); } catch (e) { toast((e as Error).message, "err"); return; }
  const n = ch.added.length + ch.modified.length;
  const desktop = isDesktop();
  const local = desktop ? await invoke<string>("local_link_path", { linkId: lid }).catch(() => null) : null;
  const row = (it: ChangeItem, tag: string, cls: string) =>
    createElement("div", { class: "fx-chg", key: it.path },
      createElement("span", { class: "tag " + cls }, tag),
      createElement("a", { class: "fx-fp", onClick: () => { closeDialog(); showFiles(it.path); } }, it.rel),
      createElement("span", { class: "fx-sub" }, fsize(it.size)),
      local ? null : createElement("a", { class: "btn sm", href: `/api/files/raw?path=${encodeURIComponent(it.path)}&download=1`, download: "", title: "下载" }, createElement(Icon, { name: "download", size: 13 })));
  const body = n || ch.deleted.length
    ? createElement("div", null,
      ch.added.map((i) => row(i, "新增", "ok")),
      ch.modified.map((i) => row(i, "修改", "warn")),
      ch.deleted.map((r) => createElement("p", { class: "fx-sub", key: r }, `Claude 删除了 ${r}（同步时不会删除你电脑上的文件）`)),
      createElement("p", { class: "fx-sub" },
        local ? ["会写回到：", createElement("code", null, local), createElement("br", null), "被覆盖的文件会先备份到那里的 “.projector备份” 文件夹。"]
          : desktop ? "这个文件夹不是在这台电脑上添加的，只能逐个下载。"
            : "浏览器不能直接写回你的文件夹，请逐个下载；用桌面软件“添加本机文件夹”可以一键同步。"))
    : createElement("div", { class: "fx-none" }, createElement("span", { dangerouslySetInnerHTML: { __html: orb(48) } }),
      createElement("p", { class: "fx-sub" }, "Claude 还没有改动这个文件夹里的文件。"));
  openDialog(`“${link ? link.name : ""}” 的改动`, body, local && n ? [{
    label: `同步 ${n} 个文件回本机`, icon: "sync", primary: true, onClick: async () => {
      try {
        const r = await invoke<{ written: number; backups?: number }>("sync_back", { sessionId: sid, linkId: lid, token: token.value });
        toast(`已写回 ${r.written} 个文件` + (r.backups ? `，备份了 ${r.backups} 个原文件` : ""), "ok");
      } catch (e) { throw new Error(typeof e === "string" ? e : (e as Error).message); }
    },
  }] : [], true);
}
