import { describe, it, expect } from 'vitest';

import { AutoMerger, type MergeContext } from '../auto-merger';
import {
  ChangeType,
  ConflictSeverity,
  MergeDecision,
  MergeStrategy,
  type ConflictRegion,
  type SemanticChange,
  type TaskSnapshot,
} from '../types';

// =============================================================================
// Factories
// =============================================================================

function makeChange(overrides: Partial<SemanticChange> & { changeType: ChangeType }): SemanticChange {
  return {
    target: 'target',
    location: 'file_top',
    lineStart: 1,
    lineEnd: 1,
    metadata: {},
    ...overrides,
  };
}

function makeSnapshot(
  taskId: string,
  semanticChanges: SemanticChange[],
  startedAt: Date = new Date('2025-01-01T00:00:00Z'),
): TaskSnapshot {
  return {
    taskId,
    taskIntent: `intent of ${taskId}`,
    startedAt,
    contentHashBefore: 'hash-before',
    contentHashAfter: 'hash-after',
    semanticChanges,
  };
}

function makeConflict(overrides: Partial<ConflictRegion> = {}): ConflictRegion {
  return {
    filePath: 'src/file.tsx',
    location: 'file_top',
    tasksInvolved: ['task-1', 'task-2'],
    changeTypes: [],
    severity: ConflictSeverity.LOW,
    canAutoMerge: true,
    reason: 'test',
    ...overrides,
  };
}

function makeContext(
  baselineContent: string,
  taskSnapshots: TaskSnapshot[],
  conflictOverrides: Partial<ConflictRegion> = {},
  filePath = 'src/file.tsx',
): MergeContext {
  return {
    filePath,
    baselineContent,
    taskSnapshots,
    conflict: makeConflict({ filePath, ...conflictOverrides }),
  };
}

const merger = new AutoMerger();

// =============================================================================
// canHandle / unregistered strategies
// =============================================================================

describe('AutoMerger.canHandle', () => {
  it('handles the nine deterministic strategies', () => {
    for (const strategy of [
      MergeStrategy.COMBINE_IMPORTS,
      MergeStrategy.HOOKS_FIRST,
      MergeStrategy.HOOKS_THEN_WRAP,
      MergeStrategy.APPEND_FUNCTIONS,
      MergeStrategy.APPEND_METHODS,
      MergeStrategy.COMBINE_PROPS,
      MergeStrategy.ORDER_BY_DEPENDENCY,
      MergeStrategy.ORDER_BY_TIME,
      MergeStrategy.APPEND_STATEMENTS,
    ]) {
      expect(merger.canHandle(strategy)).toBe(true);
    }
  });

  it('does not handle AI_REQUIRED or HUMAN_REQUIRED', () => {
    expect(merger.canHandle(MergeStrategy.AI_REQUIRED)).toBe(false);
    expect(merger.canHandle(MergeStrategy.HUMAN_REQUIRED)).toBe(false);
  });

  it('returns FAILED for an unregistered strategy', () => {
    const result = merger.merge(makeContext('const a = 1;\n', []), MergeStrategy.AI_REQUIRED);
    expect(result.decision).toBe(MergeDecision.FAILED);
    expect(result.error).toContain(MergeStrategy.AI_REQUIRED);
    expect(result.mergedContent).toBeUndefined();
  });
});

// =============================================================================
// COMBINE_IMPORTS
// =============================================================================

