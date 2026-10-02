import { describe, it, expect } from 'vitest';
import { buildReportRows, reportToCsv, reportToHtml } from './ids-report.js';
import type { IdsDocument, SpecResult } from './types.js';

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
});
