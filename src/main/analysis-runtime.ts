import { ANALYSIS_PYTHON_VERSION, expectedTorchVersion, type AnalysisRuntimeVariant } from './runtime-layout';

export const ANALYSIS_NUMPY_VERSION = '2.5.1';
export const ANALYSIS_OPENCV_VERSION = '4.13.0';

export type AnalysisAcceleration = 'cuda' | 'mps' | 'cpu';
export type ValidatedRuntimeVariant = AnalysisRuntimeVariant | 'external';

export type RuntimeInfo = {
  python: string;
  torch: string;
  torch_cuda: string | null;
  opencv: string;
  numpy: string;
  acceleration: AnalysisAcceleration;
};

export type AnalysisRuntimeValidation = {
  version: string;
  pythonVersion: string;
  torchVersion: string;
  acceleration: AnalysisAcceleration;
  variant: ValidatedRuntimeVariant;
};

export const ANALYSIS_RUNTIME_PROBE = [
  'import cv2,json,numpy,sys,torch',
  'mps_available = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()',
  'acceleration = "cuda" if torch.cuda.is_available() else "mps" if mps_available else "cpu"',
  'print(json.dumps({"python":sys.version.split()[0],"torch":torch.__version__,"torch_cuda":torch.version.cuda,"opencv":cv2.__version__,"numpy":numpy.__version__,"acceleration":acceleration}))',
].join(';');

function isAnalysisAcceleration(value: unknown): value is AnalysisAcceleration {
  return value === 'cuda' || value === 'mps' || value === 'cpu';
}

function runtimeInfoFromRecord(value: Record<string, unknown>): RuntimeInfo {
  if (
    typeof value.python !== 'string'
    || typeof value.torch !== 'string'
    || (typeof value.torch_cuda !== 'string' && value.torch_cuda !== null)
    || typeof value.opencv !== 'string'
    || typeof value.numpy !== 'string'
    || !isAnalysisAcceleration(value.acceleration)
  ) {
    throw new Error('ANALYSIS_RUNTIME_SELF_TEST_FAILED');
  }
  return {
    python: value.python,
    torch: value.torch,
    torch_cuda: value.torch_cuda,
    opencv: value.opencv,
    numpy: value.numpy,
    acceleration: value.acceleration,
  };
}

export function parseRuntimeInfo(stdout: string): RuntimeInfo {
  const value = JSON.parse(stdout.trim()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ANALYSIS_RUNTIME_SELF_TEST_FAILED');
  return runtimeInfoFromRecord(value as Record<string, unknown>);
}

export function validateRuntimeInfo(
  value: RuntimeInfo,
  expectedVariant?: AnalysisRuntimeVariant,
): AnalysisRuntimeValidation {
  if (expectedVariant) {
    const acceptedTorchVersions = new Set<string>([
      expectedTorchVersion('cpu'),
      expectedTorchVersion('cu126'),
    ]);
    if (value.python !== ANALYSIS_PYTHON_VERSION || !acceptedTorchVersions.has(value.torch)) {
      throw new Error('ANALYSIS_RUNTIME_VERSION_MISMATCH');
    }
    if (value.numpy !== ANALYSIS_NUMPY_VERSION || value.opencv !== ANALYSIS_OPENCV_VERSION) {
      throw new Error('ANALYSIS_RUNTIME_VERSION_MISMATCH');
    }
    if (value.acceleration === 'mps') throw new Error('ANALYSIS_RUNTIME_SELF_TEST_FAILED');
    const inferredVariant: AnalysisRuntimeVariant = value.torch === expectedTorchVersion('cu126') ? 'cu126' : 'cpu';
    if (value.torch !== expectedTorchVersion(expectedVariant)) throw new Error('ANALYSIS_RUNTIME_VARIANT_MISMATCH');
    if (expectedVariant === 'cpu' && (value.torch_cuda !== null || value.acceleration !== 'cpu')) {
      throw new Error('ANALYSIS_RUNTIME_VARIANT_MISMATCH');
    }
    if (expectedVariant === 'cu126' && (value.torch_cuda !== '12.6' || value.acceleration !== 'cuda')) {
      throw new Error('CUDA_RUNTIME_SELF_TEST_FAILED');
    }
    return {
      version: `Python ${value.python} / PyTorch ${value.torch}`,
      pythonVersion: value.python,
      torchVersion: value.torch,
      acceleration: value.acceleration,
      variant: expectedVariant ?? inferredVariant,
    };
  }

  if (!value.python.startsWith('3.12.')) throw new Error('ANALYSIS_RUNTIME_VERSION_MISMATCH');
  return {
    version: `Python ${value.python} / PyTorch ${value.torch}`,
    pythonVersion: value.python,
    torchVersion: value.torch,
    acceleration: value.acceleration,
    variant: 'external',
  };
}