describe('COMBINE_IMPORTS', () => {
  const baseline = [
    "import React from 'react';",
    "import { a } from './a';",
    '',
    'export function run() {',
    '  return a;',
    '}',
    '',
  ].join('\n');

  const addImport = (text: string) =>
    makeChange({ changeType: ChangeType.ADD_IMPORT, contentAfter: text });

  const baselineNoExport = baseline.replace('export function run', 'function run');

  it('inserts new imports after the last existing import', () => {
    const ctx = makeContext(baselineNoExport, [
      makeSnapshot('t1', [addImport("import { b } from './b';")]),
      makeSnapshot('t2', [addImport("import { c } from './c';")]),
    ]);
    const result = merger.merge(ctx, MergeStrategy.COMBINE_IMPORTS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    const lines = result.mergedContent!.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      "import React from 'react';",
      "import { a } from './a';",
      "import { b } from './b';",
      "import { c } from './c';",
    ]);
    expect(result.mergedContent).toContain('function run()');
  });

  // Known bug: isImportLine() treats any `export ` line as an import, so new imports
  // land after the first export statement instead of the import block (fixed in subtask-2-1).
  it.fails('inserts new imports before a following export statement', () => {
    const ctx = makeContext(baseline, [makeSnapshot('t1', [addImport("import { b } from './b';")])]);
    const merged = merger.merge(ctx, MergeStrategy.COMBINE_IMPORTS).mergedContent!;
    expect(merged.indexOf("import { b }")).toBeLessThan(merged.indexOf('export function run'));
  });

  it('dedupes imports added by several tasks and imports already present', () => {
    const ctx = makeContext(baseline, [
      makeSnapshot('t1', [addImport("import { b } from './b';")]),
      makeSnapshot('t2', [addImport("import { b } from './b';"), addImport("import { a } from './a';")]),
    ]);
    const result = merger.merge(ctx, MergeStrategy.COMBINE_IMPORTS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    const merged = result.mergedContent!;
    expect(merged.split("import { b } from './b';").length - 1).toBe(1);
    expect(merged.split("import { a } from './a';").length - 1).toBe(1);
  });

  it('removes imports requested by REMOVE_IMPORT', () => {
    const ctx = makeContext(baseline, [
      makeSnapshot('t1', [
        makeChange({ changeType: ChangeType.REMOVE_IMPORT, contentBefore: "import { a } from './a';" }),
      ]),
    ]);
    const result = merger.merge(ctx, MergeStrategy.COMBINE_IMPORTS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).not.toContain("import { a } from './a';");
    expect(result.mergedContent).toContain("import React from 'react';");
  });

  it('does not add an import that another task removes', () => {
    const ctx = makeContext(baseline, [
      makeSnapshot('t1', [addImport("import { z } from './z';")]),
      makeSnapshot('t2', [
        makeChange({ changeType: ChangeType.REMOVE_IMPORT, contentBefore: "import { z } from './z';" }),
      ]),
    ]);
    const result = merger.merge(ctx, MergeStrategy.COMBINE_IMPORTS);
    expect(result.mergedContent).not.toContain("'./z'");
  });

  it('handles python imports', () => {
    const py = 'import os\nfrom x import y\n\ndef f():\n    pass\n';
    const ctx = makeContext(
      py,
      [makeSnapshot('t1', [addImport('import sys')])],
      {},
      'src/mod.py',
    );
    const result = merger.merge(ctx, MergeStrategy.COMBINE_IMPORTS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent!.split('\n').slice(0, 3)).toEqual(['import os', 'from x import y', 'import sys']);
  });
});

// =============================================================================
// Hook insertion (HOOKS_FIRST, HOOKS_THEN_WRAP, ORDER_BY_DEPENDENCY)
// =============================================================================

const HOOK = 'const { data } = useQuery(key);';

interface HookBaseline {
  name: string;
  /** Text of the declaration line up to and including the opening brace. */
  opening: string;
  /** True when the current implementation is known to fail for this shape. */
  failsToday: boolean;
}

const HOOK_BASELINES: HookBaseline[] = [
  { name: 'plain function', opening: 'function App() {', failsToday: false },
  { name: 'function with return type', opening: 'function App(): JSX.Element {', failsToday: false },
  { name: 'typed arrow component', opening: 'const App: FC = () => {', failsToday: false },
  { name: 'destructured default param', opening: 'function App({ onClick = () => {} }) {', failsToday: false },
  { name: 'function expression', opening: 'const App = function() {', failsToday: false },
  { name: 'generic function with return type', opening: 'function App<T>(props: P): R {', failsToday: false },
  { name: 'typed variable with generic annotation', opening: 'const App: FC<Props> = (props) => {', failsToday: false },
  { name: 'async function declaration', opening: 'export async function App() {', failsToday: false },
  { name: 'export default async function', opening: 'export default async function App() {', failsToday: false },
  { name: 'generic arrow', opening: 'const App = <T,>(props: T): JSX.Element => {', failsToday: false },
  { name: 'export default function', opening: 'export default function App() {', failsToday: false },
  {
    name: 'async arrow with return type',
    opening: 'const App = async (props: Props): Promise<void> => {',
    failsToday: false,
  },
];

