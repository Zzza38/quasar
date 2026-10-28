import { CHAT } from '@/domain/chat';

/** Resize on the device before upload so phone photos fit the request and message limits. */
export async function chatImage(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP or GIF image.');
  if (file.size > 20_000_000) throw new Error('Choose an image smaller than 20 MB.');
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('This image could not be read.'));
    reader.readAsDataURL(file);
  });
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
