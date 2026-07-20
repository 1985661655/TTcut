import { describe, expect, it } from 'vitest';
import {
  executableName,
  homebrewMediaCandidates,
  mediaExecutableNames,
} from '../src/main/platform-paths';

describe('platform paths', () => {
  it('uses .exe suffix only on Windows', () => {
    expect(executableName('python', 'win32')).toBe('python.exe');
    expect(executableName('ffmpeg', 'win32')).toBe('ffmpeg.exe');
    expect(executableName('ffprobe', 'win32')).toBe('ffprobe.exe');
    expect(executableName('python', 'darwin')).toBe('python');
    expect(executableName('ffmpeg', 'linux')).toBe('ffmpeg');
  });

  it('returns paired media executable names', () => {
    expect(mediaExecutableNames('win32')).toEqual({ ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' });
    expect(mediaExecutableNames('darwin')).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  });

  it('offers Apple Silicon Homebrew media fallbacks only on macOS', () => {
    expect(homebrewMediaCandidates('darwin')).toEqual({
      ffmpeg: ['/opt/homebrew/bin/ffmpeg'],
      ffprobe: ['/opt/homebrew/bin/ffprobe'],
    });
    expect(homebrewMediaCandidates('win32')).toEqual({ ffmpeg: [], ffprobe: [] });
  });
});
