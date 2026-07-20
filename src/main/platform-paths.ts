export type ExecutableBaseName = 'python' | 'ffmpeg' | 'ffprobe';

export function executableName(base: ExecutableBaseName, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${base}.exe` : base;
}

export function mediaExecutableNames(platform: NodeJS.Platform = process.platform): { ffmpeg: string; ffprobe: string } {
  return {
    ffmpeg: executableName('ffmpeg', platform),
    ffprobe: executableName('ffprobe', platform),
  };
}

export function homebrewMediaCandidates(platform: NodeJS.Platform = process.platform): { ffmpeg: string[]; ffprobe: string[] } {
  if (platform !== 'darwin') return { ffmpeg: [], ffprobe: [] };
  return {
    ffmpeg: ['/opt/homebrew/bin/ffmpeg'],
    ffprobe: ['/opt/homebrew/bin/ffprobe'],
  };
}
