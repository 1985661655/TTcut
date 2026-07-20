import { describe, expect, it } from 'vitest';
import { platformCompatibilitySchema } from '../src/shared/contracts';
import { evaluatePlatformCompatibility, type PlatformProbe } from '../src/main/platform-compatibility';

const supportedWindowsBase: PlatformProbe = {
  platform: 'win32',
  architecture: 'x64',
  buildNumber: 19045,
  installationType: 'Client',
};

describe('platform compatibility', () => {
  it.each([19045, 22000, 22621, 26100, 30000])('accepts supported Windows client build %i', (buildNumber) => {
    const result = evaluatePlatformCompatibility({ ...supportedWindowsBase, buildNumber });
    expect(platformCompatibilitySchema.parse(result)).toMatchObject({
      status: 'supported',
      reason: 'supported',
      platform: 'win32',
      build_number: buildNumber,
      installation_type: 'Client',
    });
  });

  it('accepts Apple Silicon macOS for development builds', () => {
    const result = evaluatePlatformCompatibility({
      platform: 'darwin',
      architecture: 'arm64',
      buildNumber: null,
      installationType: 'macOS',
    });
    expect(platformCompatibilitySchema.parse(result)).toMatchObject({
      status: 'supported',
      reason: 'supported',
      platform: 'darwin',
      architecture: 'arm64',
      build_number: null,
      installation_type: 'macOS',
    });
  });

  it.each([17763, 19044, 20348, 21999])('rejects unsupported Windows client build %i', (buildNumber) => {
    expect(evaluatePlatformCompatibility({ ...supportedWindowsBase, buildNumber })).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_windows_build',
    });
  });

  it('rejects Windows Server even when its build overlaps Windows 11', () => {
    expect(evaluatePlatformCompatibility({ ...supportedWindowsBase, buildNumber: 26100, installationType: 'Server' })).toMatchObject({
      status: 'unsupported',
      reason: 'windows_server',
    });
  });

  it.each([
    [{ ...supportedWindowsBase, platform: 'linux' }, 'unsupported_platform'],
    [{ ...supportedWindowsBase, architecture: 'arm64' }, 'unsupported_architecture'],
    [{ ...supportedWindowsBase, architecture: 'ia32' }, 'unsupported_architecture'],
    [{ platform: 'darwin', architecture: 'x64', buildNumber: null, installationType: 'macOS' }, 'unsupported_architecture'],
    [{ ...supportedWindowsBase, buildNumber: null, installationType: 'Unknown', probeFailed: true }, 'probe_failed'],
  ] as const)('fails closed for an unsupported or unreadable probe', (probe, reason) => {
    expect(evaluatePlatformCompatibility(probe)).toMatchObject({ status: 'unsupported', reason });
  });
});
