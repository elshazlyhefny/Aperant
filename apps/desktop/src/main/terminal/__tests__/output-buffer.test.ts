import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_OUTPUT_BUFFER_CHARS, TerminalOutputBuffer } from '../output-buffer';

const MAX = DEFAULT_MAX_OUTPUT_BUFFER_CHARS;

describe('TerminalOutputBuffer', () => {
  it('appends under the limit', () => {
    const b = new TerminalOutputBuffer();
    b.append('hello ');
    b.append('world');
    expect(b.toString()).toBe('hello world');
    expect(b.length).toBe(11);
  });

  it('keeps exactly the last 100_000 characters past the limit', () => {
    const b = new TerminalOutputBuffer();
    b.append('a'.repeat(60_000));
    b.append('b'.repeat(60_000));
    expect(b.length).toBe(MAX);
    expect(b.toString()).toBe(('a'.repeat(60_000) + 'b'.repeat(60_000)).slice(-MAX));
  });

  it('matches (a+b).slice(-N) semantics on random chunk sequences', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const max = 1000;
    const b = new TerminalOutputBuffer(max);
    let reference = '';
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rand() * 400);
      const chunk = String.fromCharCode(97 + (i % 26)).repeat(len);
      b.append(chunk);
      reference = (reference + chunk).slice(-max);
      expect(b.length).toBe(reference.length);
      if (i % 7 === 0) expect(b.toString()).toBe(reference);
    }
    expect(b.toString()).toBe(reference);
  });

  it('handles a single chunk larger than max', () => {
    const b = new TerminalOutputBuffer();
    const big = 'x'.repeat(MAX + 500);
    b.append(`${'y'.repeat(10)}${big}`);
    expect(b.length).toBe(MAX);
    expect(b.toString()).toBe(`${'y'.repeat(10)}${big}`.slice(-MAX));
  });

  it('invalidates the cache after append', () => {
    const b = new TerminalOutputBuffer();
    b.append('one');
    expect(b.toString()).toBe('one');
    b.append('two');
    expect(b.toString()).toBe('onetwo');
    expect(b.toString()).toBe('onetwo');
  });

  it('keeps totalAppended growing after trims', () => {
    const b = new TerminalOutputBuffer(100);
    b.append('a'.repeat(80));
    b.append('b'.repeat(80));
    b.append('c'.repeat(80));
    expect(b.length).toBe(100);
    expect(b.getTotalAppended()).toBe(240);
  });

  it('readSince works before the buffer is full', () => {
    const b = new TerminalOutputBuffer(100);
    b.append('abcdef');
    const offset = b.getTotalAppended();
    b.append('ghi');
    expect(b.readSince(offset)).toBe('ghi');
    expect(b.readSince(0)).toBe('abcdefghi');
    expect(b.readSince(b.getTotalAppended())).toBe('');
  });

  it('readSince works after the buffer is full and offset has been trimmed', () => {
    const b = new TerminalOutputBuffer(100);
    b.append('a'.repeat(100));
    const offset = b.getTotalAppended();
    b.append('b'.repeat(30));
    // Buffer is full: length stays 100, but only the new 30 chars follow the offset
    expect(b.length).toBe(100);
    expect(b.readSince(offset)).toBe('b'.repeat(30));
    // Offset older than retained window returns the whole retained buffer
    expect(b.readSince(0)).toBe(b.toString());
    expect(b.readSince(0).length).toBe(100);
  });

  it('clear empties the buffer but keeps totalAppended', () => {
    const b = new TerminalOutputBuffer();
    b.append('abc');
    b.clear();
    expect(b.toString()).toBe('');
    expect(b.length).toBe(0);
    expect(b.getTotalAppended()).toBe(3);
    b.append('d');
    expect(b.toString()).toBe('d');
  });

  it('set replaces content, slices to max and bumps totalAppended', () => {
    const b = new TerminalOutputBuffer(10);
    b.append('abc');
    b.set('0123456789ABCDE');
    expect(b.toString()).toBe('56789ABCDE');
    expect(b.length).toBe(10);
    expect(b.getTotalAppended()).toBe(3 + 15);
    b.append('Z');
    expect(b.toString()).toBe('6789ABCDEZ');
    b.set('');
    expect(b.toString()).toBe('');
  });
});
