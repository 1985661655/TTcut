import { describe, expect, it } from 'vitest';
import {
  mediaContentTypeForPath,
  SUPPORTED_VIDEO_PICKER_EXTENSIONS,
  videoContainerForPath,
} from '../src/main/video-format';

describe('video format boundaries', () => {
  it('recognizes MP4 paths', () => {
    expect(videoContainerForPath('/videos/match.mp4')).toBe('mp4');
    expect(mediaContentTypeForPath('/videos/match.mp4')).toBe('video/mp4');
  });

  it('recognizes uppercase MOV paths', () => {
    expect(videoContainerForPath('/videos/match.MOV')).toBe('mov');
    expect(mediaContentTypeForPath('/videos/match.MOV')).toBe('video/quicktime');
  });

  it('rejects unsupported MKV paths', () => {
    expect(videoContainerForPath('/videos/match.mkv')).toBeNull();
  });

  it('exposes the native picker extensions', () => {
    expect(SUPPORTED_VIDEO_PICKER_EXTENSIONS).toEqual(['mp4', 'mov']);
  });
});
