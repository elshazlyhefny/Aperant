import { describe, it, expect } from 'vitest';

import { AutoMerger } from '../auto-merger';
import {
  ConflictDetector,
  analyzeChangeCompatibility,
  type CompatibilityRule,
} from '../conflict-detector';
import {
  ChangeType,
  ConflictSeverity,
  MergeStrategy,
  createFileAnalysis,
  type FileAnalysis,
  type SemanticChange,
} from '../types';

// =============================================================================
// Factories
// =============================================================================

function makeChange(
  changeType: ChangeType,
  overrides: Partial<SemanticChange> = {},
): SemanticChange {
  return {
    changeType,
    target: 'target',
    location: 'file_top',
    lineStart: 1,
    lineEnd: 1,
    metadata: {},
    ...overrides,
  };
}

function makeAnalysis(changes: SemanticChange[], filePath = 'src/app.ts'): FileAnalysis {
  const analysis = createFileAnalysis(filePath);
  analysis.changes = changes;
  return analysis;
}

function analyses(entries: Record<string, SemanticChange[]>): Map<string, FileAnalysis> {
  return new Map(Object.entries(entries).map(([id, changes]) => [id, makeAnalysis(changes)]));
}

// =============================================================================
// analyzeChangeCompatibility
// =============================================================================

describe('analyzeChangeCompatibility', () => {
  it('treats two ADD_IMPORT changes as compatible via COMBINE_IMPORTS', () => {
    const [ok, strategy, reason] = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_IMPORT),
      makeChange(ChangeType.ADD_IMPORT),
    );
    expect(ok).toBe(true);
    expect(strategy).toBe(MergeStrategy.COMBINE_IMPORTS);
    expect(reason).not.toBe('');
  });

  it('assigns ORDER_BY_DEPENDENCY to two ADD_HOOK_CALL changes (real table)', () => {
    const [ok, strategy] = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_HOOK_CALL),
      makeChange(ChangeType.ADD_HOOK_CALL),
    );
    expect(ok).toBe(true);
    expect(strategy).toBe(MergeStrategy.ORDER_BY_DEPENDENCY);
  });

  it('assigns HOOKS_FIRST to ADD_HOOK_CALL + MODIFY_FUNCTION', () => {
    const [ok, strategy] = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_HOOK_CALL),
      makeChange(ChangeType.MODIFY_FUNCTION),
    );
    expect(ok).toBe(true);
    expect(strategy).toBe(MergeStrategy.HOOKS_FIRST);
  });

  it('assigns HOOKS_THEN_WRAP to ADD_HOOK_CALL + WRAP_JSX in both orders', () => {
    const ab = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_HOOK_CALL),
      makeChange(ChangeType.WRAP_JSX),
    );
    const ba = analyzeChangeCompatibility(
      makeChange(ChangeType.WRAP_JSX),
      makeChange(ChangeType.ADD_HOOK_CALL),
    );
    expect(ab[0]).toBe(true);
    expect(ab[1]).toBe(MergeStrategy.HOOKS_THEN_WRAP);
    expect(ba[1]).toBe(MergeStrategy.HOOKS_THEN_WRAP);
  });

  it('assigns APPEND_FUNCTIONS to ADD_FUNCTION pairs', () => {
    const [ok, strategy] = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_FUNCTION),
      makeChange(ChangeType.ADD_FUNCTION),
    );
    expect(ok).toBe(true);
    expect(strategy).toBe(MergeStrategy.APPEND_FUNCTIONS);
  });

  it('assigns APPEND_METHODS to ADD_METHOD pairs', () => {
    const [ok, strategy] = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_METHOD),
      makeChange(ChangeType.ADD_METHOD),
    );
    expect(ok).toBe(true);
    expect(strategy).toBe(MergeStrategy.APPEND_METHODS);
  });

  it('marks two MODIFY_FUNCTION changes incompatible and AI_REQUIRED', () => {
    const [ok, strategy, reason] = analyzeChangeCompatibility(
      makeChange(ChangeType.MODIFY_FUNCTION),
      makeChange(ChangeType.MODIFY_FUNCTION),
    );
    expect(ok).toBe(false);
    expect(strategy).toBe(MergeStrategy.AI_REQUIRED);
    expect(reason).not.toBe('');
  });

  it('falls back to incompatible/AI_REQUIRED for an unknown pair', () => {
    const [ok, strategy, reason] = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_COMMENT),
      makeChange(ChangeType.REMOVE_CLASS),
    );
    expect(ok).toBe(false);
    expect(strategy).toBe(MergeStrategy.AI_REQUIRED);
    expect(reason).toBe('No compatibility rule defined');
  });

  it('uses a supplied detector instead of the default one', () => {
    const detector = new ConflictDetector();
    detector.addRule({
      changeTypeA: ChangeType.ADD_COMMENT,
      changeTypeB: ChangeType.REMOVE_CLASS,
      compatible: true,
      strategy: MergeStrategy.ORDER_BY_TIME,
      reason: 'custom',
      bidirectional: false,
    });
    const [ok, strategy, reason] = analyzeChangeCompatibility(
      makeChange(ChangeType.ADD_COMMENT),
      makeChange(ChangeType.REMOVE_CLASS),
      detector,
    );
    expect(ok).toBe(true);
    expect(strategy).toBe(MergeStrategy.ORDER_BY_TIME);
    expect(reason).toBe('custom');
  });
});

