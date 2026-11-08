/**
 * zeenha fork: the prompt FILES. Runner tests mock the loader, so only a test
 * that reads these files notices if the instructions change back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { promptSearchDirs } from '../prompt-loader';

const prompt = (name: string) => readFileSync(join(__dirname, '../../../../../prompts', name), 'utf-8');

describe('agent prompts', () => {
  it('coder: does not run code from the old Python build', () => {
    const coder = prompt('coder.md');
    expect(coder).not.toContain('from prediction import');
    expect(coder).not.toContain('session_insights');
    expect(coder).not.toContain('init.sh');
  });

  it('coder: honours the assigned subtask instead of scanning the plan', () => {
    expect(prompt('coder.md')).toContain('**YOUR SUBTASK**');
  });

  it('planner: asks for few cohesive subtasks and no setup script', () => {
    const planner = prompt('planner.md');
    expect(planner).toContain('Aim for 5-8 subtasks');
    expect(planner).not.toContain('1-3 files max');
    expect(planner).not.toContain('init.sh');
    expect(planner).not.toContain('auto-claude/run.py');
  });

  it('qa reviewer: full suites once, only after targeted tests pass, and one at a time', () => {
    const reviewer = prompt('qa_reviewer.md');
    expect(reviewer).toContain('NOT RUN (targeted tests failed)');
    expect(reviewer).toContain('one at a time');
    expect(reviewer).not.toContain('Run ALL tests, not just new ones');
  });

  it('qa reviewer: an environment failure leaves no verdict', () => {
    expect(prompt('qa_reviewer.md')).toContain('leave out the `Status:` line');
  });

  it('qa fixer: leaves full suites to the reviewer', () => {
    const fixer = prompt('qa_fixer.md');
    expect(fixer).toContain('Do not run full test suites');
    expect(fixer).not.toContain('Run full suite');
    expect(fixer).not.toContain('Run the full test suite');
    expect(fixer).not.toContain('init.sh');
  });
});

describe('where the build worker finds prompts', () => {
  const packaged = '/opt/app/resources/app.asar/out/main/ai/agent';

  it('finds the rewritten prompts in the packaged resources folder', () => {
    for (const agent of ['planner', 'coder', 'qa_reviewer', 'qa_fixer']) {
      expect(promptSearchDirs(agent, packaged)[0]).toBe('/opt/app/resources/prompts');
    }
  });

  it('finds them through process.resourcesPath as well', () => {
    expect(promptSearchDirs('coder', packaged, '/elsewhere/resources')[0]).toBe('/elsewhere/resources/prompts');
  });

  it('finds them in a development build', () => {
    expect(promptSearchDirs('coder', '/repo/apps/desktop/out/main/ai/agent')).toContain('/repo/apps/desktop/prompts');
  });

  it('leaves agents whose prompts have not been reviewed on their current path', () => {
    const dirs = promptSearchDirs('spec_writer', packaged, '/opt/app/resources');
    expect(dirs).not.toContain('/opt/app/resources/prompts');
    expect(dirs).toHaveLength(4);
  });
});
