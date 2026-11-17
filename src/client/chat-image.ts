import { CHAT } from '@/domain/chat';

/** "data:image/gif;base64,…" for an image the composer holds as bare base64: a GIF kept whole, or the JPEG every other pick becomes. */
export function imageDataUrl(base64: string): string {
  return `data:image/${base64.startsWith('R0lGOD') ? 'gif' : 'jpeg'};base64,${base64}`;
}

/**
 * Resize on the device before upload so phone photos fit the request and message limits. With `keepGif`, a GIF is
 * sent as it is (up to CHAT.gifMaxBytes) so the server can keep it moving; drawing it on a canvas would freeze it on
 * its first frame.
 */
export async function chatImage(file: File, keepGif = false): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP or GIF image.');
  if (file.size > 20_000_000) throw new Error('Choose an image smaller than 20 MB.');
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('This image could not be read.'));
    reader.readAsDataURL(file);
  });
  if (keepGif && file.type === 'image/gif' && file.size <= CHAT.gifMaxBytes) {
    const data = source.split(',')[1];
    if (data) return data;
  }
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('This image could not be opened.'));
    element.src = source;
  });
  const ratio = Math.min(1, CHAT.imageMaxDimension / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * ratio));
  canvas.height = Math.max(1, Math.round(image.height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This image could not be opened.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.85, 0.65, 0.45]) {
    const data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if (data.length <= Math.floor(CHAT.imageMaxBytes / 3) * 4) return data;
  }
  throw new Error('This image is too large. Choose a smaller image.');
}
