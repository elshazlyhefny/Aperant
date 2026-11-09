import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebugLog, isDebugEnabled } from '../debug-logger';

describe('debug-logger', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('DEBUG', '');
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('is disabled by default', () => {
    expect(isDebugEnabled()).toBe(false);
    createDebugLog('ns')('hello');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is enabled by DEBUG=true', () => {
    vi.stubEnv('DEBUG', 'true');
    expect(isDebugEnabled()).toBe(true);
    createDebugLog('ns')('hello');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is enabled by NODE_ENV=development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isDebugEnabled()).toBe(true);
    createDebugLog('ns')('hello');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('prefixes the namespace and omits undefined data', () => {
    vi.stubEnv('DEBUG', 'true');
    createDebugLog('MyNs')('message');
    expect(warn).toHaveBeenCalledWith('[MyNs] message');
  });

  it('passes data as second argument when defined', () => {
    vi.stubEnv('DEBUG', 'true');
    createDebugLog('MyNs')('message', { a: 1 });
    expect(warn).toHaveBeenCalledWith('[MyNs] message', { a: 1 });
  });
});
