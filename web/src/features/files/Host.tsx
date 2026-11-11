// 文件库之外一直在的东西：隐藏的文件选择框、拖文件进窗口时的提示层，以及拖拽上传的处理。
//   拖到文件库（浏览模式）里 → 上传到当前打开的文件夹；拖到别处 → 上传到自己的工作区并引用到对话。
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { orb } from "../../lib/avatars";
import { route } from "../../router";
import { me } from "../../stores/auth";
import { isMine } from "../../stores/chat";
import { dirAbs, dirPath, mode, writable } from "../../stores/files";
import { toast } from "../../stores/ui";
import { uploadToLibrary } from "./actions";
import type { UpFile } from "./actions";
import { pickers, uploadFiles } from "./local";

const zone = signal<{ title: string; hint: string } | null>(null);

const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types || [])].includes("Files");
/** 文件库正开着、是浏览模式：拖进来的文件传到文件库 */
const toLibrary = (): boolean => {
  const r = route.peek();
  return r.name === "files" && !r.trash && mode.peek() === "browse";
};
const inTrash = (): boolean => { const r = route.peek(); return r.name === "files" && !!r.trash; };

/** 读出拖进来的文件和文件夹（文件夹里的一层层展开） */
async function collect(e: DragEvent): Promise<{ files: UpFile[]; entries: FileSystemEntry[] }> {
  const files: UpFile[] = [];
  const walk = (entry: FileSystemEntry, prefix: string): Promise<void> => new Promise((resolve) => {
    if (entry.isFile) (entry as FileSystemFileEntry).file((f) => { files.push({ file: f, rel: prefix + f.name }); resolve(); }, () => resolve());
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const all: FileSystemEntry[] = [];
      const read = (): void => reader.readEntries(async (batch) => {
        if (!batch.length) { for (const c of all) await walk(c, prefix + entry.name + "/"); resolve(); }
        else { all.push(...batch); read(); }
      }, () => resolve());
      read();
    } else resolve();
  });
  const entries = [...(e.dataTransfer?.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  if (entries.length) for (const en of entries) await walk(en, "");
  else files.push(...[...(e.dataTransfer?.files || [])].map((f) => ({ file: f, rel: f.name })));
  return { files, entries };
}

export function FilesHost() {
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || !me.value || inTrash()) return;
      const lib = toLibrary();
      if (!lib && !isMine.value) return;
      depth++;
      const pub = lib && !dirPath.peek().startsWith("ws:");
      zone.value = {
        title: lib ? (pub ? "松手，上传到公共文件库（所有人可见）" : "松手，上传到我的文件（仅自己可见）") : "松手，交给 Claude",
        hint: lib ? (writable.value ? dirAbs.value : "这个位置只能看，不能上传") : "文件会上传到你自己的工作区",
      };
    };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; zone.value = null; } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; zone.value = null;
      if (inTrash()) return;
      const lib = toLibrary();
      if (!me.value || (!lib && !isMine.value)) return;
      if (lib && !writable.value) { toast("这个位置只能看，不能上传", "err"); return; }
      const { files, entries } = await collect(e);
      if (lib) return uploadToLibrary(files);
      // 只拖了一个文件夹：去掉最外层，直接用文件夹名
      let name = "上传的文件";
      if (entries.length === 1 && entries[0].isDirectory) {
        name = entries[0].name;
        files.forEach((f) => { f.rel = f.rel.slice(name.length + 1); });
      }
      try { await uploadFiles(files, name); } catch (err) { toast((err as Error).message, "err"); }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over); window.removeEventListener("drop", drop);
    };
  }, []);

  const pickChat = (dir: boolean) => async (e: Event) => {
    const el = e.target as HTMLInputElement;
    const list = [...(el.files || [])];
    el.value = "";
    if (!list.length) return;
    try {
      if (dir) {
        const top = list[0].webkitRelativePath.split("/")[0];
        await uploadFiles(list.map((f) => ({ file: f, rel: f.webkitRelativePath.split("/").slice(1).join("/") || f.name })), top);
      } else await uploadFiles(list.map((f) => ({ file: f, rel: f.name })), "上传的文件");
    } catch (err) { toast((err as Error).message, "err"); }
  };
  const pickLib = (dir: boolean) => (e: Event) => {
    const el = e.target as HTMLInputElement;
    // 保留最外层文件夹名
    const fs = [...(el.files || [])].map((f) => ({ file: f, rel: dir ? f.webkitRelativePath || f.name : f.name }));
    el.value = "";
    void uploadToLibrary(fs);
  };
  const z = zone.value;
  return (
    <>
      <input type="file" multiple hidden ref={(el) => { pickers.file = el; }} onChange={pickChat(false)} />
      <input type="file" hidden {...{ webkitdirectory: "" }} ref={(el) => { pickers.dir = el; }} onChange={pickChat(true)} />
      <input type="file" multiple hidden ref={(el) => { pickers.libFile = el; }} onChange={pickLib(false)} />
      <input type="file" hidden {...{ webkitdirectory: "" }} ref={(el) => { pickers.libDir = el; }} onChange={pickLib(true)} />
      {z && (
        <div class="dropzone show" aria-hidden="true">
          <div class="dz">
            <span dangerouslySetInnerHTML={{ __html: orb(64, "busy") }} />
            <div class="dz-t">{z.title}</div>
            <p>{z.hint}</p>
          </div>
        </div>
      )}
    </>
  );
}
