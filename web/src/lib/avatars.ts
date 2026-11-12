// 水果头像和橙光球（SVG 字符串）。从老代码 ui.js 原样搬来：组件用 dangerouslySetInnerHTML 放进去。
// 内容全部是本文件里写死的常量和数字，不含用户输入（id 只用来查表）。

// ---------- 预设头像：16 个水果小人 ----------
export const AVATAR_LIST: [string, string][] = [
  ["orange", "橙子"], ["lemon", "柠檬"], ["lime", "青柠"], ["grapefruit", "西柚"],
  ["peach", "蜜桃"], ["cherry", "樱桃"], ["grape", "葡萄"], ["blueberry", "蓝莓"],
  ["kiwi", "猕猴桃"], ["avocado", "牛油果"], ["watermelon", "西瓜"], ["pineapple", "菠萝"],
  ["strawberry", "草莓"], ["coconut", "椰子"], ["pear", "雪梨"], ["plum", "李子"],
];
export const AVATAR_NAMES: Record<string, string> = Object.fromEntries(AVATAR_LIST);

function _face(cx: number, cy: number, s = 1, ink = "#3b2a1f") {
  const ex = 6 * s, r = 2.1 * s;
  return `<g class="face">
    <ellipse class="eye" cx="${cx - ex}" cy="${cy}" rx="${r}" ry="${r * 1.15}" fill="${ink}"/>
    <ellipse class="eye" cx="${cx + ex}" cy="${cy}" rx="${r}" ry="${r * 1.15}" fill="${ink}"/>
    <circle cx="${cx - ex + 0.8 * s}" cy="${cy - 0.8 * s}" r="${0.7 * s}" fill="#fff" opacity=".9"/>
    <circle cx="${cx + ex + 0.8 * s}" cy="${cy - 0.8 * s}" r="${0.7 * s}" fill="#fff" opacity=".9"/>
    <ellipse cx="${cx - ex - 2.5 * s}" cy="${cy + 4 * s}" rx="${2.6 * s}" ry="${1.6 * s}" fill="#ff7f72" opacity=".5"/>
    <ellipse cx="${cx + ex + 2.5 * s}" cy="${cy + 4 * s}" rx="${2.6 * s}" ry="${1.6 * s}" fill="#ff7f72" opacity=".5"/>
    <path d="M${cx - 2.6 * s} ${cy + 3.2 * s} q${2.6 * s} ${2.8 * s} ${5.2 * s} 0" stroke="${ink}" stroke-width="${1.6 * s}" fill="none" stroke-linecap="round"/>
  </g>`;
}
const _leaf = (x: number, y: number, rot = -30, c = "#5fa052") =>
  `<path d="M0 0 q7 -7 13 -2 q-6 6 -13 2z" fill="${c}" transform="translate(${x} ${y}) rotate(${rot})"/>`;
const _stem = (x1: number, y1: number, x2: number, y2: number, c = "#6b4f2a") =>
  `<path d="M${x1} ${y1} Q${(x1 + x2) / 2 + 2} ${(y1 + y2) / 2} ${x2} ${y2}" stroke="${c}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
const _shine = (x: number, y: number, r = 4) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.65}" fill="#fff" opacity=".28" transform="rotate(-30 ${x} ${y})"/>`;

