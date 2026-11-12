// 线条图标（24×24）。路径从老代码 ui.js 原样搬来。
// Icon 给组件用。
import type { JSX } from "preact";

export const ICON_PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.6-3.6",
  folder: "M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z",
  clip: "M20.5 11.5l-8.3 8.3a5 5 0 0 1-7-7L13.6 4.4a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.4a1.8 1.8 0 0 1-2.6-2.6L15 7.4",
  laptop: "M5 5.5h14a1 1 0 0 1 1 1V15H4V6.5a1 1 0 0 1 1-1zM2.5 18.5h19",
  puzzle: "M9 4.5a2 2 0 1 1 4 0V6h4v4h1.5a2 2 0 1 1 0 4H17v4.5H5V14h1.5a2 2 0 1 0 0-4H5V6h4z",
  send: "M12 19V5M5.5 11.5L12 5l6.5 6.5",
  x: "M6 6l12 12M18 6L6 18",
  chevD: "M6 9l6 6 6-6",
  chevR: "M9 6l6 6-6 6",
  chevL: "M15 6l-6 6 6 6",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  steps: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  gear: "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM12 2.8v2.4M12 18.8v2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M2.8 12h2.4M18.8 12h2.4M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16.5L14.5 12 10 7.5M14.5 12H4",
  key: "M8 11.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10.9 12.6L19.5 4M16.5 7l2.5 2.5M14.5 9l2 2",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4",
  moon: "M20.5 13.3A8.5 8.5 0 1 1 10.7 3.5a6.6 6.6 0 0 0 9.8 9.8z",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  sync: "M20 11.5A8 8 0 0 0 6.2 6.3L4 8.5M4 12.5a8 8 0 0 0 13.8 5.2L20 15.5M4 4v4.5h4.5M20 20v-4.5h-4.5",
  download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14",
  upload: "M12 20V9M7.5 13.5L12 9l4.5 4.5M5 4h14",
  external: "M14 4h6v6M20 4l-8.5 8.5M18.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V7a1.5 1.5 0 0 1 1.5-1.5H10",
  check: "M5 12.5l4.5 4.5L19 7",
  alert: "M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.2h.01",
  menu: "M4 7h16M4 12h16M4 17h16",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  users: "M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14a6.5 6.5 0 0 1 3 6",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  shield: "M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z",
  trash: "M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7M9.5 7V4.5h5V7",
  command: "M9 6.5A2.5 2.5 0 1 0 6.5 9H17.5A2.5 2.5 0 1 0 15 6.5v11A2.5 2.5 0 1 0 17.5 15H6.5A2.5 2.5 0 1 0 9 17.5z",
  chat: "M4.5 5.5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H10l-4.5 3.5V17h-1a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  terminal: "M4.5 5h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7.5 9.5l3 2.5-3 2.5M12.5 15h4",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9S9.5 5.7 12 3z",
  book: "M5 4.5h5.5A2.5 2.5 0 0 1 13 7v13a2 2 0 0 0-2-2H5zM19 4.5h-3.5A2.5 2.5 0 0 0 13 7",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2",
  stop: "M7 7h10v10H7z",
  phone: "M8 2.5h8A1.5 1.5 0 0 1 17.5 4v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5zM11 18.5h2",
  history: "M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 7.5V12l3 2",
  copy: "M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9",
  branch: "M6 4v10M6 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 10c0 4-4 4-9 6",
  shieldok: "M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6zM8.5 12l2.5 2.5 4.5-5",
};

/** 图标名不存在时用 sparkle，和老代码一致 */
export function iconPath(name: string): string {
  return ICON_PATHS[name] || ICON_PATHS.sparkle;
}

export function iconSvg(name: string, size = 18, cls = ""): string {
  const fill = name === "stop" ? "currentColor" : "none";
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPath(name)}"/></svg>`;
}

export function Icon(props: { name: string; size?: number; class?: string }): JSX.Element {
  const { name, size = 18 } = props;
  return (
    <svg
      class={"ic " + (props.class || "")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={name === "stop" ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={iconPath(name)} />
    </svg>
  );
}
