import { describe, expect, it } from 'vitest';
import { deriveSandboxStatus, getSandboxAvailability } from '../sandbox-status';

const found = (n: string) => `/usr/bin/${n}`;
const missing = () => null;

describe('getSandboxAvailability', () => {
  it('reports bwrap available on linux', () => {
    expect(getSandboxAvailability({ platformName: 'linux', find: found })).toEqual({
      state: 'available', tool: 'bwrap', installHint: null, unsupportedModes: ['restricted-rights'],
    });
  });

  it('reports bwrap missing on linux with install hint', () => {
    expect(getSandboxAvailability({ platformName: 'linux', find: missing })).toEqual({
      state: 'tool-missing', tool: 'bwrap', installHint: 'bubblewrap', unsupportedModes: ['restricted-rights'],
    });
  });

  it('reports sandbox-exec available on macOS', () => {
    expect(getSandboxAvailability({ platformName: 'darwin', find: found })).toEqual({
      state: 'available', tool: 'sandbox-exec', installHint: null, unsupportedModes: ['restricted-rights'],
    });
  });

  it('reports sandbox-exec missing on macOS', () => {
    expect(getSandboxAvailability({ platformName: 'darwin', find: missing })).toEqual({
      state: 'tool-missing', tool: 'sandbox-exec', installHint: null, unsupportedModes: ['restricted-rights'],
    });
  });

  it('reports PowerShell available on windows', () => {
    expect(getSandboxAvailability({ platformName: 'win32', find: found })).toEqual({
      state: 'available', tool: 'powershell', installHint: null, unsupportedModes: ['home-hidden', 'home-hidden-no-network'],
    });
  });

  it('reports PowerShell missing on windows', () => {
    expect(getSandboxAvailability({ platformName: 'win32', find: missing })).toEqual({
      state: 'tool-missing', tool: 'powershell', installHint: null, unsupportedModes: ['home-hidden', 'home-hidden-no-network'],
    });
  });
});

describe('deriveSandboxStatus', () => {
  const available = { state: 'available', tool: 'bwrap', installHint: null } as const;
  const toolMissing = { state: 'tool-missing', tool: 'bwrap', installHint: 'bubblewrap' } as const;
  const unsupported = { state: 'unsupported', tool: null, installHint: null } as const;

  it('is active when enabled and tool available', () => {
    expect(deriveSandboxStatus(available, 'home-hidden')).toBe('active');
    expect(deriveSandboxStatus(available, 'home-hidden-no-network')).toBe('active');
  });

  it('is available-off when tool available but mode off', () => {
    expect(deriveSandboxStatus(available, 'off')).toBe('available-off');
  });

  it('is tool-missing regardless of mode', () => {
    expect(deriveSandboxStatus(toolMissing, 'home-hidden')).toBe('tool-missing');
    expect(deriveSandboxStatus(toolMissing, 'off')).toBe('tool-missing');
  });

  it('is unsupported regardless of mode', () => {
    expect(deriveSandboxStatus(unsupported, 'home-hidden')).toBe('unsupported');
    expect(deriveSandboxStatus(unsupported, 'off')).toBe('unsupported');
  });

  it('is mode-unsupported only for a mode the platform refuses', () => {
    const windows = getSandboxAvailability({ platformName: 'win32', find: found });
    expect(deriveSandboxStatus(windows, 'home-hidden')).toBe('mode-unsupported');
    expect(deriveSandboxStatus(windows, 'home-hidden-no-network')).toBe('mode-unsupported');
    expect(deriveSandboxStatus(windows, 'restricted-rights')).toBe('active');
    expect(deriveSandboxStatus(windows, 'off')).toBe('available-off');
    const linux = getSandboxAvailability({ platformName: 'linux', find: found });
    expect(deriveSandboxStatus(linux, 'restricted-rights')).toBe('mode-unsupported');
    expect(deriveSandboxStatus(linux, 'home-hidden')).toBe('active');
    const mac = getSandboxAvailability({ platformName: 'darwin', find: found });
    expect(deriveSandboxStatus(mac, 'restricted-rights')).toBe('mode-unsupported');
  });
});
