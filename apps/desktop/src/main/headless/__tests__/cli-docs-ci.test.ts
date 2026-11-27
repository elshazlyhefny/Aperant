/**
 * zeenha fork: keep the copyable CLI source build and advertised runtime floor
 * aligned with the jobs that verify them in CI.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '../../../../../..');
const GUIDE = 'guides/CLI-USAGE.md';
const CI = '.github/workflows/ci.yml';
const MANIFEST = 'apps/desktop/package.json';

interface Step {
  uses?: string;
  with?: { 'node-version'?: string | number };
  run?: string;
  'working-directory'?: string;
}

interface Job {
  steps?: Step[];
  'continue-on-error'?: boolean | string;
  strategy?: {
    matrix?: { node?: (string | number)[]; exclude?: { node: string | number }[] };
  };
}

interface Workflow extends Pick<Job, 'steps'> {
  name?: string;
  jobs?: Record<string, Job>;
}

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

const guide = read(GUIDE);
const ci = parse(read(CI)) as Workflow;
const examples = [...guide.matchAll(/^```ya?ml[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)].map(
  ([, yaml]) => parse(yaml) as Workflow | Step[] | null,
);

function nodeVersion(steps: Step[]): string {
  const setup = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  return String(setup?.with?.['node-version'] ?? '');
}

function aperantTaskSteps(): Step[] {
  const example = examples.find((block): block is Workflow => !Array.isArray(block) && block?.name === 'aperant-task');
  const steps = example?.jobs?.run?.steps;
  expect(steps, `Keep the aperant-task source-build job and its steps in ${GUIDE}.`).toBeDefined();
  return steps ?? [];
}

function isInformational(setting: Job['continue-on-error'], major: string): boolean {
  if (setting === undefined || typeof setting === 'boolean') return setting ?? false;
  // Do not guess whether an unfamiliar expression gates CI. Update this check
  // if the workflow switches to a different gating rule.
  const expression = setting.trim().replace(/^\$\{\{\s*(.*?)\s*\}\}$/, '$1');
  const comparison = expression.match(/^matrix\.node\s*(==|!=)\s*(['"])(\d+)\2$/);
  if (!comparison) throw new Error(`Update this test to interpret cli-runtime continue-on-error in ${CI}: ${setting}`);
  const [, operator, , advisoryMajor] = comparison;
  return operator === '==' ? major === advisoryMajor : major !== advisoryMajor;
}

describe('CLI guide and CI agree on the Node requirements', () => {
  it('uses the CI source-build Node version and respects the package engine floor', () => {
    const guideVersion = nodeVersion(aperantTaskSteps());
    const ciVersion = nodeVersion(ci.jobs?.['cli-build']?.steps ?? []);
    expect(ciVersion, `Set node-version in the cli-build actions/setup-node step in ${CI}.`).not.toBe('');
    expect(guideVersion, `Match the aperant-task node-version in ${GUIDE} to cli-build in ${CI}.`).toBe(ciVersion);

    const { engines } = JSON.parse(read(MANIFEST)) as { engines: { node: string } };
    // A major-only setup pin must meet the floor starting at that major's .0.0.
    const version = /^v?\d+(?:\.\d+){0,2}$/.test(ciVersion) ? semver.coerce(ciVersion) : null;
    expect(version && semver.satisfies(version, engines.node),
      `Set a source-build node-version in ${CI} and ${GUIDE} that satisfies ${MANIFEST} engines.node (${engines.node}).`,
    ).toBe(true);
  });

  it('installs and builds with the same commands and directories in the guide and CI', () => {
    for (const [file, steps] of [
      [GUIDE, aperantTaskSteps()],
      [CI, ci.jobs?.['cli-build']?.steps ?? []],
    ] as const) {
      expect(steps.some((step) => step.run?.trim() === 'npm ci --ignore-scripts' && (step['working-directory'] ?? '.') === '.'),
        `Run npm ci --ignore-scripts from the checkout root in ${file}.`,
      ).toBe(true);
      expect(steps.some((step) => step.run?.trim() === 'npm run build' && step['working-directory'] === 'apps/desktop'),
        `Run npm run build with working-directory: apps/desktop in ${file}.`,
      ).toBe(true);
    }
  });

  it('only advertises runtime floors that gate CI', () => {
    const section = guide.split(/^#{1,4}[ \t]+/m).find((section) => /^Running a built CLI[ \t]*\r?\n/.test(section));
    const floors = [...(section ?? '').matchAll(/\bNode (\d+) or newer\b/g)].map(([, major]) => major);
    expect(floors, `State the runtime floor as "Node NN or newer" under Running a built CLI in ${GUIDE}.`).not.toHaveLength(0);

    const runtime = ci.jobs?.['cli-runtime'];
    const matrix = runtime?.strategy?.matrix;
    const testedMajors = (matrix?.node ?? []).map(String).filter((major) =>
      !matrix?.exclude?.some((entry) => String(entry.node) === major),
    );
    for (const major of floors) {
      expect(testedMajors, `Test Node ${major} in cli-runtime in ${CI} or change the runtime floor in ${GUIDE}.`).toContain(major);
      expect(isInformational(runtime?.['continue-on-error'], major),
        `Make Node ${major} gate cli-runtime in ${CI} before advertising it as a runtime floor in ${GUIDE}.`,
      ).toBe(false);
    }
  });

  it('does not build from source with Node 22 in any workflow example', () => {
    for (const example of examples) {
      if (!example) continue;
      const steps = Array.isArray(example)
        ? example
        : (example.steps ?? Object.values(example.jobs ?? {}).flatMap((job) => job.steps ?? []));
      if (!steps.some((step) => /\bnpm\s+run\s+build\b/.test(step.run ?? ''))) continue;
      const usesNode22 = steps.some((step) => /^v?22(?:\.|$)/.test(String(step.with?.['node-version'] ?? '')));
      expect(usesNode22,
        `Replace node-version: 22 with the supported source-build Node version in ${GUIDE}.`,
      ).toBe(false);
    }
  });
});
