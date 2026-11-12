// 预览类第三方库：用到时才动态加载，单独分包，不进首屏。
// 返回值和原来 vendor 脚本挂的全局对象（docx / XLSX / qrcode）用法一致。

let docxP: Promise<any> | null = null;
let xlsxP: Promise<any> | null = null;
let qrP: Promise<any> | null = null;

const failMsg = () => new Error("预览组件加载失败，请刷新页面重试");

export function loadDocx(): Promise<any> {
  return (docxP ||= (async () => {
    // docx-preview 的 npm 版自己 import jszip，不需要先挂全局
    return await import("docx-preview");
  })().catch((e) => { docxP = null; throw failMsg(); }));
}

export function loadXlsx(): Promise<any> {
  return (xlsxP ||= (async () => {
    const XLSX: any = await import("xlsx");
    // npm 版默认不带代码页，中文 xls（GBK 等）要手动补上
    const cpt: any = await import("xlsx/dist/cpexcel.full.mjs");
    XLSX.set_cptable(cpt);
    return XLSX;
  })().catch((e) => { xlsxP = null; throw failMsg(); }));
}

export function loadQrcode(): Promise<any> {
  return (qrP ||= (async () => {
    const m: any = await import("qrcode-generator");
    return m.default || m;
  })().catch((e) => { qrP = null; throw failMsg(); }));
}
