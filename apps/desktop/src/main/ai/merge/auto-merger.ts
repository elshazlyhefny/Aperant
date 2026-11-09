/**
 * Auto Merger
 * ===========
 *
 * Deterministic merge strategies without AI.
 * See apps/desktop/src/main/ai/merge/auto-merger.ts for the TypeScript implementation.
 *
 * Implements 9 merge strategies:
 * 1. COMBINE_IMPORTS — merge import statements
 * 2. HOOKS_FIRST — add hooks at function start
 * 3. HOOKS_THEN_WRAP — hooks first then JSX wrapping
 * 4. APPEND_FUNCTIONS — append new functions to file
 * 5. APPEND_METHODS — add new methods to class
 * 6. COMBINE_PROPS — merge JSX/object props
 * 7. ORDER_BY_DEPENDENCY — topological ordering
 * 8. ORDER_BY_TIME — chronological ordering
 * 9. APPEND_STATEMENTS — append additive statements to end of file
 *
 * Strategies that must locate an anchor (function or class) return FAILED when
 * it cannot be found, rather than reporting AUTO_MERGED with unchanged content.
 */

import path from 'path';
import {
  ChangeType,
  MergeDecision,
  MergeStrategy,
  type ConflictRegion,
  type MergeResult,
  type SemanticChange,
  type TaskSnapshot,
  isAdditiveChange,
} from './types';

// =============================================================================
// Merge Context
// =============================================================================

export interface MergeContext {
  filePath: string;
  baselineContent: string;
  taskSnapshots: TaskSnapshot[];
  conflict: ConflictRegion;
}

// =============================================================================
// Helpers
// =============================================================================

function getExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function isImportLine(line: string, ext: string): boolean {
  if (ext === '.py') return line.startsWith('import ') || line.startsWith('from ');
  if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
    return line.startsWith('import ') || line.startsWith('export ');
  }
  return false;
}

function findImportSectionEnd(lines: string[], ext: string): number {
  let lastImportLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (isImportLine(stripped, ext)) {
      lastImportLine = i + 1;
    } else if (
      stripped &&
      !stripped.startsWith('#') &&
      !stripped.startsWith('//')
    ) {
      if (lastImportLine > 0) break;
    }
  }

  return lastImportLine > 0 ? lastImportLine : 0;
}

function findFunctionInsertPosition(content: string): number | null {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('module.exports') || line.startsWith('export default')) {
      return i;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Source scanning helpers
//
// Small hand-written walkers are used instead of regexes with nested quantifiers
// so that user content can never trigger catastrophic backtracking, and so that
// strings, template literals and comments are skipped while counting brackets.
// -----------------------------------------------------------------------------

/** If a string, template literal or comment starts at `i`, return the index just after it; otherwise `i`. */
function skipNonCode(content: string, i: number): number {
  const ch = content[i];
  const next = content[i + 1];

  if (ch === '/' && next === '/') {
    const eol = content.indexOf('\n', i);
    return eol === -1 ? content.length : eol;
  }
  if (ch === '/' && next === '*') {
    const end = content.indexOf('*/', i + 2);
    return end === -1 ? content.length : end + 2;
  }
  if (ch === '"' || ch === "'") {
    let pos = i + 1;
    while (pos < content.length) {
      const c = content[pos];
      if (c === '\\') pos += 2;
      else if (c === ch) return pos + 1;
      else if (c === '\n') return pos;
      else pos++;
    }
    return content.length;
  }
  if (ch === '`') return skipTemplate(content, i);
  return i;
}

function skipTemplate(content: string, start: number): number {
  let pos = start + 1;
  while (pos < content.length) {
    const c = content[pos];
    if (c === '\\') {
      pos += 2;
    } else if (c === '`') {
      return pos + 1;
    } else if (c === '$' && content[pos + 1] === '{') {
      pos = findMatchingBrace(content, pos + 1) ?? content.length;
      if (pos < content.length) pos++;
    } else {
      pos++;
    }
  }
  return content.length;
}

/** Index of the `}` matching the `{` at `openIdx`, ignoring strings, templates and comments. */
function findMatchingBrace(content: string, openIdx: number): number | null {
  let depth = 0;
  let pos = openIdx;
  while (pos < content.length) {
    const skipped = skipNonCode(content, pos);
    if (skipped !== pos) {
      pos = skipped;
      continue;
    }
    const c = content[pos];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return pos;
    }
    pos++;
  }
  return null;
}

