// Node 25 自带一个实验性的全局 localStorage，会盖住 jsdom 的（没有存储文件时它的方法都不可用）。
// 测试里统一换成一个内存实现。
const mem = new Map<string, string>();
const storage: Storage = {
  get length() { return mem.size; },
  clear: () => mem.clear(),
  getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
  key: (i) => [...mem.keys()][i] ?? null,
  removeItem: (k) => { mem.delete(k); },
  setItem: (k, v) => { mem.set(k, String(v)); },
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