function hookBaseline(opening: string): string {
  return ["import React from 'react';", '', opening, '  return null;', '}', ''].join('\n');
}

function hookChange(target = 'App'): SemanticChange {
  return makeChange({
    changeType: ChangeType.ADD_HOOK_CALL,
    target,
    location: `function:${target}`,
    contentAfter: HOOK,
  });
}

describe.each([
  [MergeStrategy.HOOKS_FIRST, 'function:App'],
  [MergeStrategy.HOOKS_THEN_WRAP, 'function:App'],
  [MergeStrategy.ORDER_BY_DEPENDENCY, 'function:App'],
] as const)('%s hook insertion', (strategy, location) => {
  for (const { name, opening, failsToday } of HOOK_BASELINES) {
    const run = failsToday ? it.fails : it;
    run(`places the hook right after the opening brace: ${name}`, () => {
      const ctx = makeContext(hookBaseline(opening), [makeSnapshot('t1', [hookChange()])], { location });
      const result = merger.merge(ctx, strategy);
      expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
      expect(result.mergedContent).toContain(`${opening}\n  ${HOOK}`);
    });
  }

  it('inserts several hooks in order', () => {
    const second = makeChange({
      changeType: ChangeType.ADD_HOOK_CALL,
      target: 'App',
      location: 'function:App',
      contentAfter: 'const { theme } = useTheme();',
    });
    const ctx = makeContext(
      hookBaseline('function App() {'),
      [makeSnapshot('t1', [hookChange()]), makeSnapshot('t2', [second])],
      { location },
    );
    const result = merger.merge(ctx, strategy);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).toContain('function App() {');
    expect(result.mergedContent).toContain(HOOK);
    expect(result.mergedContent).toContain('const { theme } = useTheme();');
  });

  // Known bug: extractHookCall() uses [^)]* so nested parentheses truncate the hook.
  it.fails('keeps hooks with nested parentheses intact', () => {
    const nested = makeChange({
      changeType: ChangeType.ADD_HOOK_CALL,
      target: 'App',
      location: 'function:App',
      contentAfter: 'useEffect(() => { init(); }, []);',
    });
    const ctx = makeContext(hookBaseline('function App() {'), [makeSnapshot('t1', [nested])], { location });
    const result = merger.merge(ctx, strategy);
    expect(result.mergedContent).toContain('useEffect(() => { init(); }, []);');
  });

  it('never reports AUTO_MERGED when the function is absent from the baseline', () => {
    const baseline = "import React from 'react';\n\nfunction Other() {\n  return null;\n}\n";
    const ctx = makeContext(baseline, [makeSnapshot('t1', [hookChange()])], { location });
    const result = merger.merge(ctx, strategy);
    expect(result.decision).not.toBe(MergeDecision.AUTO_MERGED);
  });
});

// =============================================================================
// Unmatched anchors -> FAILED naming the missing target
// =============================================================================

