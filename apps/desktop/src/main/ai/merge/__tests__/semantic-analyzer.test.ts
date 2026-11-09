import { describe, it, expect } from 'vitest';

import { analyzeWithRegex, SemanticAnalyzer } from '../semantic-analyzer';
import { ChangeType } from '../types';

const types = (r: ReturnType<typeof analyzeWithRegex>) => r.changes.map((c) => c.changeType);
const locations = (r: ReturnType<typeof analyzeWithRegex>) => r.changes.map((c) => c.location);

describe('analyzeWithRegex imports', () => {
  it.each(['a.ts', 'a.tsx', 'a.js'])('detects added import in %s', (file) => {
    const r = analyzeWithRegex(file, 'const a = 1;\n', "import x from 'x';\nconst a = 1;\n");
    expect(types(r)).toEqual([ChangeType.ADD_IMPORT]);
    expect(r.importsAdded.has("import x from 'x';")).toBe(true);
    expect(r.changes[0].location).toBe('file_top');
    expect(r.changes[0].lineStart).toBe(1);
  });

  it('detects removed import', () => {
    const r = analyzeWithRegex('a.ts', "import x from 'x';\nconst a = 1;\n", 'const a = 1;\n');
    expect(types(r)).toEqual([ChangeType.REMOVE_IMPORT]);
    expect(r.importsRemoved.has("import x from 'x';")).toBe(true);
  });

  it('detects python import and from-import', () => {
    const r = analyzeWithRegex('a.py', 'x = 1\n', 'import os\nfrom a import b\nx = 1\n');
    expect(types(r)).toEqual([ChangeType.ADD_IMPORT, ChangeType.ADD_IMPORT]);
    expect(r.importsAdded.size).toBe(2);
  });

  it('removes python import', () => {
    const r = analyzeWithRegex('a.py', 'import os\nx = 1\n', 'x = 1\n');
    expect(types(r)).toEqual([ChangeType.REMOVE_IMPORT]);
  });

  it('produces no import changes for unsupported extension', () => {
    const r = analyzeWithRegex('README.md', '# t\n', "import x from 'x'\n# t\n");
    expect(r.changes).toEqual([]);
    expect(r.importsAdded.size).toBe(0);
    expect(r.totalLinesChanged).toBe(1);
  });
});

describe('analyzeWithRegex functions', () => {
  it('detects added function declaration', () => {
    const r = analyzeWithRegex('a.ts', '', 'function foo() {\n}\n');
    expect(types(r)).toEqual([ChangeType.ADD_FUNCTION]);
    expect(r.changes[0].location).toBe('function:foo');
    expect(r.functionsAdded.has('foo')).toBe(true);
  });

  it('detects added arrow and typed arrow functions', () => {
    const r = analyzeWithRegex('a.ts', '', 'const a = () => {\n};\nconst b: Fn = () => {\n};\n');
    expect(locations(r).sort()).toEqual(['function:a', 'function:b']);
  });

  it('detects added async arrow', () => {
    const r = analyzeWithRegex('a.js', '', 'const g = async (x) => {\n};\n');
    expect(locations(r)).toEqual(['function:g']);
  });

  it('detects python def', () => {
    const r = analyzeWithRegex('a.py', '', 'def hello(x):\n    return x\n');
    expect(types(r)).toEqual([ChangeType.ADD_FUNCTION]);
    expect(r.changes[0].target).toBe('hello');
  });

  it('detects removed function', () => {
    const r = analyzeWithRegex('a.ts', 'function foo() {\n}\n', '');
    expect(types(r)).toEqual([ChangeType.REMOVE_FUNCTION]);
    expect(r.functionsAdded.size).toBe(0);
  });

  it('detects modified function when the signature changes', () => {
    const r = analyzeWithRegex('a.ts', 'const f = () => {\n  1;\n};\n', 'const f = async () => {\n  1;\n};\n');
    expect(types(r)).toEqual([ChangeType.MODIFY_FUNCTION]);
    expect(r.functionsModified.has('f')).toBe(true);
  });
});

