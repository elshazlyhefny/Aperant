import { describe, expect, it } from 'vitest';
import { modelSupportsVision, type ModelOption } from '../models';

describe('modelSupportsVision', () => {
  it('returns true for a known vision model', () => {
    expect(modelSupportsVision('sonnet')).toBe(true);
  });

  it('returns false for a catalog entry with vision: false', () => {
    expect(modelSupportsVision('glm-5')).toBe(false);
  });

  it('returns false for an injected text-only entry', () => {
    const models: ModelOption[] = [
      {
        value: 'text-only',
        label: 'Text Only',
        provider: 'openai',
        description: '',
        capabilities: { thinking: false, tools: true, vision: false, contextWindow: 1000 },
      },
    ];
    expect(modelSupportsVision('text-only', models)).toBe(false);
  });

  it('returns true for unknown ids', () => {
    expect(modelSupportsVision('some-custom-model')).toBe(true);
  });

  it('returns true for undefined', () => {
    expect(modelSupportsVision(undefined)).toBe(true);
  });
});
