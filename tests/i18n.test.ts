import { describe, expect, it } from 'vitest';
import { messages } from '../src/renderer/i18n';

const languageCases = [
  { language: 'zh-CN', formats: 'MP4 或 MOV', chooseVideo: '选择 MP4 或 MOV 视频' },
  { language: 'en', formats: 'MP4 or MOV', chooseVideo: 'Choose MP4 or MOV video' },
] as const;

describe.each(languageCases)('$language video input messages', ({ language, formats, chooseVideo }) => {
  const copy = messages(language);

  it.each([
    ['selectDescription', copy.selectDescription],
    ['chooseVideo', copy.chooseVideo],
    ['dropVideo', copy.dropVideo],
    ['invalidFile', copy.invalidFile],
    ['errors.INVALID_INPUT', copy.errors.INVALID_INPUT],
  ])('%s names both supported formats', (_key, value) => {
    expect(value).toContain(formats);
  });

  it('keeps the required video picker wording', () => {
    expect(copy.chooseVideo).toBe(chooseVideo);
  });
});