describe('unmatched anchors', () => {
  const missingFunctionBaseline = 'function Other() {\n  return null;\n}\n';

  for (const strategy of [MergeStrategy.HOOKS_FIRST, MergeStrategy.HOOKS_THEN_WRAP]) {
    it(`${strategy}: function absent from baseline -> FAILED naming the function`, () => {
      const ctx = makeContext(missingFunctionBaseline, [makeSnapshot('t1', [hookChange('App')])], {
        location: 'function:App',
      });
      const result = merger.merge(ctx, strategy);
      expect(result.decision).toBe(MergeDecision.FAILED);
      expect(`${result.error ?? ''} ${result.explanation}`).toContain('App');
    });

    it(`${strategy}: no hook extracted -> FAILED`, () => {
      const noHook = makeChange({
        changeType: ChangeType.ADD_HOOK_CALL,
        target: 'App',
        location: 'function:App',
        contentAfter: 'const x = 1;',
      });
      const ctx = makeContext(hookBaseline('function App() {'), [makeSnapshot('t1', [noHook])], {
        location: 'function:App',
      });
      const result = merger.merge(ctx, strategy);
      expect(result.decision).toBe(MergeDecision.FAILED);
      expect(`${result.error ?? ''} ${result.explanation}`).toMatch(/hook/i);
    });
  }

  it('ORDER_BY_DEPENDENCY: function absent from baseline -> FAILED naming the function', () => {
    const ctx = makeContext(missingFunctionBaseline, [makeSnapshot('t1', [hookChange('App')])], {
      location: 'function:App',
    });
    const result = merger.merge(ctx, MergeStrategy.ORDER_BY_DEPENDENCY);
    expect(result.decision).toBe(MergeDecision.FAILED);
    expect(`${result.error ?? ''} ${result.explanation}`).toContain('App');
  });

  it('APPEND_METHODS: class absent from baseline -> FAILED naming the class', () => {
    const method = makeChange({
      changeType: ChangeType.ADD_METHOD,
      target: 'Foo.bar',
      contentAfter: 'bar() {}',
    });
    const ctx = makeContext('class Other {\n}\n', [makeSnapshot('t1', [method])], {
      location: 'class:Foo',
    });
    const result = merger.merge(ctx, MergeStrategy.APPEND_METHODS);
    expect(result.decision).toBe(MergeDecision.FAILED);
    expect(`${result.error ?? ''} ${result.explanation}`).toContain('Foo');
  });
});

// =============================================================================
// HOOKS_THEN_WRAP wrapping
// =============================================================================

describe('HOOKS_THEN_WRAP wrapping', () => {
  it('adds hooks and wraps the returned JSX', () => {
    const baseline = [
      'function App() {',
      '  return (',
      '    <div className="x">hi</div>',
      '  );',
      '}',
      '',
    ].join('\n');
    const wrap = makeChange({
      changeType: ChangeType.WRAP_JSX,
      target: 'App',
      location: 'function:App',
      contentAfter: '<Provider store={store}>',
    });
    const ctx = makeContext(baseline, [makeSnapshot('t1', [hookChange(), wrap])], {
      location: 'function:App',
    });
    const result = merger.merge(ctx, MergeStrategy.HOOKS_THEN_WRAP);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).toContain(`function App() {\n  ${HOOK}`);
    expect(result.mergedContent).toContain('<Provider store={store}>');
    expect(result.mergedContent!.indexOf('<Provider')).toBeLessThan(result.mergedContent!.indexOf('<div'));
  });
});

// =============================================================================
// APPEND_FUNCTIONS
// =============================================================================

