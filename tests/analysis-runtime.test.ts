import { describe, expect, it } from 'vitest';
import { validateRuntimeInfo, type RuntimeInfo } from '../src/main/analysis-runtime';

const strictCpu: RuntimeInfo = {
  python: '3.12.13',
  torch: '2.12.1+cpu',
  torch_cuda: null,
  opencv: '4.13.0',
  numpy: '2.5.1',
  acceleration: 'cpu',
};

describe('analysis runtime validation', () => {
  it('keeps managed Windows CPU runtimes strict', () => {
    expect(validateRuntimeInfo(strictCpu, 'cpu')).toMatchObject({
      pythonVersion: '3.12.13',
      torchVersion: '2.12.1+cpu',
      acceleration: 'cpu',
      variant: 'cpu',
    });
  });

  it('rejects a managed runtime with the wrong Torch build', () => {
    expect(() => validateRuntimeInfo({ ...strictCpu, torch: '2.12.1+cu126' }, 'cpu')).toThrow('ANALYSIS_RUNTIME_VARIANT_MISMATCH');
  });

  it('accepts an external Apple Silicon runtime with MPS acceleration', () => {
    expect(validateRuntimeInfo({
      python: '3.12.8',
      torch: '2.5.1',
      torch_cuda: null,
      opencv: '4.10.0',
      numpy: '2.1.3',
      acceleration: 'mps',
    })).toMatchObject({
      pythonVersion: '3.12.8',
      torchVersion: '2.5.1',
      acceleration: 'mps',
      variant: 'external',
    });
  });

  it('rejects external runtimes that are not Python 3.12', () => {
    expect(() => validateRuntimeInfo({
      python: '3.11.9',
      torch: '2.5.1',
      torch_cuda: null,
      opencv: '4.10.0',
      numpy: '2.1.3',
      acceleration: 'cpu',
    })).toThrow('ANALYSIS_RUNTIME_VERSION_MISMATCH');
  });
});
