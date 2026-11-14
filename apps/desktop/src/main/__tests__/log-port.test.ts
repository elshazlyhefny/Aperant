import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLogPort, setLogger, type Logger } from '../log-port';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
}

describe('log-port', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('default logger does not throw and writes warn/error to stderr only', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => {
      appLogPort.debug('d');
      appLogPort.info('i');
      appLogPort.log('l');
    }).not.toThrow();
    expect(write).not.toHaveBeenCalled();

    appLogPort.warn('w', { a: 1 });
    appLogPort.error('e', new Error('boom'));
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('setLogger redirects the proxy', () => {
    const custom = makeLogger();
    setLogger(custom);
    appLogPort.info('hello', 1);
    appLogPort.error('bad');
    expect(custom.info).toHaveBeenCalledWith('hello', 1);
    expect(custom.error).toHaveBeenCalledWith('bad');
  });
});
