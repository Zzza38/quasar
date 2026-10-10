import type { PDFDocumentProxy } from 'pdfjs-dist';

/** A rendered page, in the same shape scan-schedule.tsx uses for photos. */
export type PdfPage = { image: string; mediaType: 'image/jpeg'; preview: string };
/** Text kept from one PDF; schedules are a page or two, so this only cuts off something that is not a schedule. */
export const MAX_PDF_TEXT = 12_000;
/** Long edge of a rendered page, in pixels: the same as a downscaled photo, enough for small print in a timetable grid. */
const PAGE_EDGE = 1600;
/** Below the server's 1,500,000-character limit per picture (MAX_SCAN_BASE64), with room to spare. */
export const MAX_PAGE_BASE64 = 1_400_000;

/** Whether a picked file is a PDF (some iPad file pickers leave the type empty, so the name counts too). */
export const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

/**
 * Renders the first `maxPages` pages of a PDF schedule to JPEGs and reads the text of those same pages (up to
 * MAX_PDF_TEXT characters), all in the browser. The text is the PDF's own, so the scanner gets class names spelled
 * exactly as printed alongside the pictures it reads the layout from. pdf.js loads only when a PDF is picked.
 */
export async function readPdf(file: File, maxPages: number): Promise<{ pages: PdfPage[]; total: number; text: string }> {
  const pdfjs = await import('pdfjs-dist');
  // The worker is bundled from the package and served from this site, which the CSP's worker-src 'self' allows.
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  // useWasm off: the CSP does not allow WebAssembly, and pdf.js has JavaScript fallbacks for the decoders it covers.
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWasm: false });
  // One try for loading and rendering, so a PDF that fails to open still has its loading task (and worker) destroyed.
  try {
    let document: PDFDocumentProxy;
    try {
      document = await task.promise;
    } catch (error) {
      if (error instanceof Error && error.name === 'PasswordException') throw new Error('That PDF is password-protected. Download it again without a password, or take a screenshot instead.');
      throw new Error('That file is not a PDF this browser can read.');
    }
    const pages: PdfPage[] = [];
    const texts: string[] = [];
    // Only the pages that are rendered are read for text too, so the scanner never gets text from a page it cannot see.
    for (let number = 1; number <= Math.min(document.numPages, maxPages); number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').replace(/[ \t]+/g, ' ').trim();
      if (text) texts.push(text);
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
      pages.push(jpegWithin(canvas));
      page.cleanup();
    }
    return { pages, total: document.numPages, text: texts.join('\n\n').slice(0, MAX_PDF_TEXT) };
  } finally { await task.destroy(); }
}

/**
 * The canvas as a JPEG whose base64 stays under MAX_PAGE_BASE64 (the server takes 1,500,000 characters a picture): lower
 * quality first, as prepareImage does for photos, then a smaller copy for a page too detailed even at low quality.
 */
function jpegWithin(source: HTMLCanvasElement): PdfPage {
  let canvas = source;
  for (;;) {
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const preview = canvas.toDataURL('image/jpeg', quality);
      const image = preview.slice(preview.indexOf(',') + 1);
      if (image.length <= MAX_PAGE_BASE64) return { image, mediaType: 'image/jpeg', preview };
    }
    if (canvas.width < 400) throw new Error('A page of that PDF is too detailed to send. Take a screenshot of it instead.');
    const smaller = globalThis.document.createElement('canvas');
    smaller.width = Math.round(canvas.width * 0.75);
    smaller.height = Math.round(canvas.height * 0.75);
    const context = smaller.getContext('2d');
    if (!context) throw new Error('Could not process the PDF on this device.');
    context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    canvas = smaller;
  }
}
