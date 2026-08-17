import { describe, expect, it } from 'vitest';
import { analysisRequestSchema, videoMetadataSchema } from '../src/shared/contracts';

const validRequest = {
  schema_version: 1,
  task_id: '22222222-2222-4222-8222-222222222222',
  video_path: '/videos/match.mp4',
  device: 'auto',
  calibration: {
    video_width: 1280,
    video_height: 720,
    points: {
      top_left: [695, 303],
      top_right: [934, 315],
      bottom_right: [831, 413],
      bottom_left: [466, 381],
    },
  },
} as const;

describe('analysis request contract', () => {
  it.each([4, 8, 12, 16])('accepts inference batch size %i', (batchSize) => {
    expect(analysisRequestSchema.parse({
      ...validRequest,
      batch_size: batchSize,
    })).toEqual({
      ...validRequest,
      batch_size: batchSize,
    });
  });

  it.each([1, 6, 32])('rejects inference batch size %i', (batchSize) => {
    expect(() => analysisRequestSchema.parse({
      ...validRequest,
      batch_size: batchSize,
    })).toThrow();
  });
});

describe('video metadata contract', () => {
  it('accepts complete MOV metadata', () => {
    const metadata = {
      path: '/videos/match.mov',
      duration_seconds: 120.5,
      width: 1920,
      height: 1080,
      fps: 59.94,
      nominal_fps: 60,
      variable_frame_rate: true,
      video_codec: 'hevc',
      audio_codec: 'aac',
      container: 'mov',
      frame_count: 7223,
      average_bitrate: 12_000_000,
      audio_bitrate: 256_000,
      pixel_format: 'yuv420p',
      audio_sample_rate: 48_000,
      audio_channels: 2,
      video_duration_seconds: 120.5,
      audio_duration_seconds: 120.48,
      video_start_time_seconds: 0,
      audio_start_time_seconds: 0,
      video_time_base: '1/60000',
      audio_time_base: '1/48000',
      rotation: 0,
      sample_aspect_ratio: '1:1',
      display_aspect_ratio: '16:9',
      color_range: 'tv',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
    } as const;

    expect(videoMetadataSchema.parse(metadata)).toEqual(metadata);
  });
});
