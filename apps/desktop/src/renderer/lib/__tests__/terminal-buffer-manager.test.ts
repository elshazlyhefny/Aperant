import { beforeEach, describe, expect, it } from 'vitest';
import { terminalBufferManager as m } from '../terminal-buffer-manager';

const MAX = 100_000;

describe('terminalBufferManager', () => {
  beforeEach(() => {
    for (const id of m.getAllIds()) m.dispose(id);
  });

  it('keeps ordering across chunks', () => {
    m.append('t', 'a');
    m.append('t', 'b');
    m.append('t', 'c');
    expect(m.get('t')).toBe('abc');
  });

  it('trims to exactly the last MAX chars like (a+b).slice(-N)', () => {
    let expected = '';
    for (let i = 0; i < 50; i++) {
      const chunk = String.fromCharCode(65 + (i % 26)).repeat(7_321 + i);
      m.append('t', chunk);
      expected = (expected + chunk).slice(-MAX);
      expect(m.getSize('t')).toBe(expected.length);
    }
    expect(m.get('t')).toBe(expected);
    expect(m.getSize('t')).toBe(MAX);
  });

  it('handles a single chunk bigger than the limit', () => {
    const big = 'x'.repeat(MAX - 5) + 'y'.repeat(10) + 'z'.repeat(10);
    m.append('t', big);
    expect(m.get('t')).toBe(big.slice(-MAX));
    expect(m.getSize('t')).toBe(MAX);
  });

  it('get() after more appends includes new data', () => {
    m.append('t', 'ab');
    expect(m.get('t')).toBe('ab');
    m.append('t', 'cd');
    expect(m.get('t')).toBe('abcd');
  });

  it('getAndClear returns content and empties', () => {
    m.append('t', 'a');
    m.append('t', 'b');
    expect(m.getAndClear('t')).toBe('ab');
    expect(m.get('t')).toBe('');
    expect(m.has('t')).toBe(false);
    expect(m.getSize('t')).toBe(0);
  });

  it('set then append', () => {
    m.set('t', 'hello');
    m.append('t', ' world');
    expect(m.get('t')).toBe('hello world');
    m.set('t', 'q'.repeat(MAX + 10));
    expect(m.getSize('t')).toBe(MAX);
  });

  it('getAll returns joined strings and totals use running length', () => {
    m.append('a', '1');
    m.append('a', '2');
    m.append('b', '3');
    const all = m.getAll();
    expect(all.get('a')).toBe('12');
    expect(all.get('b')).toBe('3');
    expect(m.getTotalSize()).toBe(3);
    expect(m.getStats().terminalCount).toBe(2);
  });
});
