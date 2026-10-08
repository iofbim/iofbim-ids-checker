import { describe, it, expect } from 'vitest';
import { buildReportRows, reportToCsv, reportToHtml } from './ids-report.js';
import type { EntityOutcome, FailureReason, IdsDocument, RequirementCheck, SpecResult } from './types.js';

const doc: IdsDocument = {
  title: 'MyProject.ids',
  specifications: [
    { id: 's1', name: 'External walls', description: 'Walls must be external', applicability: [], cardinality: 'required', requirements: [] },
    { id: 's2', name: 'Not applicable spec', applicability: [], cardinality: 'optional', requirements: [] },
  ],
};

const results: Record<string, SpecResult> = {
  s1: {
    specId: 's1',
    applicable: ['m1:10', 'm1:11'],
    passed: ['m1:11'],
    failed: ['m1:10'],
    outcomes: {
      'm1:10': {
        uid: 'm1:10',
        ifcType: 'IFCWALL',
        name: 'Wall-042',
        failures: [
          { requirement: 'Property Pset_WallCommon.IsExternal', expected: 'required', found: null },
          { requirement: 'Attribute Name', expected: 'required', found: 'Wall, A' },
          { requirement: 'Material Concrete', expected: 'required', found: undefined },
        ],
        checks: [],
      },
      'm1:11': { uid: 'm1:11', ifcType: 'IFCWALL', name: 'Wall-043', failures: [], checks: [] },
    },
    cardinalitySatisfied: true,
    durationMs: 1,
    requirements: [],
  },
  s2: { specId: 's2', applicable: [], passed: [], failed: [], outcomes: {}, requirements: [], cardinalitySatisfied: true, durationMs: 0 },
};

describe('buildReportRows', () => {
  it('flattens one row per failed requirement, missing → "(missing)"', () => {
    const rows = buildReportRows(doc, results);
    expect(rows).toHaveLength(3);
    expect(rows[0]!).toMatchObject({
      specName: 'External walls',
      modelId: 'm1',
      entityId: '10',
      ifcType: 'IFCWALL',
      entityName: 'Wall-042',
      requirement: 'Property Pset_WallCommon.IsExternal',
      expected: 'required',
      found: '(missing)',
    });
    // undefined found (set-membership facet) → empty string, not "(missing)".
    expect(rows[2]!.found).toBe('');
  });

  it('skips passed entities and non-applicable specs', () => {
    const rows = buildReportRows(doc, results);
    expect(rows.every((r) => r!.specName === 'External walls')).toBe(true);
  });

  it('emits a spec-level row when the specification cardinality is unmet', () => {
    const cardDoc: IdsDocument = {
      title: 'C.ids',
      specifications: [
        { id: 'c1', name: 'Must have a project', applicability: [], cardinality: 'required', requirements: [] },
      ],
    };
    const cardResults: Record<string, SpecResult> = {
      c1: {
        specId: 'c1', applicable: [], passed: [], failed: [], outcomes: {},
        cardinalitySatisfied: false,
        cardinalityReason: 'Required, but no applicable entity found in the model.',
        durationMs: 0,
        requirements: [],
      },
    };
    const rows = buildReportRows(cardDoc, cardResults);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      specName: 'Must have a project',
      requirement: 'Specification cardinality',
      expected: 'required',
      found: 'Required, but no applicable entity found in the model.',
    });
    // And the HTML surfaces it rather than "not applicable".
    const html = reportToHtml(cardDoc, cardResults);
    expect(html).toContain('Specification cardinality not satisfied');
    expect(html).not.toContain('Not applicable to the loaded models.');
  });
});

describe('reportToCsv', () => {
  it('has a header row and quotes values containing commas', () => {
    const csv = reportToCsv(doc, results);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'Specification,Model,Entity ID,IFC Type,Entity Name,Failed Requirement,Expected,Found',
    );
    expect(lines).toHaveLength(4); // header + 3 failures
    // The "Wall, A" found value must be quoted.
    expect(csv).toContain('"Wall, A"');
  });
});