// =============================================================================
// ConflictDetector.detectConflicts
// =============================================================================

describe('ConflictDetector.detectConflicts', () => {
  const detector = new ConflictDetector();

  it('returns [] for an empty map and for a single task', () => {
    expect(detector.detectConflicts(new Map())).toEqual([]);
    expect(
      detector.detectConflicts(analyses({ t1: [makeChange(ChangeType.MODIFY_FUNCTION)] })),
    ).toEqual([]);
  });

  it('returns [] when tasks touch different locations', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.MODIFY_FUNCTION, { location: 'function:a' })],
        t2: [makeChange(ChangeType.MODIFY_FUNCTION, { location: 'function:b' })],
      }),
    );
    expect(result).toEqual([]);
  });

  it('returns [] when tasks share a location but target different things', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.MODIFY_FUNCTION, { target: 'a' })],
        t2: [makeChange(ChangeType.MODIFY_FUNCTION, { target: 'b' })],
      }),
    );
    expect(result).toEqual([]);
  });

  it('reports two ADD_IMPORT changes as auto-mergeable with COMBINE_IMPORTS', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.ADD_IMPORT)],
        t2: [makeChange(ChangeType.ADD_IMPORT)],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].canAutoMerge).toBe(true);
    expect(result[0].mergeStrategy).toBe(MergeStrategy.COMBINE_IMPORTS);
    expect(result[0].severity).toBe(ConflictSeverity.NONE);
    expect(result[0].tasksInvolved).toEqual(['t1', 't2']);
    expect(result[0].filePath).toBe('src/app.ts');
  });

  it('reports ADD_HOOK_CALL + WRAP_JSX as HOOKS_THEN_WRAP', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.ADD_HOOK_CALL)],
        t2: [makeChange(ChangeType.WRAP_JSX)],
      }),
    );
    expect(result[0].canAutoMerge).toBe(true);
    expect(result[0].mergeStrategy).toBe(MergeStrategy.HOOKS_THEN_WRAP);
  });

  it('reports ADD_FUNCTION and ADD_METHOD pairs with their strategies', () => {
    const fn = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.ADD_FUNCTION)],
        t2: [makeChange(ChangeType.ADD_FUNCTION)],
      }),
    );
    const method = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.ADD_METHOD)],
        t2: [makeChange(ChangeType.ADD_METHOD)],
      }),
    );
    expect(fn[0].mergeStrategy).toBe(MergeStrategy.APPEND_FUNCTIONS);
    expect(method[0].mergeStrategy).toBe(MergeStrategy.APPEND_METHODS);
  });

  it('flags two MODIFY_FUNCTION at the same location as non-mergeable, severity >= MEDIUM', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.MODIFY_FUNCTION, { lineStart: 1, lineEnd: 5 })],
        t2: [makeChange(ChangeType.MODIFY_FUNCTION, { lineStart: 10, lineEnd: 12 })],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].canAutoMerge).toBe(false);
    expect(result[0].mergeStrategy).toBe(MergeStrategy.AI_REQUIRED);
    expect([
      ConflictSeverity.MEDIUM,
      ConflictSeverity.HIGH,
      ConflictSeverity.CRITICAL,
    ]).toContain(result[0].severity);
  });

  it('escalates overlapping double modifications to CRITICAL', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.MODIFY_FUNCTION, { lineStart: 1, lineEnd: 10 })],
        t2: [makeChange(ChangeType.MODIFY_FUNCTION, { lineStart: 5, lineEnd: 12 })],
      }),
    );
    expect(result[0].severity).toBe(ConflictSeverity.CRITICAL);
  });

  it('rates structural conflicts such as WRAP_JSX + UNWRAP_JSX as HIGH', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.WRAP_JSX)],
        t2: [makeChange(ChangeType.UNWRAP_JSX)],
      }),
    );
    expect(result[0].canAutoMerge).toBe(false);
    expect(result[0].severity).toBe(ConflictSeverity.HIGH);
  });

  it('treats a location pair with no rule as not auto-mergeable', () => {
    const result = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.ADD_COMMENT)],
        t2: [makeChange(ChangeType.REMOVE_CLASS)],
      }),
    );
    expect(result[0].canAutoMerge).toBe(false);
    expect(result[0].mergeStrategy).toBe(MergeStrategy.AI_REQUIRED);
    expect(result[0].reason).toContain('No rule for');
  });
});

