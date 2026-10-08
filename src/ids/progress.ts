/**
 * Per-element progress within a specification.
 *
 * The strict IDS verdict only knows "passed" / "failed" per element. This
 * module adds the intermediate **partial** status — an element that met some
 * (but not all) of a specification's requirements — plus aggregate counts and
 * requirement-level progress, so reports can show how far along a model is.
 *
 * Pure functions over {@link SpecResult}; the evaluator's verdict is untouched.
 */

import type { EntityOutcome, SpecResult, Uid } from './types.js';

/** How an applicable element fared against a specification's requirements. */
export type ElementStatus = 'pass' | 'partial' | 'fail';

/**
 * pass: every requirement check met; partial: some met, some not; fail: none met.
 * An outcome with no `checks` falls back to `failures`: none → pass, any → fail.
 */
export function elementStatus(outcome: EntityOutcome): ElementStatus {
  if (outcome.checks.length === 0) {
    return outcome.failures.length === 0 ? 'pass' : 'fail';
  }
  const passed = outcome.checks.filter((c) => c.passed).length;
  if (passed === outcome.checks.length) return 'pass';
  if (passed === 0) return 'fail';
  return 'partial';
}

/** Per-status element uids and requirement-check totals for one specification. */
export interface SpecProgress {
  /** Applicable elements by status, in `applicable` order. */
  pass: Uid[];
  partial: Uid[];
  fail: Uid[];
  /** Requirement checks passed over all applicable elements. */
  checksPassed: number;
  /** Requirement checks evaluated over all applicable elements. */
  checksTotal: number;
  /** `round(100 * checksPassed / checksTotal)`; null when `checksTotal` is 0. */
  percent: number | null;
}

/**
 * Summarise a specification result by element status and requirement progress.
 * Outcomes without `checks` (hand-built/legacy results) contribute their
 * `failures` — each failure is an unmet check — so the percentage stays honest.
 */
export function specProgress(result: SpecResult): SpecProgress {
  const pass: Uid[] = [];
  const partial: Uid[] = [];
  const fail: Uid[] = [];
  let checksPassed = 0;
  let checksTotal = 0;

  for (const uid of result.applicable) {
    const outcome = result.outcomes[uid];
    if (!outcome) continue;

    const status = elementStatus(outcome);
    if (status === 'pass') pass.push(uid);
    else if (status === 'partial') partial.push(uid);
    else fail.push(uid);

    if (outcome.checks.length > 0) {
      checksTotal += outcome.checks.length;
      checksPassed += outcome.checks.filter((c) => c.passed).length;
    } else {
      checksTotal += outcome.failures.length;
    }
  }

  return {
    pass,
    partial,
    fail,
    checksPassed,
    checksTotal,
    percent: checksTotal === 0 ? null : Math.round((100 * checksPassed) / checksTotal),
  };
}

/**
 * A specification is not applicable: no applicable element and its cardinality
 * is satisfied. A missing result counts as not applicable; a `required` spec
 * with zero applicable elements is a cardinality failure, so it is **not** N/A.
 */
export function isNotApplicable(result: SpecResult | undefined): boolean {
  if (!result) return true;
  return result.applicable.length === 0 && result.cardinalitySatisfied;
}
