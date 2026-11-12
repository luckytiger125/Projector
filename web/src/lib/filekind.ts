// 文件类型：按扩展名归类（决定怎么预览、用什么颜色的小标签）。从老代码 EXT / kindOf / KIND_COLOR 原样搬来。

export type FileKind = "image" | "pdf" | "video" | "audio" | "md" | "text" | "docx" | "sheet" | "office" | "other";

const EXT: Record<Exclude<FileKind, "other">, string> = {
  image: "png jpg jpeg gif webp bmp svg ico avif tif tiff heic",
  pdf: "pdf",
  video: "mp4 webm mov m4v ogv",
  audio: "mp3 wav ogg m4a flac aac opus",
  md: "md markdown",
  text: "txt log json xml yaml yml ini cfg conf toml py js ts jsx tsx css html htm vue bat cmd ps1 sh c cpp h hpp cs java kt go rs rb php sql lua r m srt properties env gitignore",
  docx: "docx",
  sheet: "xlsx xlsm xls csv ods",
  office: "doc ppt pptx rtf odt odp wps et dps pps ppsx",
};

export function kindOf(name: string): FileKind {
  const ext = (name.split(".").pop() || "").toLowerCase();
  for (const k of Object.keys(EXT) as Array<keyof typeof EXT>) if (EXT[k].split(" ").includes(ext)) return k;
  return "other";
}

/** 回复里文件小标签前面的色块（知识库里的“来源文件”也用） */
export const KIND_COLOR: Record<FileKind, string> = {
  image: "#c46ad6", pdf: "#d9443a", video: "#7a5cf0", audio: "#e0559b", md: "#5b6b7a", text: "#7d8a96",
  docx: "#2f6fd6", sheet: "#1f9a5a", office: "#e2742c", other: "#a39a8c",
};
