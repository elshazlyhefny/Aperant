import { describe, it, expect } from 'vitest';
import { formatDroppedEnvNotice } from '../env-drop-notice';

const proj = (key: string) => ({ key, level: 'projectShared' as const });

describe('formatDroppedEnvNotice', () => {
  it('returns null for empty or undefined lists', () => {
    expect(formatDroppedEnvNotice([])).toBeNull();
    expect(formatDroppedEnvNotice(undefined)).toBeNull();
  });

  it('lists names and count', () => {
    const out = formatDroppedEnvNotice([proj('ANTHROPIC_BASE_URL'), proj('HTTP_PROXY')]);
    expect(out).toContain('Ignored 2 environment variable(s)');
    expect(out).toContain('ANTHROPIC_BASE_URL, HTTP_PROXY');
  });

  it('ignores non-project levels', () => {
    expect(formatDroppedEnvNotice([{ key: 'LD_PRELOAD', level: 'user' }])).toBeNull();
  });

  it('scrubs escape sequences in names', () => {
    const out = formatDroppedEnvNotice([proj('EVIL\x1b[2J\x07\r\nNAME')]) as string;
    expect(out).toContain('EVIL2JNAME');
    // Only the notice's own colour codes may contain ESC
    expect(out.replace(/\x1b\[33m/, '').replace(/\x1b\[0m/, '')).not.toMatch(/[\x00-\x1f]/);
  });

  it('caps name length and count', () => {
    const many = Array.from({ length: 15 }, (_, i) => proj(`VAR_${i}`));
    const out = formatDroppedEnvNotice(many) as string;
    expect(out).toContain('+5 more');
    expect(out).not.toContain('VAR_10');
    const long = formatDroppedEnvNotice([proj('A'.repeat(500))]) as string;
    expect(long).not.toContain('A'.repeat(65));
  });
});
