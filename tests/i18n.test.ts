import { describe, expect, it } from 'vitest';
import { messages } from '../src/renderer/i18n';

describe('video input messages', () => {
  it('names MP4 and MOV in the Chinese video picker', () => {
    expect(messages('zh-CN').chooseVideo).toBe('选择 MP4 或 MOV 视频');
  });

  it('names MP4 and MOV in the Chinese invalid input error', () => {
    expect(messages('zh-CN').errors.INVALID_INPUT).toContain('MP4 或 MOV');
  });

  it('names MP4 and MOV in the English video picker', () => {
    expect(messages('en').chooseVideo).toBe('Choose MP4 or MOV video');
  });

  it('names MP4 and MOV in the English invalid input error', () => {
    expect(messages('en').errors.INVALID_INPUT).toContain('MP4 or MOV');
  });
});