const AVATAR_ART: Record<string, [string, () => string]> = {
  orange: ["#ffe8d2", () => `${_stem(32, 18, 33, 13)}<circle cx="32" cy="37" r="19" fill="#f5892b"/>${_shine(24, 28)}
    <g fill="#e2741c" opacity=".35"><circle cx="40" cy="45" r=".9"/><circle cx="44" cy="40" r=".9"/><circle cx="21" cy="44" r=".9"/></g>${_leaf(33, 15)}${_face(32, 38)}`],
  lemon: ["#fff6cc", () => `<ellipse cx="32" cy="37" rx="21" ry="16" fill="#f7d84a"/><ellipse cx="11.5" cy="37" rx="3.2" ry="2.4" fill="#efcb2f"/>
    <ellipse cx="52.5" cy="37" rx="3.2" ry="2.4" fill="#efcb2f"/>${_shine(23, 30)}${_leaf(31, 21, -50, "#7bb661")}${_face(32, 38)}`],
  lime: ["#e6f4d6", () => `<circle cx="32" cy="37" r="18" fill="#8cc152"/><circle cx="32" cy="37" r="14.5" fill="#a8d470" opacity=".55"/>
    ${_shine(24, 29)}${_leaf(32, 19, -40, "#4e8a3a")}${_face(32, 38)}`],
  grapefruit: ["#ffe1d8", () => `<circle cx="32" cy="36" r="20" fill="#f7a072"/><circle cx="32" cy="36" r="16.5" fill="#f4675a"/>
    <g stroke="#ffd6cc" stroke-width="1.1" opacity=".55">${[0, 45, 90, 135].map((a: number) => `<line x1="32" y1="20" x2="32" y2="52" transform="rotate(${a} 32 36)"/>`).join("")}</g>
    <circle cx="32" cy="36" r="9" fill="#f4675a"/>${_face(32, 37, 0.95, "#5a1d17")}`],
  peach: ["#ffe6dc", () => `<path d="M32 55C15 52 12 33 21 25c5-4 9-3 11 1 2-4 6-5 11-1 9 8 6 27-11 30z" fill="#f9a88b"/>
    <path d="M32 26q-4 13 0 28" stroke="#e8836a" stroke-width="1.6" fill="none" opacity=".55"/>${_shine(23, 33, 3.5)}${_leaf(33, 23, -35)}${_face(32, 40)}`],
  cherry: ["#ffe0e3", () => `<path d="M21 33Q26 18 38 12M41 32Q39 20 38 12" stroke="#5e7d34" stroke-width="2" fill="none" stroke-linecap="round"/>
    ${_leaf(38, 12, -10)}<circle cx="20" cy="40" r="11" fill="#b81d33"/><circle cx="38" cy="41" r="15" fill="#d7263d"/>${_shine(32, 34, 3.5)}${_face(38, 43, 0.85, "#3a0d12")}`],
  grape: ["#ece3fa", () => `${_stem(32, 17, 33, 12)}${_leaf(33, 14, -25)}<g fill="#8e6bd1">
    <circle cx="23" cy="25" r="7.5"/><circle cx="32" cy="23" r="7.5"/><circle cx="41" cy="25" r="7.5"/><circle cx="19" cy="35" r="7.5"/><circle cx="45" cy="35" r="7.5"/></g>
    <circle cx="32" cy="40" r="13.5" fill="#7e57c2"/>${_shine(27, 34, 3)}${_face(32, 41, 0.85, "#22133d")}`],
  blueberry: ["#e2e8fb", () => `<circle cx="32" cy="37" r="19" fill="#4c6edb"/>${_shine(24, 29)}
    <path d="M27 18.5l2.5 3 2.5-4 2.5 4 2.5-3-1 5h-8z" fill="#2c3f8c"/>${_face(32, 39, 1, "#111a3d")}`],
  kiwi: ["#efe9dd", () => `<circle cx="32" cy="36" r="20" fill="#8d6e4a"/><circle cx="32" cy="36" r="17" fill="#9ccc65"/>
    <g fill="#2e2a1f">${Array.from({ length: 12 }, (_, i) => { const a = i / 12 * Math.PI * 2; return `<ellipse cx="${32 + Math.cos(a) * 12}" cy="${36 + Math.sin(a) * 12}" rx="1" ry="1.7" transform="rotate(${a * 57.3 + 90} ${32 + Math.cos(a) * 12} ${36 + Math.sin(a) * 12})"/>`; }).join("")}</g>
    <circle cx="32" cy="36" r="8.5" fill="#eef7e0"/>${_face(32, 36, 0.62)}`],
  avocado: ["#eef3dc", () => `<path d="M32 12c7 0 9 8 10 13 1 4 9 9 9 19 0 9-8 13-19 13S13 53 13 44c0-10 8-15 9-19 1-5 3-13 10-13z" fill="#557a2e"/>
    <path d="M32 16c5 0 6.5 6 7.5 10 1 3.5 7.5 8 7.5 17 0 7-6.5 10.5-15 10.5S17 50 17 43c0-9 6.5-13.5 7.5-17 1-4 2.5-10 7.5-10z" fill="#d9e8a5"/>
    <circle cx="32" cy="43" r="7" fill="#8d5a3b"/>${_shine(29, 41, 2)}${_face(32, 29, 0.75)}`],
  watermelon: ["#e3f3e0", () => `<path d="M8 27a24 24 0 0 0 48 0z" fill="#3f9b4a"/><path d="M11 27a21 21 0 0 0 42 0z" fill="#eef7e4"/>
    <path d="M13.5 27a18.5 18.5 0 0 0 37 0z" fill="#ef5350"/><g fill="#3a1f1a"><ellipse cx="21" cy="35" rx="1.1" ry="1.8"/><ellipse cx="43" cy="35" rx="1.1" ry="1.8"/><ellipse cx="27" cy="41" rx="1.1" ry="1.8"/><ellipse cx="37" cy="41" rx="1.1" ry="1.8"/></g>
    ${_face(32, 32, 0.9, "#3a1212")}`],
  pineapple: ["#fff1cf", () => `<g fill="#5fa052"><path d="M32 6l4 14h-8z"/><path d="M22 10l9 11-6 2z"/><path d="M42 10l-9 11 6 2z"/></g>
    <ellipse cx="32" cy="40" rx="15.5" ry="18" fill="#f9c74f"/><g stroke="#df9f1f" stroke-width="1.2" opacity=".55">
    <path d="M20 32l24 18M20 44l18-14M26 25l20 15M18 39l10-8"/></g>${_face(32, 41, 0.95)}`],
  strawberry: ["#ffe1e4", () => `<path d="M32 56C18 50 11 35 16 26c4-6 28-6 32 0 5 9-2 24-16 30z" fill="#e8414f"/>
    <g fill="#ffe08a">${[[22, 34], [42, 34], [26, 46], [38, 46], [32, 52], [19, 41], [45, 41]].map(([x, y]: number[]) => `<ellipse cx="${x}" cy="${y}" rx=".9" ry="1.4"/>`).join("")}</g>
    <path d="M20 23l6 3 6-6 6 6 6-3-3 6H23z" fill="#4f9a45"/>${_face(32, 36, 0.95, "#3a0d12")}`],
  coconut: ["#efe4dc", () => `<circle cx="32" cy="37" r="19" fill="#7b5b45"/><g fill="#4a3326"><circle cx="27" cy="25" r="1.6"/><circle cx="37" cy="25" r="1.6"/><circle cx="32" cy="22" r="1.6"/></g>
    ${_shine(23, 31)}${_face(32, 39, 1, "#fff3e0")}`],
  pear: ["#f2f5d8", () => `${_stem(32, 15, 34, 9)}${_leaf(34, 11, -20)}<path d="M32 14c5 0 7 6 7 11 0 4 10 9 10 19 0 9-8 13-17 13s-17-4-17-13c0-10 10-15 10-19 0-5 2-11 7-11z" fill="#c9d86a"/>
    ${_shine(26, 38, 3.5)}${_face(32, 42)}`],
  plum: ["#f1e1f1", () => `<circle cx="32" cy="37" r="18" fill="#8e3b8e"/><path d="M32 20q-5 17 0 35" stroke="#6f2a6f" stroke-width="1.5" fill="none" opacity=".6"/>
    ${_shine(24, 29)}${_leaf(32, 20, -45, "#5f8f3a")}${_face(32, 39, 1, "#fff0fa")}`],
};

export function avatarSVG(id: string, size = 32) {
  const art = AVATAR_ART[id] || AVATAR_ART.orange;
  return `<svg class="ava-svg" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="${art[0]}"/>${art[1]()}</svg>`;
}
export function avatarEl(id: string, size = 32, cls = "") {
  return `<span class="ava ${cls}" title="${AVATAR_NAMES[id] || ""}" style="width:${size}px;height:${size}px">${avatarSVG(id, size)}</span>`;
}

// ---------- 橙光球：Claude 的形象 ----------
// state：idle 呼吸 / busy 旋转流光 / wait 琥珀色脉动
export function orb(size = 28, state = "idle") {
  return `<span class="orb orb-${state}" style="--s:${size}px"><i></i><b></b></span>`;
}

