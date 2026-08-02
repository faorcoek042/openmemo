import type { MindElixirInstance } from 'mind-elixir';
import type { MindMapDoc } from '@openmemo/mindmap';

/**
 * 思维导图图片导出（F4）。
 *
 * ## ★ 绝不用截屏 ★
 *
 * `memo-researcher` 取证发现：竞品 memo.ac 的"导出图片字看不清"（issue #133）
 * 就是因为走了 `html2canvas` 截屏 —— 位图按屏幕像素密度定死，放大就糊。
 *
 * 我们走 **`exportSvg()` 矢量序列化**：
 * - SVG 是矢量，任意放大都清晰；
 * - PNG 走 `exportPng()`，它内部同样是先序列化 SVG 再光栅化，
 *   而不是对 DOM 截屏 —— 所以分辨率由我们指定，不受屏幕 DPI 摆布。
 *
 * `noForeignObject` 说明：默认用 `<foreignObject>` 嵌 HTML，保真度最高但
 * 某些看图器/Inkscape 不认。留一个参数让调用方能换成纯 SVG 文本模式。
 */
export type ImageFormat = 'svg' | 'png';

export async function exportMindmapBlob(
  instance: MindElixirInstance,
  format: ImageFormat,
  opts: { noForeignObject?: boolean; injectCss?: string } = {},
): Promise<Blob | null> {
  const { noForeignObject = false, injectCss } = opts;
  if (format === 'svg') {
    return instance.exportSvg(noForeignObject, injectCss);
  }
  return instance.exportPng(noForeignObject, injectCss);
}

/** 文件名安全化：用户提供的标题绝不能直接当文件名（D-01 §8.5 的同一条原则）。 */
export function safeFileName(title: string, fallback = 'mindmap'): string {
  const cleaned = Array.from(title)
    // 控制字符按码点过滤：比正则字符类可读，也不会触发 no-control-regex
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c > 0x1f && c !== 0x7f;
    })
    .join('')
    .replace(/[/\\:*?"<>|]/g, '') // 路径分隔符与 Windows 通配符
    .replace(/^\.+/, '') // 前导点（隐藏文件 / 相对路径）
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

export async function downloadMindmapImage(
  instance: MindElixirInstance,
  doc: MindMapDoc,
  format: ImageFormat,
): Promise<void> {
  const blob = await exportMindmapBlob(instance, format);
  if (!blob) throw new Error(`导出 ${format} 失败：渲染器返回空`);

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName(doc.title || 'mindmap')}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 不撤销会泄漏内存，几张大图就是几十 MB
    URL.revokeObjectURL(url);
  }
}