describe('reportToHtml', () => {
  it('is a standalone document listing failed items and escapes markup', () => {
    const html = reportToHtml(doc, results);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Wall-042');
    expect(html).toContain('Pset_WallCommon.IsExternal');
    expect(html).toContain('(missing)');
    expect(html).toContain('Not applicable to the loaded models.');
  });

  it('escapes HTML-special characters in values', () => {
    const evil: Record<string, SpecResult> = {
      s1: {
        ...results.s1!,
        outcomes: {
          'm1:10': {
            uid: 'm1:10', ifcType: 'IFCWALL', name: '<script>x</script>',
            failures: [{ requirement: 'Attribute Name', expected: 'required', found: 'a & b' }],
            checks: [],
          },
        },
        failed: ['m1:10'],
      },
      s2: results.s2!,
    };
    const html = reportToHtml(doc, evil);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('shows model display names when given, and the id otherwise', () => {
    const named = buildReportRows(doc, results, { m1: 'house.ifc' });
    expect(named.filter((r) => r.entityId === '10').every((r) => r.modelId === 'house.ifc')).toBe(true);
    expect(buildReportRows(doc, results).find((r) => r.entityId === '10')?.modelId).toBe('m1');
    expect(reportToCsv(doc, results, { m1: 'house.ifc' })).toContain('house.ifc');
    expect(reportToHtml(doc, results, { m1: 'house.ifc' })).toContain('house.ifc');
  });

  it('omits N/A specs and reports how many were hidden when asked', () => {
    const full = reportToHtml(doc, results);
    expect(full).toContain('Not applicable to the loaded models.');
    expect(full).not.toContain('not-applicable specification');

    const hidden = reportToHtml(doc, results, {}, { hideNotApplicable: true });
    expect(hidden).not.toContain('Not applicable to the loaded models.');
    expect(hidden).toContain('1 not-applicable specification hidden');
    // The omitted spec is gone from the summary table too.
    expect(hidden).not.toContain('Not applicable spec');
    expect(hidden).toContain('External walls');
  });
});

// ---------------------------------------------------------------------------
// Progress, summary table and element grouping
// ---------------------------------------------------------------------------

function check(index: number, passed: boolean): RequirementCheck {
  return { requirement: `Req ${index}`, expected: 'required', index, passed };
}

function outcomeWith(uid: string, name: string, passed: boolean[]): EntityOutcome {
  const failures: FailureReason[] = passed
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => !p)
    .map(({ index }) => ({ requirement: `Req ${index}`, expected: 'required', found: null }));
  return { uid, ifcType: 'IFCWALL', name, failures, checks: passed.map((p, i) => check(i, p)) };
}

const progressDoc: IdsDocument = {
  title: 'Progress.ids',
  specifications: [
    { id: 'p1', name: 'Walls', applicability: [], cardinality: 'required', requirements: [] },
  ],
};

const progressResults: Record<string, SpecResult> = {
  p1: {
    specId: 'p1',
    applicable: ['m1:1', 'm1:2', 'm1:3'],
    passed: ['m1:3'],
    failed: ['m1:1', 'm1:2'],
    outcomes: {
      'm1:1': outcomeWith('m1:1', 'Wall-1', [false, false]),
      'm1:2': outcomeWith('m1:2', 'Wall-2', [true, false]),
      'm1:3': outcomeWith('m1:3', 'Wall-3', [true, true]),
    },
    requirements: ['Req 0', 'Req 1'],
    cardinalitySatisfied: true,
    durationMs: 0,
  },
};

describe('reportToHtml (progress)', () => {
  const html = reportToHtml(progressDoc, progressResults);

  it('renders a summary table with status, counts and requirement progress', () => {
    expect(html).toContain('<th>Specification</th><th>Status</th>');
    expect(html).toContain('<td class="bad">Fail</td>');
    expect(html).toContain('3/6 (50%)');
    // The row carries the element counts: one pass, one partial, one fail.
    const row = html.slice(html.indexOf('<td>Walls</td>'), html.indexOf('</tr>', html.indexOf('<td>Walls</td>')));
    expect(row.match(/<td>1<\/td>/g)).toHaveLength(3);
  });

  it('shows the pass · partial · fail summary and a progress bar', () => {
    expect(html).toContain('1 pass');
    expect(html).toContain('1 partial');
    expect(html).toContain('1 fail');
    expect(html).toContain('3 applicable');
    expect(html).toContain('class="bar"');
    expect(html).toContain('style="width: 50%"');
  });

  it('groups elements Fail → Partial → Pass, opening Fail and Partial only', () => {
    const fail = html.indexOf('<summary>Fail (1)</summary>');
    const partial = html.indexOf('<summary>Partial (1)</summary>');
    const pass = html.indexOf('<summary>Pass (1)</summary>');
    expect(fail).toBeGreaterThan(-1);
    expect(partial).toBeGreaterThan(fail);
    expect(pass).toBeGreaterThan(partial);
    expect(html).toContain('<details class="group group-fail" open>');
    expect(html).toContain('<details class="group group-partial" open>');
    expect(html).toContain('<details class="group group-pass">');
  });

  it('classifies a partially-complete element and colours its border amber', () => {
    const partialBlock = html.slice(
      html.indexOf('<details class="group group-partial"'),
      html.indexOf('<details class="group group-pass"'),
    );
    expect(partialBlock).toContain('Wall-2');
    expect(partialBlock).toContain('class="item item-partial"');
    expect(html).toContain('class="item item-fail"');
    expect(html).toContain('class="item item-pass"');
  });

  it('lists every requirement check with ✓/✗ and highlights failed rows', () => {
    expect(html).toContain('<th class="mark">✓/✗</th>');
    expect(html).toContain('✓');
    expect(html).toContain('✗');
    expect(html).toContain('<tr class="failed">');
    // Every check is present, passed ones included.
    expect(html).toContain('Req 0');
    expect(html).toContain('Req 1');
  });

  it('falls back to failures (all ✗) for outcomes without checks', () => {
    const legacy: Record<string, SpecResult> = {
      p1: {
        ...progressResults.p1!,
        outcomes: {
          'm1:1': {
            uid: 'm1:1',
            ifcType: 'IFCWALL',
            name: 'Wall-1',
            failures: [{ requirement: 'Attribute Name', expected: 'required', found: null }],
            checks: [],
          },
        },
        applicable: ['m1:1'],
        passed: [],
        failed: ['m1:1'],
      },
    };
    const out = reportToHtml(progressDoc, legacy);
    expect(out).toContain('Attribute Name');
    expect(out).toContain('<tr class="failed">');
  });
});