describe('analyzeWithRegex function modification classification', () => {
  // extractFunctionBody returns only the matched signature, so classification
  // only sees signature text. These tests drive it through signatures.
  // Hook calls need "(" after the name, but the arrow signature pattern stops at the
  // first ")", so ADD_HOOK_CALL / REMOVE_HOOK_CALL cannot be produced from a signature.
  it('cannot reach ADD_HOOK_CALL or REMOVE_HOOK_CALL through the public API', () => {
    const r = analyzeWithRegex('a.tsx', 'const f = (a) => {\n};\n', 'const f = (a = useFoo()) => {\n};\n');
    expect(types(r)).not.toContain(ChangeType.ADD_HOOK_CALL);
    expect(types(r)).not.toContain(ChangeType.REMOVE_HOOK_CALL);
  });

  it('classifies WRAP_JSX when signature text gains a component tag', () => {
    const r = analyzeWithRegex('a.tsx', 'const f = (a) => {\n};\n', 'const f = (a = <Foo) => {\n};\n');
    expect(types(r)).toEqual([ChangeType.WRAP_JSX]);
  });

  it('classifies UNWRAP_JSX when signature text loses a component tag', () => {
    const r = analyzeWithRegex('a.tsx', 'const f = (a = <Foo) => {\n};\n', 'const f = (a) => {\n};\n');
    expect(types(r)).toEqual([ChangeType.UNWRAP_JSX]);
  });

  it('classifies MODIFY_JSX_PROPS on .tsx when only quoted values change', () => {
    const r = analyzeWithRegex('a.tsx', 'const f = (a="x") => {\n};\n', 'const f = (a="y") => {\n};\n');
    expect(types(r)).toEqual([ChangeType.MODIFY_JSX_PROPS]);
  });

  it('classifies the same prop change as MODIFY_FUNCTION on .ts', () => {
    const r = analyzeWithRegex('a.ts', 'const f = (a="x") => {\n};\n', 'const f = (a="y") => {\n};\n');
    expect(types(r)).toEqual([ChangeType.MODIFY_FUNCTION]);
  });

  it('classifies as MODIFY_FUNCTION when signature differs without hooks/JSX', () => {
    const r = analyzeWithRegex('a.tsx', 'const f = (a) => {\n};\n', 'const f = (a, b) => {\n};\n');
    expect(types(r)).toEqual([ChangeType.MODIFY_FUNCTION]);
  });

  it('records the signature-only body as contentBefore/contentAfter', () => {
    const r = analyzeWithRegex('a.ts', 'const f = (a) => {\n};\n', 'const f = (a, b) => {\n};\n');
    expect(r.changes[0].contentBefore).toBe('const f = (a) => {');
    expect(r.changes[0].contentAfter).toBe('const f = (a, b) => {');
  });
});

describe('extractFunctionBody gap (signature only)', () => {
  it('emits nothing when only the body changes, even if a hook is added', () => {
    const before = 'function App() {\n  return 1;\n}\n';
    const after = 'function App() {\n  const a = useState(0);\n  return 1;\n}\n';
    const r = analyzeWithRegex('a.tsx', before, after);
    expect(r.changes).toEqual([]);
    expect(r.functionsModified.size).toBe(0);
    expect(r.totalLinesChanged).toBe(1);
  });

  it('never detects modification of `function name(...) {` declarations (body pattern needs "{" right after the name)', () => {
    const r = analyzeWithRegex('a.ts', 'function f(a) {\n}\n', 'function f(a, b) {\n}\n');
    expect(r.changes).toEqual([]);
  });

  it('never yields contentAfter containing a hook call for existing functions', () => {
    const r = analyzeWithRegex(
      'a.tsx',
      'function App() {\n}\n',
      'function App(props) {\n  useThing();\n}\n',
    );
    for (const c of r.changes) expect(c.contentAfter ?? '').not.toMatch(/useThing/);
  });
});

describe('signature forms from the merge fix', () => {
  const cases: Array<[string, string, string | null]> = [
    ['function App(): JSX.Element {', 'a.tsx', 'function:App'],
    ['const App: FC = () => {', 'a.tsx', 'function:App'],
    ['function App({ onClick = () => {} }) {', 'a.tsx', 'function:App'],
    // Known gaps: not matched by the analyzer. A miss emits no change, so the
    // merge sees nothing to apply rather than a wrong change.
    ['const App: FC<Props> = () => {', 'a.tsx', null],
    ['class Foo<T> {', 'a.ts', null],
    ['const f = <T,>(x: T) => {', 'a.tsx', null],
  ];
  it.each(cases)('%s', (sig, file, expected) => {
    const r = analyzeWithRegex(file, '', `${sig}\n}\n`);
    expect(locations(r)).toEqual(expected ? [expected] : []);
  });
});

describe('input handling', () => {
  it('normalises CRLF so identical content yields no changes', () => {
    const lf = "import x from 'x';\nconst a = 1;\n";
    const r = analyzeWithRegex('a.ts', lf, lf.replace(/\n/g, '\r\n'));
    expect(r.changes).toEqual([]);
    expect(r.totalLinesChanged).toBe(0);
  });

  it('does not leave carriage returns in import targets', () => {
    const r = analyzeWithRegex('a.ts', '', "import x from 'x';\r\nconst a = 1;\r\n");
    expect(r.changes[0].target).toBe("import x from 'x';");
    expect(r.changes[0].contentAfter).not.toContain('\r');
  });

  it('handles empty before and after', () => {
    const r = analyzeWithRegex('a.ts', '', '');
    expect(r.changes).toEqual([]);
    expect(r.totalLinesChanged).toBe(0);
  });

  it('counts added and removed lines in totalLinesChanged', () => {
    const r = analyzeWithRegex('a.ts', 'a\nb\nc\n', 'a\nB\nc\nd\n');
    // removed: b ; added: B, d (trailing empty line equal)
    expect(r.totalLinesChanged).toBe(3);
  });

  it('keeps the file path on the analysis', () => {
    expect(analyzeWithRegex('src/x.ts', '', '').filePath).toBe('src/x.ts');
  });
});

describe('SemanticAnalyzer', () => {
  const analyzer = new SemanticAnalyzer();

  it('analyzeDiff delegates to analyzeWithRegex', () => {
    const r = analyzer.analyzeDiff('a.ts', '', "import x from 'x';\n");
    expect(types(r)).toEqual([ChangeType.ADD_IMPORT]);
  });

  it('analyzeFile treats the content as all-added', () => {
    const r = analyzer.analyzeFile('a.py', "import os\ndef run():\n    pass\n");
    expect(r.importsAdded.has('import os')).toBe(true);
    expect(r.functionsAdded.has('run')).toBe(true);
  });
});