// =============================================================================
// addRule
// =============================================================================

describe('ConflictDetector.addRule', () => {
  const rule = (bidirectional: boolean): CompatibilityRule => ({
    changeTypeA: ChangeType.ADD_COMMENT,
    changeTypeB: ChangeType.REMOVE_CLASS,
    compatible: true,
    strategy: MergeStrategy.ORDER_BY_TIME,
    reason: 'custom rule',
    bidirectional,
  });

  it('applies a bidirectional rule in both orders', () => {
    const d = new ConflictDetector();
    d.addRule(rule(true));
    const a = d.analyzeCompatibility(
      makeChange(ChangeType.ADD_COMMENT),
      makeChange(ChangeType.REMOVE_CLASS),
    );
    const b = d.analyzeCompatibility(
      makeChange(ChangeType.REMOVE_CLASS),
      makeChange(ChangeType.ADD_COMMENT),
    );
    expect(a).toEqual([true, MergeStrategy.ORDER_BY_TIME, 'custom rule']);
    expect(b).toEqual([true, MergeStrategy.ORDER_BY_TIME, 'custom rule']);
  });

  it('applies a one-way rule only in the declared order', () => {
    const d = new ConflictDetector();
    d.addRule(rule(false));
    expect(
      d.analyzeCompatibility(
        makeChange(ChangeType.ADD_COMMENT),
        makeChange(ChangeType.REMOVE_CLASS),
      )[0],
    ).toBe(true);
    expect(
      d.analyzeCompatibility(
        makeChange(ChangeType.REMOVE_CLASS),
        makeChange(ChangeType.ADD_COMMENT),
      )[0],
    ).toBe(false);
  });

  it('overrides an existing default rule', () => {
    const d = new ConflictDetector();
    d.addRule({
      changeTypeA: ChangeType.MODIFY_FUNCTION,
      changeTypeB: ChangeType.MODIFY_FUNCTION,
      compatible: true,
      strategy: MergeStrategy.ORDER_BY_TIME,
      reason: 'override',
      bidirectional: true,
    });
    const [ok, strategy] = d.analyzeCompatibility(
      makeChange(ChangeType.MODIFY_FUNCTION),
      makeChange(ChangeType.MODIFY_FUNCTION),
    );
    expect(ok).toBe(true);
    expect(strategy).toBe(MergeStrategy.ORDER_BY_TIME);
  });

  it('does not leak custom rules into other detector instances', () => {
    const d = new ConflictDetector();
    d.addRule(rule(true));
    const other = new ConflictDetector();
    expect(
      other.analyzeCompatibility(
        makeChange(ChangeType.ADD_COMMENT),
        makeChange(ChangeType.REMOVE_CLASS),
      )[0],
    ).toBe(false);
  });

  it('includes added compatible rules in getCompatiblePairs', () => {
    const d = new ConflictDetector();
    const before = d.getCompatiblePairs().length;
    d.addRule(rule(true));
    const pairs = d.getCompatiblePairs();
    expect(pairs).toHaveLength(before + 1);
    expect(pairs).toContainEqual([
      ChangeType.ADD_COMMENT,
      ChangeType.REMOVE_CLASS,
      MergeStrategy.ORDER_BY_TIME,
    ]);
  });
});

