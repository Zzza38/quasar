import type { PDFDocumentProxy } from 'pdfjs-dist';

/** A rendered page, in the same shape scan-schedule.tsx uses for photos. */
export type PdfPage = { image: string; mediaType: 'image/jpeg'; preview: string };
/** Text kept from one PDF; schedules are a page or two, so this only cuts off something that is not a schedule. */
export const MAX_PDF_TEXT = 12_000;
/** Long edge of a rendered page, in pixels: the same as a downscaled photo, enough for small print in a timetable grid. */
const PAGE_EDGE = 1600;

/** Whether a picked file is a PDF (some iPad file pickers leave the type empty, so the name counts too). */
export const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

/**
 * Renders the first `maxPages` pages of a PDF schedule to JPEGs and reads the text of every page (up to
 * MAX_PDF_TEXT characters), all in the browser. The text is the PDF's own, so the scanner gets class names spelled
 * exactly as printed alongside the pictures it reads the layout from. pdf.js loads only when a PDF is picked.
 */
export async function readPdf(file: File, maxPages: number): Promise<{ pages: PdfPage[]; total: number; text: string }> {
  const pdfjs = await import('pdfjs-dist');
  // The worker is bundled from the package and served from this site, which the CSP's worker-src 'self' allows.
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  // useWasm off: the CSP does not allow WebAssembly, and pdf.js has JavaScript fallbacks for the decoders it covers.
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWasm: false });
  let document: PDFDocumentProxy;
  try {
    document = await task.promise;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('That PDF is password-protected. Download it again without a password, or take a screenshot instead.');
    throw new Error('That file is not a PDF this browser can read.');
  }
  try {
    const pages: PdfPage[] = [];
    const texts: string[] = [];
    let length = 0;
    for (let number = 1; number <= document.numPages && (pages.length < maxPages || length < MAX_PDF_TEXT); number += 1) {
      const page = await document.getPage(number);
      if (length < MAX_PDF_TEXT) {
        const content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').replace(/[ \t]+/g, ' ').trim();
        if (text) { texts.push(text); length += text.length; }
      }
      if (pages.length < maxPages) {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(4, PAGE_EDGE / Math.max(base.width, base.height)) });
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not process the PDF on this device.');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const preview = canvas.toDataURL('image/jpeg', 0.85);
        pages.push({ image: preview.slice(preview.indexOf(',') + 1), mediaType: 'image/jpeg', preview });
      }
      page.cleanup();
    }
    return { pages, total: document.numPages, text: texts.join('\n\n').slice(0, MAX_PDF_TEXT) };
  } finally { await task.destroy(); }
}
