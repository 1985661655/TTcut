import path from 'node:path';

export const SUPPORTED_VIDEO_PICKER_EXTENSIONS = ['mp4', 'mov'] as const;

export type VideoContainer = 'mp4' | 'mov';
export type VideoContentType = 'video/mp4' | 'video/quicktime';

export function videoContainerForPath(filePath: string): VideoContainer | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.mp4') return 'mp4';
  if (extension === '.mov') return 'mov';
  return null;
}

export function mediaContentTypeForPath(filePath: string): VideoContentType {
  const container = videoContainerForPath(filePath);
  if (!container) throw new Error('INVALID_INPUT');
  return container === 'mov' ? 'video/quicktime' : 'video/mp4';
}
