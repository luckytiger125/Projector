// 关系图谱的画布：力导向布局，同类笔记颜色相同，被链接得越多圆点越大；mini 模式是首页顶上缓慢漂浮的“星空”。
// 布局和交互算法从老代码（kb.js 的 KGraph）原样搬来，只把配色和字体换成设计变量（读 --k-* 和 --ink-* 等）。
// 命令式的类，不依赖 Preact：由组件在挂载时 new、卸载时 stop()。
// 新增（算法不变）：双指缩放（手机）、屏幕像素比变了也重新量画布、停止时取消动画帧。
import { kcls } from "../../stores/kb";

export interface GNode { id: string; title: string; type: string; status?: string; deg?: number }
export interface GData { nodes: GNode[]; edges: Array<[string, string]> }
interface SNode extends GNode { x: number; y: number; vx: number; vy: number; phase: number }
interface Opts { mini?: boolean; onClick?: (n: GNode) => void }
interface Target { s: number; x: number; y: number }

export class KGraph {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  o: Opts;
  mini: boolean;
  nodes: SNode[];
  edges: Array<[SNode, SNode]>;
  nb: Map<SNode, Set<SNode>>;
  alpha = 1;
  scale: number;
  tx = 0;
  ty = 0;
  userMoved = false;
  hover: SNode | null = null;
  drag: SNode | null = null;
  t0 = performance.now();
  w = 0;
  h = 0;
  col: Record<string, string> = {};
  target: Target | null = null;
  running = true;
  ro?: ResizeObserver;
  raf = 0;
  frame = 0;
  private font = "";
  private onWinResize = () => this.resize();