/** Index just after the group closed by the bracket matching `content[openIdx]` (one of `(`, `[`, `<`, `{`). */
function skipBalanced(content: string, openIdx: number): number | null {
  const open = content[openIdx];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '<' ? '>' : '}';
  let depth = 0;
  let pos = openIdx;
  while (pos < content.length) {
    const skipped = skipNonCode(content, pos);
    if (skipped !== pos) {
      pos = skipped;
      continue;
    }
    const c = content[pos];
    if (c === '=' && content[pos + 1] === '>') {
      pos += 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return pos + 1;
    }
    pos++;
  }
  return null;
}

function skipWhitespace(content: string, i: number): number {
  let pos = i;
  while (pos < content.length) {
    const skipped = skipNonCode(content, pos);
    if (skipped !== pos && content[pos] === '/') {
      pos = skipped;
    } else if (/\s/.test(content[pos])) {
      pos++;
    } else {
      break;
    }
  }
  return pos;
}

type ScanStop = 'brace' | 'arrow' | 'equals';

/**
 * Walk forward from `from` at bracket depth 0 (over `()`, `[]`, `<>`, `{}`) until one of the
 * `stops` is reached. Returns the index of the stop token, or null on `;` / end of input.
 */
function scanToToken(content: string, from: number, stops: ScanStop[]): number | null {
  let depth = 0;
  let pos = from;
  while (pos < content.length) {
    const skipped = skipNonCode(content, pos);
    if (skipped !== pos) {
      pos = skipped;
      continue;
    }
    const c = content[pos];
    if (c === '=' && content[pos + 1] === '>') {
      if (depth === 0 && stops.includes('arrow')) return pos;
      pos += 2;
      continue;
    }
    if (depth === 0) {
      if (c === ';') return null;
      if (c === '{' && stops.includes('brace')) return pos;
      if (c === '=' && stops.includes('equals') && content[pos + 1] !== '=') return pos;
    }
    if (c === '(' || c === '[' || c === '<' || c === '{') {
      const end = skipBalanced(content, pos);
      if (end === null) return null;
      pos = end;
      continue;
    }
    pos++;
  }
  return null;
}

/** Index of the `{` that opens a function body, starting right after the name. */
function findFunctionBodyBrace(content: string, afterName: number): number | null {
  return scanToToken(content, afterName, ['brace']);
}

/** Index of the `{` opening an arrow function's block body, starting after `=`. */
function findArrowBodyBrace(content: string, afterEquals: number): number | null {
  let pos = skipWhitespace(content, afterEquals);
  if (/^async\b/.test(content.slice(pos, pos + 6))) pos = skipWhitespace(content, pos + 5);
  if (/^function\b/.test(content.slice(pos, pos + 9))) {
    return findFunctionBodyBrace(content, pos + 8);
  }
  const arrow = scanToToken(content, pos, ['arrow']);
  if (arrow === null) return null;
  const body = skipWhitespace(content, arrow + 2);
  return content[body] === '{' ? body : null;
}