// =============================================================================
// getCompatiblePairs / detector-merger consistency
// =============================================================================

describe('ConflictDetector.getCompatiblePairs', () => {
  const detector = new ConflictDetector();
  const pairs = detector.getCompatiblePairs();

  it('returns a non-empty list of compatible pairs', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('only lists pairs that analyzeCompatibility reports as compatible with that strategy', () => {
    for (const [a, b, strategy] of pairs) {
      const [ok, got] = detector.analyzeCompatibility(makeChange(a), makeChange(b));
      expect(ok, `${a} + ${b}`).toBe(true);
      expect(got, `${a} + ${b}`).toBe(strategy);
    }
  });

  it('never lists AI_REQUIRED as a strategy for a compatible pair', () => {
    for (const [, , strategy] of pairs) {
      expect(strategy).not.toBe(MergeStrategy.AI_REQUIRED);
    }
  });

  it('has an AutoMerger handler for every strategy the detector can assign', () => {
    const merger = new AutoMerger();
    const strategies = new Set(pairs.map(([, , s]) => s));
    expect(strategies.size).toBeGreaterThan(0);
    for (const strategy of strategies) {
      expect(merger.canHandle(strategy), `no handler for ${strategy}`).toBe(true);
    }
  });

  it('covers every strategy handler in the merger via detectConflicts output', () => {
    const merger = new AutoMerger();
    for (const [a, b] of pairs) {
      const result = detector.detectConflicts(
        analyses({ t1: [makeChange(a)], t2: [makeChange(b)] }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].canAutoMerge, `${a} + ${b}`).toBe(true);
      if (result[0].mergeStrategy) {
        expect(merger.canHandle(result[0].mergeStrategy), `${a} + ${b}`).toBe(true);
      }
    }
  });
});

// =============================================================================
// explainConflict
// =============================================================================

describe('ConflictDetector.explainConflict', () => {
  it('returns a non-empty description including key conflict fields', () => {
    const detector = new ConflictDetector();
    const [conflict] = detector.detectConflicts(
      analyses({
        t1: [makeChange(ChangeType.MODIFY_FUNCTION)],
        t2: [makeChange(ChangeType.MODIFY_FUNCTION)],
      }),
    );
    const text = detector.explainConflict(conflict);
    expect(text).not.toBe('');
    expect(text).toContain('src/app.ts');
    expect(text).toContain('t1, t2');
    expect(text).toContain('Can auto-merge: false');
    expect(text).toContain(conflict.reason);
  });

  it('prints "none" when the conflict has no merge strategy', () => {
    const detector = new ConflictDetector();
    const text = detector.explainConflict({
      filePath: 'a.ts',
      location: 'file_top',
      tasksInvolved: ['t1'],
      changeTypes: [ChangeType.ADD_IMPORT],
      severity: ConflictSeverity.LOW,
      canAutoMerge: false,
      reason: 'x',
    });
    expect(text).toContain('Merge strategy: none');
  });
});
