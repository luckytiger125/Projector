// dompurify 3.1.6 自带没有类型声明；只声明用到的这一个方法。净化配置一律用默认值。
declare module "dompurify" {
  const DOMPurify: { sanitize(dirty: string): string };
  export default DOMPurify;
}
