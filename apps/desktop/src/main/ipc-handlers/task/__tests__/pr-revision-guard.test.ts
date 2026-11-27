import { describe, expect, it } from 'vitest';
import { isVerifiableRevision, sameRevision, shortRevision } from '../pr-revision-guard';

const fullSha = 'abcdef0123456789abcdef0123456789abcdef01';
const shortSha = 'abcdef012345';

const invalidRevisions = ['', undefined, null, 1234567, ' ', 'abcdef0 ', 'zzz', 'zzzzzzz', 'abcdef', 'a'.repeat(65)];

describe('isVerifiableRevision', () => {
  it.each(invalidRevisions)('rejects %j', (revision) => {
    expect(isVerifiableRevision(revision)).toBe(false);
  });

  it.each(['ABCDEF0', shortSha, fullSha, 'a'.repeat(64)])('accepts %s', (revision) => {
    expect(isVerifiableRevision(revision)).toBe(true);
  });
});

describe('sameRevision', () => {
  it('requires exact equality for full revisions, ignoring case', () => {
    expect(sameRevision(fullSha, fullSha)).toBe(true);
    expect(sameRevision(fullSha, fullSha.toUpperCase())).toBe(true);
    expect(sameRevision(fullSha, `${fullSha.slice(0, -1)}2`)).toBe(false);
  });

  it('matches a short prefix in either order, ignoring case', () => {
    expect(sameRevision(shortSha, fullSha)).toBe(true);
    expect(sameRevision(fullSha, shortSha.toUpperCase())).toBe(true);
  });

  it('rejects a short revision that is not a prefix', () => {
    expect(sameRevision('abcdef012346', fullSha)).toBe(false);
    expect(sameRevision(fullSha, 'abcdef012346')).toBe(false);
  });

  it.each(invalidRevisions)('never matches unverifiable input %j', (revision) => {
    expect(sameRevision(revision, revision)).toBe(false);
    expect(sameRevision(revision, fullSha)).toBe(false);
    expect(sameRevision(fullSha, revision)).toBe(false);
  });
});

describe('shortRevision', () => {
  it('keeps the first seven characters for display', () => {
    expect(shortRevision(fullSha.toUpperCase())).toBe('ABCDEF0');
  });
});
