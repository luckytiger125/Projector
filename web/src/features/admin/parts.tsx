// 后台各页签共用的小零件：头像、数字滚动、读取中 / 出错提示。
import { useEffect, useState } from "preact/hooks";
import { avatarEl } from "../../lib/avatars";

/** 头像（和别处一样用 avatarEl 拼的、已写死的 SVG 字符串） */
export function Ava({ id, size = 28 }: { id: string; size?: number }) {
  return <span class="ad-ava" dangerouslySetInnerHTML={{ __html: avatarEl(id || "orange", size) }} />;
}

/** 数字从 0 滚到目标值（900 毫秒，和老代码的 countUp 一样的缓出） */
export function Count({ to }: { to: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / 900);
      setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <span data-count={to}>{v}</span>;
}
