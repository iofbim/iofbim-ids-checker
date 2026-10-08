import { describe, it, expect } from 'vitest';
import { elementStatus, specProgress, isNotApplicable } from './progress.js';
import type { EntityOutcome, FailureReason, RequirementCheck, SpecResult } from './types.js';

function check(index: number, passed: boolean): RequirementCheck {
  return { requirement: `req ${index}`, expected: 'required', index, passed };
}

function outcome(uid: string, passed: boolean[], failures: FailureReason[] = []): EntityOutcome {
  return {
    uid,
    ifcType: 'IFCWALL',
    name: null,
    failures,
    checks: passed.map((p, i) => check(i, p)),
  };
}

function spec(applicable: string[], outcomes: Record<string, EntityOutcome>): SpecResult {
  const failed = applicable.filter((u) => (outcomes[u]?.failures.length ?? 0) > 0);
  const passed = applicable.filter((u) => !failed.includes(u));
  return {
    specId: 's1',
    applicable,
    passed,
    failed,
    outcomes,
    requirements: [],
    // Cardinality is spec-level and independent of the applicable count; callers
    // override it for the required-with-zero-applicable case.
    cardinalitySatisfied: true,
    durationMs: 0,
  };
}

describe('elementStatus', () => {
  it('is pass when every requirement check met', () => {
    expect(elementStatus(outcome('m:1', [true, true, true]))).toBe('pass');
  });

  it('is partial when some checks met and some not', () => {
    expect(elementStatus(outcome('m:1', [true, false, true]))).toBe('partial');
  });

  it('is fail when no check met', () => {
    expect(elementStatus(outcome('m:1', [false, false]))).toBe('fail');
  });

  it('falls back to failures when there are no checks', () => {
    expect(elementStatus(outcome('m:1', []))).toBe('pass');
    expect(
      elementStatus(
        outcome('m:1', [], [{ requirement: 'r', expected: 'required', found: null }]),
      ),
    ).toBe('fail');
  });
});

describe('specProgress', () => {
  it('groups applicable uids by status in applicable order', () => {
    const result = spec(
      ['m:1', 'm:2', 'm:3', 'm:4'],
      {
        'm:1': outcome('m:1', [true]),
        'm:2': outcome('m:2', [true, false], [{ requirement: 'r', expected: 'required', found: null }]),
        'm:3': outcome('m:3', [false]),
        'm:4': outcome('m:4', [true, true]),
      },
    );
    const p = specProgress(result);
    expect(p.pass).toEqual(['m:1', 'm:4']);
    expect(p.partial).toEqual(['m:2']);
    expect(p.fail).toEqual(['m:3']);
  });

  it('counts requirement checks and rounds the percent', () => {
    const result = spec(
      ['m:1', 'm:2'],
      {
        'm:1': outcome('m:1', [true, true], []),
        'm:2': outcome('m:2', [false], [{ requirement: 'r', expected: 'required', found: null }]),
      },
    );
    const p = specProgress(result);
    expect(p.checksPassed).toBe(2);
    expect(p.checksTotal).toBe(3);
    expect(p.percent).toBe(67); // round(66.66…)
  });

  it('returns null percent when there are no checks at all', () => {
    const p = specProgress(spec([], {}));
    expect(p.checksPassed).toBe(0);
    expect(p.checksTotal).toBe(0);
    expect(p.percent).toBeNull();
  });

  it('counts failures of check-less outcomes as unmet checks', () => {
    const result = spec(
      ['m:1'],
      {
        'm:1': outcome('m:1', [], [
          { requirement: 'a', expected: 'required', found: null },
          { requirement: 'b', expected: 'required', found: null },
        ]),
      },
    );
    const p = specProgress(result);
    expect(p.checksPassed).toBe(0);
    expect(p.checksTotal).toBe(2);
    expect(p.fail).toEqual(['m:1']);
  });
});

describe('isNotApplicable', () => {
  it('treats a missing result as not applicable', () => {
    expect(isNotApplicable(undefined)).toBe(true);
  });

  it('is true when there are no applicable elements and cardinality is satisfied', () => {
    expect(isNotApplicable(spec([], {}))).toBe(true);
  });

  it('is false for a required spec with zero applicable elements', () => {
    const result: SpecResult = { ...spec([], {}), cardinalitySatisfied: false };
    expect(isNotApplicable(result)).toBe(false);
  });

  it('is false when any element is applicable', () => {
    expect(isNotApplicable(spec(['m:1'], { 'm:1': outcome('m:1', [true]) }))).toBe(false);
  });
});