describe('APPEND_FUNCTIONS', () => {
  const addFn = (text: string) =>
    makeChange({ changeType: ChangeType.ADD_FUNCTION, target: 'fn', contentAfter: text });

  it('inserts before export default', () => {
    const baseline = 'function a() {}\n\nexport default a;\n';
    const ctx = makeContext(baseline, [makeSnapshot('t1', [addFn('function b() {}')])]);
    const result = merger.merge(ctx, MergeStrategy.APPEND_FUNCTIONS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    const merged = result.mergedContent!;
    expect(merged.indexOf('function b() {}')).toBeGreaterThan(merged.indexOf('function a() {}'));
    expect(merged.indexOf('function b() {}')).toBeLessThan(merged.indexOf('export default a;'));
  });

  it('inserts before module.exports', () => {
    const baseline = 'function a() {}\n\nmodule.exports = { a };\n';
    const ctx = makeContext(baseline, [makeSnapshot('t1', [addFn('function b() {}')])], {}, 'src/x.js');
    const result = merger.merge(ctx, MergeStrategy.APPEND_FUNCTIONS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    const merged = result.mergedContent!;
    expect(merged.indexOf('function b() {}')).toBeLessThan(merged.indexOf('module.exports'));
  });

  // Known bug: the insertion offset advances by the newline count of a multi-line function,
  // but each function is one array element, so later functions land after the export.
  it.fails('keeps the order of several multi-line functions before the export', () => {
    const baseline = 'function a() {}\nexport default a;\n';
    const ctx = makeContext(baseline, [
      makeSnapshot('t1', [addFn('function b() {\n  return 1;\n}')]),
      makeSnapshot('t2', [addFn('function c() {}')]),
    ]);
    const merged = merger.merge(ctx, MergeStrategy.APPEND_FUNCTIONS).mergedContent!;
    expect(merged.indexOf('function b')).toBeLessThan(merged.indexOf('function c'));
    expect(merged.indexOf('function c')).toBeLessThan(merged.indexOf('export default a;'));
  });

  it('appends at end of file when there is no export', () => {
    const baseline = 'function a() {}\n';
    const ctx = makeContext(baseline, [makeSnapshot('t1', [addFn('function b() {}')])]);
    const result = merger.merge(ctx, MergeStrategy.APPEND_FUNCTIONS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).toBe('function a() {}\n\n\nfunction b() {}');
  });
});

// =============================================================================
// APPEND_METHODS
// =============================================================================

interface ClassBaseline {
  name: string;
  opening: string;
  failsToday: boolean;
}

const CLASS_BASELINES: ClassBaseline[] = [
  { name: 'plain class', opening: 'class Foo {', failsToday: false },
  { name: 'generic class', opening: 'class Foo<T> {', failsToday: false },
  { name: 'extends', opening: 'class Foo extends Base {', failsToday: false },
  { name: 'extends generic base', opening: 'class Foo extends Base<T> {', failsToday: false },
  { name: 'implements', opening: 'class Foo implements Bar {', failsToday: false },
  {
    name: 'generics + extends + implements',
    opening: 'class Foo<T> extends Base<T> implements Bar, Baz {',
    failsToday: false,
  },
  { name: 'exported class', opening: 'export class Foo {', failsToday: false },
];

describe('APPEND_METHODS', () => {
  const method = 'newMethod() {\n    return 1;\n  }';
  const addMethod = makeChange({
    changeType: ChangeType.ADD_METHOD,
    target: 'Foo.newMethod',
    contentAfter: method,
  });

  for (const { name, opening, failsToday } of CLASS_BASELINES) {
    const run = failsToday ? it.fails : it;
    run(`inserts the method before the closing brace: ${name}`, () => {
      const baseline = `${opening}\n  existing() {\n    return 0;\n  }\n}\n\nconst after = 1;\n`;
      const ctx = makeContext(baseline, [makeSnapshot('t1', [addMethod])], { location: 'class:Foo' });
      const result = merger.merge(ctx, MergeStrategy.APPEND_METHODS);
      expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
      const merged = result.mergedContent!;
      const methodIdx = merged.indexOf('newMethod()');
      expect(methodIdx).toBeGreaterThan(merged.indexOf('existing()'));
      expect(methodIdx).toBeLessThan(merged.indexOf('const after = 1;'));
      // The class body closes right after the new method, before the trailing code.
      expect(merged).toMatch(/newMethod\(\) \{\n {4}return 1;\n {2}\}\s*\}\n\nconst after = 1;/);
    });
  }

  it('ignores braces inside strings, templates and comments when finding the class end', () => {
    const baseline = [
      'class Foo {',
      '  existing() {',
      "    const a = '}';",
      '    const b = "}";',
      '    const c = `}${1}`;',
      '    // }',
      '    /* } */',
      '    return a;',
      '  }',
      '}',
      '',
      'const after = 1;',
      '',
    ].join('\n');
    const ctx = makeContext(baseline, [makeSnapshot('t1', [addMethod])], { location: 'class:Foo' });
    const result = merger.merge(ctx, MergeStrategy.APPEND_METHODS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    const merged = result.mergedContent!;
    expect(merged.indexOf('newMethod()')).toBeGreaterThan(merged.indexOf('return a;'));
    expect(merged.indexOf('newMethod()')).toBeLessThan(merged.indexOf('const after = 1;'));
  });

  it('inserts into abstract and default-exported classes', () => {
    for (const opening of ['export abstract class Foo {', 'export default class Foo {']) {
      const ctx = makeContext(`${opening}\n}\n`, [makeSnapshot('t1', [addMethod])], { location: 'class:Foo' });
      const result = merger.merge(ctx, MergeStrategy.APPEND_METHODS);
      expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
      expect(result.mergedContent).toContain('newMethod()');
    }
  });

  it('fails when no ADD_METHOD change carries a class prefix', () => {
    const bare = makeChange({ changeType: ChangeType.ADD_METHOD, target: 'bar', contentAfter: 'bar() {}' });
    const ctx = makeContext('class Foo {\n}\n', [makeSnapshot('t1', [bare])]);
    const result = merger.merge(ctx, MergeStrategy.APPEND_METHODS);
    expect(result.decision).toBe(MergeDecision.FAILED);
    expect(result.mergedContent).toBeUndefined();
  });
});

// =============================================================================
// COMBINE_PROPS
// =============================================================================

describe('COMBINE_PROPS', () => {
  it('applies the last change of the last snapshot', () => {
    const baseline = 'const el = <Button a={1} />;\n';
    const change = makeChange({
      changeType: ChangeType.MODIFY_JSX_PROPS,
      contentBefore: '<Button a={1} />',
      contentAfter: '<Button a={1} b={2} />',
    });
    const ctx = makeContext(baseline, [makeSnapshot('t1', [change])]);
    const result = merger.merge(ctx, MergeStrategy.COMBINE_PROPS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).toBe('const el = <Button a={1} b={2} />;\n');
  });

  it('returns the baseline when there are no snapshots', () => {
    const ctx = makeContext('x\n', []);
    const result = merger.merge(ctx, MergeStrategy.COMBINE_PROPS);
    expect(result.mergedContent).toBe('x\n');
  });
});

// =============================================================================
// ORDER_BY_TIME
// =============================================================================

describe('ORDER_BY_TIME', () => {
  it('applies changes in chronological order regardless of snapshot order', () => {
    const early = makeSnapshot(
      'early',
      [makeChange({ changeType: ChangeType.MODIFY_VARIABLE, contentBefore: 'v = 1', contentAfter: 'v = 2' })],
      new Date('2025-01-01T00:00:00Z'),
    );
    const late = makeSnapshot(
      'late',
      [makeChange({ changeType: ChangeType.MODIFY_VARIABLE, contentBefore: 'v = 2', contentAfter: 'v = 3' })],
      new Date('2025-01-02T00:00:00Z'),
    );
    const result = merger.merge(makeContext('v = 1\n', [late, early]), MergeStrategy.ORDER_BY_TIME);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).toBe('v = 3\n');
  });
});

// =============================================================================
// ORDER_BY_DEPENDENCY ordering
// =============================================================================

describe('ORDER_BY_DEPENDENCY ordering', () => {
  it('applies hooks before wrapping', () => {
    const baseline = 'function App() {\n  return (\n    <div>hi</div>\n  );\n}\n';
    const wrap = makeChange({
      changeType: ChangeType.WRAP_JSX,
      target: 'App',
      contentAfter: '<Provider>',
    });
    const ctx = makeContext(baseline, [makeSnapshot('t1', [wrap, hookChange()])]);
    const result = merger.merge(ctx, MergeStrategy.ORDER_BY_DEPENDENCY);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).toContain(`function App() {\n  ${HOOK}`);
    expect(result.mergedContent).toContain('<Provider>');
  });
});

// =============================================================================
// APPEND_STATEMENTS
// =============================================================================

describe('APPEND_STATEMENTS', () => {
  it('appends additive changes after the baseline', () => {
    const ctx = makeContext('const a = 1;', [
      makeSnapshot('t1', [
        makeChange({ changeType: ChangeType.ADD_VARIABLE, contentAfter: 'const b = 2;' }),
      ]),
      makeSnapshot('t2', [
        makeChange({ changeType: ChangeType.ADD_CONSTANT, contentAfter: 'const c = 3;' }),
      ]),
    ]);
    const result = merger.merge(ctx, MergeStrategy.APPEND_STATEMENTS);
    expect(result.decision).toBe(MergeDecision.AUTO_MERGED);
    expect(result.mergedContent).toBe('const a = 1;\nconst b = 2;\nconst c = 3;');
  });
});
