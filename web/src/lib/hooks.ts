// 组件里常用的小钩子。
import { useEffect } from "preact/hooks";

/** 点在 ref 元素外面时调用 fn */
export function useOutsideClick(active: boolean, inside: (t: Element) => boolean, fn: () => void): void {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (!inside(e.target as Element)) fn(); };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [active]);
}