/** Position just after the `{` that opens the body of function `funcName`, or null. */
function findFunctionBodyStart(content: string, funcName: string): number | null {
  const name = escapeRegex(funcName);

  const declaration = new RegExp(`(?<![\\w$.])function\\s*\\*?\\s*${name}(?![\\w$])`, 'g');
  for (const m of content.matchAll(declaration)) {
    const brace = findFunctionBodyBrace(content, m.index + m[0].length);
    if (brace !== null) return brace + 1;
  }

  const variable = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${name}(?![\\w$])`, 'g');
  for (const m of content.matchAll(variable)) {
    const equals = scanToToken(content, m.index + m[0].length, ['equals']);
    if (equals === null) continue;
    const brace = findArrowBodyBrace(content, equals + 1);
    if (brace !== null) return brace + 1;
  }

  return null;
}

/** Position of the closing `}` of class `className`'s body, or null. */
function findClassBodyEnd(content: string, className: string): number | null {
  const declaration = new RegExp(`(?<![\\w$.])class\\s+${escapeRegex(className)}(?![\\w$])`, 'g');
  for (const m of content.matchAll(declaration)) {
    const brace = scanToToken(content, m.index + m[0].length, ['brace']);
    if (brace === null) continue;
    const close = findMatchingBrace(content, brace);
    if (close !== null) return close;
  }
  return null;
}

/** Returns null when the class is not found or its braces are unbalanced. */
function insertMethodsIntoClass(content: string, className: string, methods: string[]): string | null {
  const insertPos = findClassBodyEnd(content, className);
  if (insertPos === null) return null;
  const methodText = '\n\n  ' + methods.join('\n\n  ');
  return content.slice(0, insertPos) + methodText + content.slice(insertPos);
}

/** Returns null when the function signature is not found. */
function insertHooksIntoFunction(content: string, funcName: string, hooks: string[]): string | null {
  const insertPos = findFunctionBodyStart(content, funcName);
  if (insertPos === null) return null;
  const hookText = '\n  ' + hooks.join('\n  ');
  return content.slice(0, insertPos) + hookText + content.slice(insertPos);
}

/** Returns null when no `return (<jsx>` was found to wrap. */
function wrapFunctionReturn(
  content: string,
  _funcName: string,
  wrapperName: string,
  wrapperProps: string,
): string | null {
  const returnPattern = /(return\s*\(\s*)(<[^>]+>)/;

  if (!returnPattern.test(content)) return null;

  return content.replace(returnPattern, (_match, returnStart, jsxStart) => {
    const props = wrapperProps ? ` ${wrapperProps}` : '';
    return `${returnStart}<${wrapperName}${props}>\n      ${jsxStart}`;
  });
}

function failedResult(context: MergeContext, message: string): MergeResult {
  return {
    decision: MergeDecision.FAILED,
    filePath: context.filePath,
    conflictsResolved: [],
    conflictsRemaining: [context.conflict],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: message,
    error: message,
  };
}

function extractHookCall(change: SemanticChange): string | null {
  if (!change.contentAfter) return null;

  const patterns = [
    /(const\s+\{[^}]+\}\s*=\s*)?use\w+\([^)]*\);?/,
    /use\w+\([^)]*\);?/,
  ];

  for (const pattern of patterns) {
    const match = change.contentAfter.match(pattern);
    if (match) return match[0];
  }

  return null;
}

function extractJsxWrapper(change: SemanticChange): [string, string] | null {
  if (!change.contentAfter) return null;
  const match = change.contentAfter.match(/<(\w+)([^>]*)>/);
  if (match) return [match[1], match[2].trim()];
  return null;
}

function extractNewProps(change: SemanticChange): Array<[string, string]> {
  const props: Array<[string, string]> = [];
  if (change.contentAfter && change.contentBefore) {
    const afterProps = [...change.contentAfter.matchAll(/(\w+)=\{([^}]+)\}/g)].map((m) => [m[1], m[2]] as [string, string]);
    const beforeProps = new Map(
      [...change.contentBefore.matchAll(/(\w+)=\{([^}]+)\}/g)].map((m) => [m[1], m[2]]),
    );
    for (const [name, value] of afterProps) {
      if (!beforeProps.has(name)) {
        props.push([name, value]);
      }
    }
  }
  return props;
}

function applyContentChange(content: string, oldContent: string | undefined, newContent: string): string {
  if (oldContent && content.includes(oldContent)) {
    return content.replace(oldContent, newContent);
  }
  return content;
}

function topologicalSortChanges(snapshots: TaskSnapshot[]): SemanticChange[] {
  const allChanges: SemanticChange[] = [];
  for (const snapshot of snapshots) {
    allChanges.push(...snapshot.semanticChanges);
  }

  const priority: Partial<Record<ChangeType, number>> = {
    [ChangeType.ADD_IMPORT]: 0,
    [ChangeType.ADD_HOOK_CALL]: 1,
    [ChangeType.ADD_VARIABLE]: 2,
    [ChangeType.ADD_CONSTANT]: 2,
    [ChangeType.WRAP_JSX]: 3,
    [ChangeType.ADD_JSX_ELEMENT]: 4,
    [ChangeType.MODIFY_FUNCTION]: 5,
    [ChangeType.MODIFY_JSX_PROPS]: 5,
  };

  return allChanges.sort((a, b) => (priority[a.changeType] ?? 10) - (priority[b.changeType] ?? 10));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// Strategy implementations
// =============================================================================

function executeImportStrategy(context: MergeContext): MergeResult {
  const lines = context.baselineContent.split(/\r?\n/);
  const ext = getExtension(context.filePath);

  const importsToAdd: string[] = [];
  const importsToRemove = new Set<string>();

  for (const snapshot of context.taskSnapshots) {
    for (const change of snapshot.semanticChanges) {
      if (change.changeType === ChangeType.ADD_IMPORT && change.contentAfter) {
        importsToAdd.push(change.contentAfter.trim());
      } else if (change.changeType === ChangeType.REMOVE_IMPORT && change.contentBefore) {
        importsToRemove.add(change.contentBefore.trim());
      }
    }
  }

  const importEndLine = findImportSectionEnd(lines, ext);

  const existingImports = new Set<string>();
  for (let i = 0; i < importEndLine; i++) {
    const stripped = lines[i].trim();
    if (isImportLine(stripped, ext)) existingImports.add(stripped);
  }

  const seen = new Set<string>();
  const newImports: string[] = [];
  for (const imp of importsToAdd) {
    if (!existingImports.has(imp) && !importsToRemove.has(imp) && !seen.has(imp)) {
      newImports.push(imp);
      seen.add(imp);
    }
  }

  // Remove imports that should be removed
  const resultLines = lines.filter((line) => !importsToRemove.has(line.trim()));

  if (newImports.length > 0) {
    const insertPos = findImportSectionEnd(resultLines, ext);
    for (let i = newImports.length - 1; i >= 0; i--) {
      resultLines.splice(insertPos, 0, newImports[i]);
    }
  }

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: resultLines.join('\n'),
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Combined ${newImports.length} imports from ${context.taskSnapshots.length} tasks`,
  };
}

