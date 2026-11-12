import { describe, it, expect, vi, beforeEach } from 'vitest';

import { editTool } from '../edit';
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs');
vi.mock('../../../security/path-containment', () => ({
  assertPathContained: vi.fn((_filePath: string, _projectDir: string) => ({
    contained: true,
    resolvedPath: _filePath,
  })),
}));

import * as fs from 'node:fs';
import { assertPathContained } from '../../../security/path-containment';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext: ToolContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/specs/001',
  securityProfile: {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  },
} as unknown as ToolContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Edit Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertPathContained).mockImplementation((_filePath: string, _projectDir: string) => ({
      contained: true,
      resolvedPath: _filePath,
    }));
  });

  it('should have correct metadata', () => {
    expect(editTool.metadata.name).toBe('Edit');
    expect(editTool.metadata.permission).toBe('requires_approval');
  });

  it('should successfully replace a single occurrence', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('hello world foo bar');
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

    const result = await editTool.config.execute(
      {
        file_path: '/test/project/file.ts',
        old_string: 'hello world',
        new_string: 'goodbye world',
        replace_all: false,
      },
      baseContext,
    );

    expect(result).toContain('Successfully edited');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/test/project/file.ts',
      'goodbye world foo bar',
      'utf-8',
    );
  });

  it('should replace all occurrences when replace_all is true', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('foo bar foo baz foo');
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

    const result = await editTool.config.execute(
      {
        file_path: '/test/project/file.ts',
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true,
      },
      baseContext,
    );

    expect(result).toContain('Successfully replaced 3 occurrence(s)');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/test/project/file.ts',
      'qux bar qux baz qux',
      'utf-8',
    );
  });

  it('should return error when old_string not found in file', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('some other content');

    const result = await editTool.config.execute(
      {
        file_path: '/test/project/file.ts',
        old_string: 'nonexistent text',
        new_string: 'replacement',
        replace_all: false,
      },
      baseContext,
    );

    expect(result).toContain('Error: old_string not found');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should return error when old_string matches multiple locations without replace_all', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('foo foo foo');

    const result = await editTool.config.execute(
      {
        file_path: '/test/project/file.ts',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: false,
      },
      baseContext,
    );

    expect(result).toContain('Error: old_string appears 3 times');
    expect(result).toContain('replace_all: true');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should return error when old_string equals new_string', async () => {
    const result = await editTool.config.execute(
      {
        file_path: '/test/project/file.ts',
        old_string: 'same text',
        new_string: 'same text',
        replace_all: false,
      },
      baseContext,
    );

    expect(result).toContain('Error: old_string and new_string are identical');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should return error when file not found', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw enoentError; });

    const result = await editTool.config.execute(
      {
        file_path: '/test/project/missing.ts',
        old_string: 'old',
        new_string: 'new',
        replace_all: false,
      },
      baseContext,
    );

    expect(result).toContain('Error: File not found');
  });

  it('should throw non-ENOENT filesystem errors', async () => {
    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw permError; });

    await expect(
      editTool.config.execute(
        {
          file_path: '/test/project/file.ts',
          old_string: 'old',
          new_string: 'new',
          replace_all: false,
        },
        baseContext,
      ),
    ).rejects.toThrow('EACCES');
  });

  it('should call assertPathContained for path security', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('hello world');
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

    await editTool.config.execute(
      {
        file_path: '/test/project/file.ts',
        old_string: 'hello world',
        new_string: 'goodbye world',
        replace_all: false,
      },
      baseContext,
    );

    expect(assertPathContained).toHaveBeenCalledWith('/test/project/file.ts', '/test/project');
  });

  it('should throw when path is outside project boundary', async () => {
    vi.mocked(assertPathContained).mockImplementation(() => {
      throw new Error("Path '/etc/passwd' is outside the project directory");
    });

    await expect(
      editTool.config.execute(
        {
          file_path: '/etc/passwd',
          old_string: 'root',
          new_string: 'hacked',
          replace_all: false,
        },
        baseContext,
      ),
    ).rejects.toThrow('outside the project directory');
  });

  it.each(['/test/project/.git/hooks/pre-commit', '/test/project/.git/config'])(
    'should reject edits to git internals: %s',
    async (file_path) => {
      await expect(
        editTool.config.execute(
          { file_path, old_string: 'a', new_string: 'b', replace_all: false },
          baseContext,
        ),
      ).rejects.toThrow('git internals');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    },
  );

  it('should enforce writeRoot when set', async () => {
    vi.mocked(assertPathContained).mockImplementation((filePath: string, root: string) => {
      if (!filePath.startsWith(root)) throw new Error('outside');
      return { contained: true, resolvedPath: filePath };
    });
    vi.mocked(fs.readFileSync).mockReturnValue('aaa');
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    const context = { ...baseContext, writeRoot: '/test/project/sub' } as ToolContext;
    const args = { old_string: 'aaa', new_string: 'bbb', replace_all: false };

    await expect(
      editTool.config.execute({ file_path: '/test/project/other.ts', ...args }, context),
    ).rejects.toThrow('outside the allowed write root');
    expect(fs.writeFileSync).not.toHaveBeenCalled();

    const result = await editTool.config.execute(
      { file_path: '/test/project/sub/ok.ts', ...args },
      context,
    );
    expect(result).toContain('Successfully edited');
  });
});
