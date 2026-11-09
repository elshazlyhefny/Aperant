import { describe, expect, it } from 'vitest';
import { isTrustedPageOrigin } from './origin-check';

const DEV = 'http://localhost:5173/';

describe('isTrustedPageOrigin', () => {
  it('trusts file: pages', () => {
    expect(isTrustedPageOrigin({ protocol: 'file:', origin: 'null' }, undefined)).toBe(true);
  });
  it('trusts the dev server origin', () => {
    expect(isTrustedPageOrigin({ protocol: 'http:', origin: 'http://localhost:5173' }, DEV)).toBe(true);
  });
  it('rejects a different dev origin', () => {
    expect(isTrustedPageOrigin({ protocol: 'http:', origin: 'http://localhost:9999' }, DEV)).toBe(false);
  });
  it('rejects https attacker origin', () => {
    expect(isTrustedPageOrigin({ protocol: 'https:', origin: 'https://evil.example' }, DEV)).toBe(false);
    expect(isTrustedPageOrigin({ protocol: 'https:', origin: 'https://evil.example' }, undefined)).toBe(false);
  });
  it('rejects about:blank', () => {
    expect(isTrustedPageOrigin({ protocol: 'about:', origin: 'null' }, DEV)).toBe(false);
  });
});
