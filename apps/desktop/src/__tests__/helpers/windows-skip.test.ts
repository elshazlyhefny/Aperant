import { afterEach, describe, expect, it } from 'vitest';
import { skipOnWindows } from './windows-skip';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

describe('skipOnWindows', () => {
  it('throws when the reason is empty or whitespace', () => {
    expect(() => skipOnWindows('')).toThrow();
    expect(() => skipOnWindows('   ')).toThrow();
  });

  it('returns false on non-Windows platforms', () => {
    setPlatform('linux');
    expect(skipOnWindows('uses POSIX file modes')).toBe(false);
  });

  it('returns true on Windows', () => {
    setPlatform('win32');
    expect(skipOnWindows('uses POSIX file modes')).toBe(true);
  });
});