function executeHooksStrategy(context: MergeContext): MergeResult {
  let content = context.baselineContent;
  const hooks: string[] = [];

  for (const snapshot of context.taskSnapshots) {
    for (const change of snapshot.semanticChanges) {
      if (change.changeType === ChangeType.ADD_HOOK_CALL) {
        const hookContent = extractHookCall(change);
        if (hookContent) hooks.push(hookContent);
      }
    }
  }

  if (hooks.length === 0) {
    return failedResult(context, 'No hook call could be extracted from the changes; nothing to insert');
  }

  const funcLocation = context.conflict.location;
  const funcName = funcLocation.startsWith('function:') ? funcLocation.split(':')[1] : '';
  if (!funcName) {
    return failedResult(
      context,
      `Cannot insert hooks: location "${funcLocation}" is not a function location`,
    );
  }
  const inserted = insertHooksIntoFunction(content, funcName, hooks);
  if (inserted === null) {
    return failedResult(context, `Could not find function "${funcName}" to insert hooks into`);
  }
  content = inserted;

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Added ${hooks.length} hooks to function start`,
  };
}

function executeHooksThenWrapStrategy(context: MergeContext): MergeResult {
  let content = context.baselineContent;
  const hooks: string[] = [];
  const wraps: Array<[string, string]> = [];

  for (const snapshot of context.taskSnapshots) {
    for (const change of snapshot.semanticChanges) {
      if (change.changeType === ChangeType.ADD_HOOK_CALL) {
        const hookContent = extractHookCall(change);
        if (hookContent) hooks.push(hookContent);
      } else if (change.changeType === ChangeType.WRAP_JSX) {
        const wrapper = extractJsxWrapper(change);
        if (wrapper) wraps.push(wrapper);
      }
    }
  }

  if (hooks.length === 0 && wraps.length === 0) {
    return failedResult(context, 'No hook call or JSX wrapper could be extracted from the changes');
  }

  const funcLocation = context.conflict.location;
  const funcName = funcLocation.startsWith('function:') ? funcLocation.split(':')[1] : '';
  if (!funcName) {
    return failedResult(
      context,
      `Cannot apply hooks and wrappers: location "${funcLocation}" is not a function location`,
    );
  }
  if (hooks.length > 0) {
    const inserted = insertHooksIntoFunction(content, funcName, hooks);
    if (inserted === null) {
      return failedResult(context, `Could not find function "${funcName}" to insert hooks into`);
    }
    content = inserted;
  }
  for (const [wrapperName, wrapperProps] of wraps) {
    const wrapped = wrapFunctionReturn(content, funcName, wrapperName, wrapperProps);
    if (wrapped === null) {
      return failedResult(
        context,
        `Could not apply JSX wrapper <${wrapperName}> in function "${funcName}": no return statement with JSX found`,
      );
    }
    content = wrapped;
  }

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Added ${hooks.length} hooks and ${wraps.length} JSX wrappers`,
  };
}

