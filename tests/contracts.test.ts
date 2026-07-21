import { describe, expect, it } from 'vitest';
import { analysisRequestSchema } from '../src/shared/contracts';

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