  constructor(canvas: HTMLCanvasElement, data: GData, opts: Opts = {}) {
    this.c = canvas; this.ctx = canvas.getContext("2d")!; this.o = opts; this.mini = !!opts.mini;
    const byId: Record<string, SNode> = {};
    this.nodes = data.nodes.map((n, i) => {
      const a = i * 2.39996, r = 6 * Math.sqrt(i + 1);
      return (byId[n.id] = { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, phase: Math.random() * 6.28 });
    });
    this.edges = data.edges.map(([a, b]) => [byId[a], byId[b]] as [SNode, SNode]).filter(([a, b]) => a && b);
    this.nb = new Map(this.nodes.map((n) => [n, new Set<SNode>()]));
    for (const [a, b] of this.edges) { this.nb.get(a)!.add(b); this.nb.get(b)!.add(a); }
    this.scale = this.mini ? 1 : 0.9;
    this.colors();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
    window.addEventListener("resize", this.onWinResize);
    if (!this.mini) this.bind();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** 配色：读设计变量（在 kb.css 里定义），不写死颜色 */
  colors(): void {
    const cs = getComputedStyle(this.c), v = (k: string) => cs.getPropertyValue(k).trim();
    this.col = { exp: v("--k-exp"), card: v("--k-card"), topic: v("--k-topic"), other: v("--k-other"), ghost: v("--k-ghost"),
                 line: v("--hair-strong"), ink: v("--ink-2"), bg: v("--paper-0") };
    this.font = cs.fontFamily;
  }

  /** 按屏幕像素比设置画布分辨率（高分屏不糊）；窗口大小或像素比变了会重新量 */
  resize(): void {
    const r = this.c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.c.width = Math.max(1, Math.round(r.width * dpr)); this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener("resize", this.onWinResize);
  }

  radius(n: SNode): number { return (this.mini ? 2.2 : 4) + Math.sqrt(n.deg || 0) * (this.mini ? 1.3 : 2.1) + (n.type === "主题" ? 1.5 : 0); }

  step(): void {
    const ns = this.nodes, a = this.alpha, k = this.mini ? 38 : 62;
    for (let i = 0; i < ns.length; i++) {
      const p = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const q = ns[j]; let dx = p.x - q.x, dy = p.y - q.y; let d2 = dx * dx + dy * dy;
        if (d2 > 90000) continue;
        if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
        const f = (this.mini ? 260 : 900) * a / d2;
        p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
      }
    }
    for (const [p, q] of this.edges) {
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - k) / d * 0.06 * a;
      p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
    }
    for (const n of ns) {
      n.vx -= n.x * 0.006 * a; n.vy -= n.y * 0.006 * a;
      if (n === this.drag) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy;
    }
    this.alpha = Math.max(this.alpha * 0.985, this.mini ? 0.03 : 0.004);
  }

  fit(animate = false): void {
    if (!this.nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const pad = this.mini ? 20 : 70;
    const s = Math.min((this.w - pad * 2) / Math.max(x1 - x0, 1), (this.h - pad * 2) / Math.max(y1 - y0, 1), this.mini ? 1.6 : 1.8);
    this.target = { s: Math.max(s, 0.2), x: -(x0 + x1) / 2, y: -(y0 + y1) / 2 };
    if (!animate) { this.scale = this.target.s; this.tx = this.target.x; this.ty = this.target.y; }
    this.userMoved = false;
  }

  loop(t: number): void {
    if (!this.running) return;
    if (++this.frame % 120 === 0) this.colors();   // 切了主题也能跟上
    if (this.alpha > (this.mini ? 0.031 : 0.005) || this.drag || this.mini) this.step();
    // 镜头慢慢对准整张图，用户动过以后就不再自动调整
    if (!this.userMoved && t - this.t0 < 4000) this.fit(true);
    if (this.target && !this.userMoved) {
      this.scale += (this.target.s - this.scale) * 0.08; this.tx += (this.target.x - this.tx) * 0.08; this.ty += (this.target.y - this.ty) * 0.08;
    }
    this.draw(t);
    this.raf = requestAnimationFrame(this.loop);
  }

  toScreen(n: SNode): [number, number] { return [(n.x + this.tx) * this.scale + this.w / 2, (n.y + this.ty) * this.scale + this.h / 2]; }

  draw(t: number): void {
    const g = this.ctx, C = this.col, hv = this.hover, near = hv ? this.nb.get(hv)! : null;
    g.clearRect(0, 0, this.w, this.h);
    const wob = (n: SNode): [number, number] => this.mini ? [Math.sin(t / 1600 + n.phase) * 3, Math.cos(t / 1900 + n.phase) * 3] : [0, 0];
    g.lineWidth = this.mini ? 0.8 : 1;
    for (const [p, q] of this.edges) {
      const [ax, ay] = this.toScreen(p), [bx, by] = this.toScreen(q), [pw, ph] = wob(p), [qw, qh] = wob(q);
      const lit = hv && (p === hv || q === hv);
      g.strokeStyle = lit ? C[kcls(hv!.type)] : C.line;
      g.globalAlpha = hv && !lit ? 0.25 : this.mini ? 0.7 : 1;
      g.beginPath(); g.moveTo(ax + pw, ay + ph); g.lineTo(bx + qw, by + qh); g.stroke();
    }
    for (const n of this.nodes) {
      const [x0, y0] = this.toScreen(n), [w, h] = wob(n), x = x0 + w, y = y0 + h;
      const r = this.radius(n) * (this.mini ? 1 : Math.min(Math.max(this.scale, 0.6), 1.4));
      const dim = hv && n !== hv && !near!.has(n);
      const color = C[kcls(n.type)] || C.other;
      g.globalAlpha = dim ? 0.2 : 1;
      if (n.type === "ghost") {
        g.setLineDash([2, 2]); g.strokeStyle = color; g.lineWidth = 1.2;
        g.beginPath(); g.arc(x, y, r, 0, 6.283); g.stroke(); g.setLineDash([]);
      } else {
        if (n === hv || this.mini) { g.shadowColor = color; g.shadowBlur = this.mini ? 10 : 16; }
        g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
        g.shadowBlur = 0;
        if (n.status === "过时") { g.strokeStyle = C.bg; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x - r * .6, y); g.lineTo(x + r * .6, y); g.stroke(); }
      }
      if (!this.mini && n.title && (n === hv || (near && near.has(n)) || this.scale > 1.25 || (n.deg || 0) >= 3 || this.nodes.length < 25)) {
        g.globalAlpha = dim ? 0.2 : n === hv ? 1 : 0.85;
        g.font = `${n === hv ? 600 : 500} 12px ${this.font}`;
        g.textAlign = "center"; g.fillStyle = C.ink;
        const label = n.title.length > 16 ? n.title.slice(0, 15) + "…" : n.title;
        g.lineWidth = 3; g.strokeStyle = C.bg; g.strokeText(label, x, y + r + 14); g.fillText(label, x, y + r + 14);
      }
    }
    g.globalAlpha = 1;
  }

  hit(mx: number, my: number): SNode | null {
    let best: SNode | null = null, bd = Infinity;
    for (const n of this.nodes) {
      const [x, y] = this.toScreen(n), d = Math.hypot(x - mx, y - my), r = this.radius(n) + 6;
      if (d < r && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  /** 以屏幕上 (mx, my) 为中心缩放到 s（滚轮和双指共用） */
  zoomAt(mx: number, my: number, s: number): void {
    s = Math.min(Math.max(s, 0.15), 4);
    const wx = (mx - this.w / 2) / this.scale - this.tx, wy = (my - this.h / 2) / this.scale - this.ty;
    this.scale = s; this.tx = (mx - this.w / 2) / s - wx; this.ty = (my - this.h / 2) / s - wy;
    this.userMoved = true;
  }

  bind(): void {
    const c = this.c;
    const pos = (e: PointerEvent | WheelEvent): [number, number] => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let down: { mx: number; my: number; tx: number; ty: number; node: SNode | null; moved: boolean } | null = null;
    const pts = new Map<number, [number, number]>();
    let pinch: { d: number; s: number } | null = null;
    const two = (): [[number, number], [number, number]] => { const v = [...pts.values()]; return [v[0], v[1]]; };
    c.onpointerdown = (e) => {
      const [mx, my] = pos(e); c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [mx, my]);
      if (pts.size === 2) {   // 第二根手指落下：转成双指缩放，放弃正在进行的拖动
        const [a, b] = two();
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s: this.scale };
        this.drag = null; down = null;
        return;
      }
      down = { mx, my, tx: this.tx, ty: this.ty, node: this.hit(mx, my), moved: false };
      if (down.node) { this.drag = down.node; this.alpha = Math.max(this.alpha, 0.3); }
    };
    c.onpointermove = (e) => {
      const [mx, my] = pos(e);
      if (pts.has(e.pointerId)) pts.set(e.pointerId, [mx, my]);
      if (pinch && pts.size === 2) {
        const [a, b] = two();
        this.zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, pinch.s * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d));
        return;
      }
      if (down) {
        if (Math.hypot(mx - down.mx, my - down.my) > 4) down.moved = true;
        if (down.node) { down.node.x = (mx - this.w / 2) / this.scale - this.tx; down.node.y = (my - this.h / 2) / this.scale - this.ty; this.alpha = Math.max(this.alpha, 0.2); }
        else { this.tx = down.tx + (mx - down.mx) / this.scale; this.ty = down.ty + (my - down.my) / this.scale; }
        if (down.moved) this.userMoved = true;
      } else {
        this.hover = this.hit(mx, my);
        c.style.cursor = this.hover ? "pointer" : "grab";
      }
    };
    c.onpointerup = (e) => {
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      if (down && down.node && !down.moved) this.o.onClick?.(down.node);
      this.drag = null; down = null;
    };
    c.onpointercancel = (e) => { pts.delete(e.pointerId); pinch = null; this.drag = null; down = null; };
    c.onpointerleave = () => { if (!down) this.hover = null; };
    c.onwheel = (e) => {
      e.preventDefault();
      const [mx, my] = pos(e);
      this.zoomAt(mx, my, this.scale * Math.exp(-e.deltaY * 0.0015));
    };
  }
}