function executeAppendFunctionsStrategy(context: MergeContext): MergeResult {
  let content = context.baselineContent;
  const newFunctions: string[] = [];

  for (const snapshot of context.taskSnapshots) {
    for (const change of snapshot.semanticChanges) {
      if (change.changeType === ChangeType.ADD_FUNCTION && change.contentAfter) {
        newFunctions.push(change.contentAfter);
      }
    }
  }

  const insertPos = findFunctionInsertPosition(content);

  if (insertPos !== null) {
    const lines = content.split(/\r?\n/);
    let offset = insertPos;
    for (const func of newFunctions) {
      lines.splice(offset, 0, '');
      lines.splice(offset + 1, 0, func);
      offset += 2 + (func.match(/\n/g) ?? []).length;
    }
    content = lines.join('\n');
  } else {
    for (const func of newFunctions) {
      content += `\n\n${func}`;
    }
  }

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Appended ${newFunctions.length} new functions`,
  };
}

function executeAppendMethodsStrategy(context: MergeContext): MergeResult {
  let content = context.baselineContent;
  const newMethods: Map<string, string[]> = new Map();

  for (const snapshot of context.taskSnapshots) {
    for (const change of snapshot.semanticChanges) {
      if (change.changeType === ChangeType.ADD_METHOD && change.contentAfter) {
        const className = change.target.includes('.') ? change.target.split('.')[0] : null;
        if (className) {
          if (!newMethods.has(className)) newMethods.set(className, []);
          newMethods.get(className)!.push(change.contentAfter);
        }
      }
    }
  }

  if (newMethods.size === 0) {
    return failedResult(context, 'No ADD_METHOD change carried a "Class.method" target; nothing to insert');
  }

  for (const [className, methods] of newMethods) {
    const inserted = insertMethodsIntoClass(content, className, methods);
    if (inserted === null) {
      return failedResult(context, `Could not find class "${className}" to add methods to`);
    }
    content = inserted;
  }

  const totalMethods = [...newMethods.values()].reduce((sum, methods) => sum + methods.length, 0);
  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Added ${totalMethods} methods to ${newMethods.size} classes`,
  };
}

function executeCombinePropsStrategy(context: MergeContext): MergeResult {
  let content = context.baselineContent;

  if (context.taskSnapshots.length > 0) {
    const lastSnapshot = context.taskSnapshots[context.taskSnapshots.length - 1];
    if (lastSnapshot.semanticChanges.length > 0) {
      const lastChange = lastSnapshot.semanticChanges[lastSnapshot.semanticChanges.length - 1];
      if (lastChange.contentAfter) {
        content = applyContentChange(content, lastChange.contentBefore, lastChange.contentAfter);
      }
    }
  }

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Combined props from ${context.taskSnapshots.length} tasks`,
  };
}

function executeOrderByDependencyStrategy(context: MergeContext): MergeResult {
  const orderedChanges = topologicalSortChanges(context.taskSnapshots);
  let content = context.baselineContent;

  for (const change of orderedChanges) {
    if (change.contentAfter) {
      if (change.changeType === ChangeType.ADD_HOOK_CALL) {
        const funcName = change.target.includes('.') ? change.target.split('.').pop()! : change.target;
        const hookCall = extractHookCall(change);
        if (!hookCall) {
          return failedResult(context, `No hook call could be extracted for "${funcName}"`);
        }
        const inserted = insertHooksIntoFunction(content, funcName, [hookCall]);
        if (inserted === null) {
          return failedResult(context, `Could not find function "${funcName}" to insert hooks into`);
        }
        content = inserted;
      } else if (change.changeType === ChangeType.WRAP_JSX) {
        const wrapper = extractJsxWrapper(change);
        if (wrapper) {
          const funcName = change.target.includes('.') ? change.target.split('.').pop()! : change.target;
          const wrapped = wrapFunctionReturn(content, funcName, wrapper[0], wrapper[1]);
          if (wrapped === null) {
            return failedResult(
              context,
              `Could not apply JSX wrapper <${wrapper[0]}> in function "${funcName}": no return statement with JSX found`,
            );
          }
          content = wrapped;
        }
      }
    }
  }

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: 'Changes applied in dependency order',
  };
}

function executeOrderByTimeStrategy(context: MergeContext): MergeResult {
  const sortedSnapshots = [...context.taskSnapshots].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );

  let content = context.baselineContent;

  for (const snapshot of sortedSnapshots) {
    for (const change of snapshot.semanticChanges) {
      if (change.contentBefore && change.contentAfter) {
        content = applyContentChange(content, change.contentBefore, change.contentAfter);
      }
    }
  }

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Applied ${sortedSnapshots.length} changes in chronological order`,
  };
}

