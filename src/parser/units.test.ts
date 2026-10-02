import { describe, it, expect } from 'vitest';
import { resolveUnits, resolveValueUnit } from './units.js';
import type { RawRecord } from './tokenizer.js';

// Typed-line box helpers (mirror web-ifc shapes).
const enumTok = (v: string) => ({ value: v, type: 3 });
const label = (v: string) => ({ value: v, type: 1, name: 'IfcLabel' });
const real = (v: number) => ({ value: v, type: 4, name: 'IfcReal' });
const ref = (id: number) => ({ value: id, type: 5 });

function unitRec(id: number, type: string, line: Record<string, unknown>): RawRecord {
  return { id, type, args: '', line };
}

describe('resolveUnits', () => {
  it('scales an SI prefix on a length unit (mm → m factor 1e-3)', () => {
    const recs = [unitRec(1, 'IFCSIUNIT', {
      UnitType: enumTok('LENGTHUNIT'), Prefix: enumTok('MILLI'), Name: enumTok('METRE'),
    })];
    const u = resolveUnits(recs).byId.get(1)!;
    expect(u.label).toBe('MILLIMETRE');
    expect(u.siFactor).toBeCloseTo(1e-3);
    expect(u.unitType).toBe('LENGTHUNIT');
  });

  it('squares the prefix factor for area (mm² → m² factor 1e-6)', () => {
    const recs = [unitRec(2, 'IFCSIUNIT', {
      UnitType: enumTok('AREAUNIT'), Prefix: enumTok('MILLI'), Name: enumTok('SQUARE_METRE'),
    })];
    const u = resolveUnits(recs).byId.get(2)!;
    expect(u.label).toBe('SQUARE MILLIMETRE');
    expect(u.siFactor).toBeCloseTo(1e-6);
  });

  it('uses factor 1 for an unprefixed SI unit', () => {
    const recs = [unitRec(3, 'IFCSIUNIT', {
      UnitType: enumTok('VOLUMEUNIT'), Prefix: null, Name: enumTok('CUBIC_METRE'),
    })];
    const u = resolveUnits(recs).byId.get(3)!;
    expect(u.siFactor).toBe(1);
    expect(u.label).toBe('CUBIC METRE');
  });

  it('resolves a conversion-based unit from its ConversionFactor', () => {
    // INCH = 0.0254 m, defined relative to an SI METRE (#10).
    const recs = [
      unitRec(10, 'IFCSIUNIT', { UnitType: enumTok('LENGTHUNIT'), Prefix: null, Name: enumTok('METRE') }),
      unitRec(11, 'IFCCONVERSIONBASEDUNIT', {
        UnitType: enumTok('LENGTHUNIT'),
        Name: label('INCH'),
        ConversionFactor: { ValueComponent: real(0.0254), UnitComponent: ref(10) },
      }),
    ];
    const u = resolveUnits(recs).byId.get(11)!;
    expect(u.label).toBe('INCH');
    expect(u.siFactor).toBeCloseTo(0.0254);
  });

  it('maps project defaults from IfcUnitAssignment by measure type', () => {
    const recs = [
      unitRec(1, 'IFCSIUNIT', { UnitType: enumTok('LENGTHUNIT'), Prefix: enumTok('MILLI'), Name: enumTok('METRE') }),
      unitRec(2, 'IFCSIUNIT', { UnitType: enumTok('AREAUNIT'), Prefix: null, Name: enumTok('SQUARE_METRE') }),
      unitRec(3, 'IFCUNITASSIGNMENT', { Units: [ref(1), ref(2)] }),
    ];
    const table = resolveUnits(recs);
    expect(table.byType.get('LENGTHUNIT')!.label).toBe('MILLIMETRE');
    expect(table.byType.get('AREAUNIT')!.siFactor).toBe(1);
  });
});

describe('resolveValueUnit', () => {
  const recs = [
    unitRec(1, 'IFCSIUNIT', { UnitType: enumTok('AREAUNIT'), Prefix: enumTok('MILLI'), Name: enumTok('SQUARE_METRE') }),
    unitRec(2, 'IFCSIUNIT', { UnitType: enumTok('AREAUNIT'), Prefix: null, Name: enumTok('SQUARE_METRE') }),
    unitRec(3, 'IFCUNITASSIGNMENT', { Units: [ref(2)] }),
  ];
  const table = resolveUnits(recs);

  it('prefers an explicit Unit ref on the entity', () => {
    const u = resolveValueUnit('IFCQUANTITYAREA', { Unit: ref(1) }, table);
    expect(u!.label).toBe('SQUARE MILLIMETRE');
  });

  it('falls back to the project default for the measure type', () => {
    const u = resolveValueUnit('IFCQUANTITYAREA', { Unit: null }, table);
    expect(u!.label).toBe('SQUARE METRE');
  });
});

describe('SI normalization keeps full precision in the store', () => {
  // The store (and DuckDB) must stay lossless — rounding is display-only.
  it('stores the SI-normalized and authored quantity values at full precision', async () => {
    const { extractFromRecords } = await import('./extractor.js');
    const real = (v: number) => ({ value: v, type: 4, name: 'IfcReal' });
    const enumTok = (v: string) => ({ value: v, type: 3 });
    const ref = (id: number) => ({ value: id, type: 5 });

    const recs: RawRecord[] = [
      unitRec(1, 'IFCSIUNIT', { UnitType: enumTok('AREAUNIT'), Prefix: null, Name: enumTok('SQUARE_METRE') }),
      unitRec(2, 'IFCUNITASSIGNMENT', { Units: [ref(1)] }),
      unitRec(20, 'IFCQUANTITYAREA', { Name: { value: 'NetArea', type: 1 }, AreaValue: real(17.79099885504) }),
    ];
    const { entities } = extractFromRecords(recs, 'IFC4', 'test.ifc');
    const qty = entities.get(20)!;
    // Stored values keep full precision (not rounded to 2 dp).
    expect(qty.qtyValue).toBe('17.79099885504');
    expect(qty.qtyValueSi).toBe(17.79099885504);
    expect(qty.qtyUnit).toBe('SQUARE METRE');
  });
});