function executeAppendStatementsStrategy(context: MergeContext): MergeResult {
  let content = context.baselineContent;
  const additions: string[] = [];

  for (const snapshot of context.taskSnapshots) {
    for (const change of snapshot.semanticChanges) {
      if (isAdditiveChange(change) && change.contentAfter) {
        additions.push(change.contentAfter);
      }
    }
  }

  for (const addition of additions) {
    content += `\n${addition}`;
  }

  return {
    decision: MergeDecision.AUTO_MERGED,
    filePath: context.filePath,
    mergedContent: content,
    conflictsResolved: [context.conflict],
    conflictsRemaining: [],
    aiCallsMade: 0,
    tokensUsed: 0,
    explanation: `Appended ${additions.length} statements`,
  };
}

// =============================================================================
// AutoMerger class
// =============================================================================

type StrategyHandler = (context: MergeContext) => MergeResult;

/**
 * Performs deterministic merges without AI.
 *
 * Implements multiple merge strategies that can be applied
 * when the ConflictDetector determines changes are compatible.
 */
export class AutoMerger {
  private readonly strategyHandlers: Map<MergeStrategy, StrategyHandler>;

  constructor() {
    this.strategyHandlers = new Map([
      [MergeStrategy.COMBINE_IMPORTS, executeImportStrategy],
      [MergeStrategy.HOOKS_FIRST, executeHooksStrategy],
      [MergeStrategy.HOOKS_THEN_WRAP, executeHooksThenWrapStrategy],
      [MergeStrategy.APPEND_FUNCTIONS, executeAppendFunctionsStrategy],
      [MergeStrategy.APPEND_METHODS, executeAppendMethodsStrategy],
      [MergeStrategy.COMBINE_PROPS, executeCombinePropsStrategy],
      [MergeStrategy.ORDER_BY_DEPENDENCY, executeOrderByDependencyStrategy],
      [MergeStrategy.ORDER_BY_TIME, executeOrderByTimeStrategy],
      [MergeStrategy.APPEND_STATEMENTS, executeAppendStatementsStrategy],
    ]);
  }

  /**
   * Perform a merge using the specified strategy.
   */
  merge(context: MergeContext, strategy: MergeStrategy): MergeResult {
    const handler = this.strategyHandlers.get(strategy);

    if (!handler) {
      return {
        decision: MergeDecision.FAILED,
        filePath: context.filePath,
        conflictsResolved: [],
        conflictsRemaining: [],
        aiCallsMade: 0,
        tokensUsed: 0,
        explanation: '',
        error: `No handler for strategy: ${strategy}`,
      };
    }

    try {
      return handler(context);
    } catch (err) {
      return {
        decision: MergeDecision.FAILED,
        filePath: context.filePath,
        conflictsResolved: [],
        conflictsRemaining: [],
        aiCallsMade: 0,
        tokensUsed: 0,
        explanation: '',
        error: `Auto-merge failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  canHandle(strategy: MergeStrategy): boolean {
    return this.strategyHandlers.has(strategy);
  }
}
