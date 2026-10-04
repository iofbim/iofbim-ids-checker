/**
 * Per-model IFC unit resolution (ADR-009, PB-B).
 *
 * IFC values are authored in whatever units the project's `IfcUnitAssignment`
 * declares (e.g. millimetres, square metres). To make numeric/unit queries
 * (`area > 10 m²`) correct regardless of authored units, we resolve every unit
 * once per model into:
 *
 *   - a human label  (e.g. `MILLIMETRE`, `SQUARE METRE`),
 *   - an SI conversion factor (multiply authored value → SI base unit value).
 *
 * Resolution covers:
 *   - `IfcSIUnit`           — base SI unit with an optional decimal prefix,
 *   - `IfcConversionBasedUnit` — a named unit defined by a `ConversionFactor`
 *     (`IfcMeasureWithUnit`) relative to another (usually SI) unit,
 *   - `IfcUnitAssignment`   — the project default unit for each measure type.
 *
 * Resolution reads web-ifc typed lines by named attribute, so it is schema
 * robust (IFC2X3 / IFC4 / IFC4X3).
 */

import type { RawRecord } from './tokenizer.js';
import { unwrap, readEnum, readRef } from './typed-line.js';
import type { TypedLine } from './typed-line.js';

/** A unit resolved to a display label and an SI conversion factor. */
export interface ResolvedUnit {
  /** Human-readable label, e.g. `MILLIMETRE`, `SQUARE METRE`, `DEGREE`. */
  label: string;
  /** Multiply an authored value by this to get the SI base-unit value. */
  siFactor: number;
  /** IfcUnitEnum measure type, e.g. `LENGTHUNIT`, `AREAUNIT`. */
  unitType: string | null;
}

export interface UnitTable {
  /** Resolved unit keyed by the unit entity's express id. */
  byId: Map<number, ResolvedUnit>;
  /** Project-default unit keyed by IfcUnitEnum measure type. */
  byType: Map<string, ResolvedUnit>;
}

/** Decimal multiplier for an IfcSIPrefix enum value. */
const SI_PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3,
  HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6,
  NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

/** Pretty label per IfcSIUnitName (base, prefix applied separately). */
const SI_UNIT_LABEL: Record<string, string> = {
  METRE: 'METRE', SQUARE_METRE: 'SQUARE METRE', CUBIC_METRE: 'CUBIC METRE',
  GRAM: 'GRAM', SECOND: 'SECOND', RADIAN: 'RADIAN', STERADIAN: 'STERADIAN',
  HERTZ: 'HERTZ', NEWTON: 'NEWTON', PASCAL: 'PASCAL', JOULE: 'JOULE',
  WATT: 'WATT', AMPERE: 'AMPERE', VOLT: 'VOLT', WEBER: 'WEBER',
  TESLA: 'TESLA', HENRY: 'HENRY', DEGREE_CELSIUS: 'DEGREE CELSIUS',
  LUMEN: 'LUMEN', LUX: 'LUX', LUMINOUS_FLUX: 'LUMEN', LUMINOUS_INTENSITY: 'CANDELA',
  CANDELA: 'CANDELA', MOLE: 'MOLE', BECQUEREL: 'BECQUEREL', GRAY: 'GRAY',
  SIEVERT: 'SIEVERT', COULOMB: 'COULOMB', FARAD: 'FARAD', OHM: 'OHM',
  SIEMENS: 'SIEMENS',
};

/**
 * An IfcSIUnit prefix scales the *length* dimension. For area (m²) the factor is
 * squared, for volume (m³) cubed. We infer the dimension power from the unit name.
 */
function dimensionPower(siName: string): number {
  if (siName === 'SQUARE_METRE') return 2;
  if (siName === 'CUBIC_METRE') return 3;
  return 1;
}

/** Combine a base SI label with its prefix into a single display label. */
function prefixedLabel(prefix: string | null, baseLabel: string): string {
  if (!prefix) return baseLabel;
  const p = prefix.charAt(0) + prefix.slice(1).toLowerCase();
  // METRE → MILLIMETRE; SQUARE METRE → SQUARE MILLIMETRE.
  if (baseLabel.includes(' ')) {
    const parts = baseLabel.split(' ');
    const last = parts.pop()!;
    return [...parts, p.toUpperCase() + last].join(' ');
  }
  return p.toUpperCase() + baseLabel;
}

function resolveSIUnit(line: TypedLine): ResolvedUnit {
  const siNameRaw = readEnum(line, 'Name') ?? 'METRE';
  const siName = siNameRaw.toUpperCase().replace(/ /g, '_');
  const prefix = readEnum(line, 'Prefix');
  const unitType = readEnum(line, 'UnitType');
  const baseLabel = SI_UNIT_LABEL[siName] ?? siName.replace(/_/g, ' ');
  const power = dimensionPower(siName);
  const siFactor = prefix && SI_PREFIX[prefix] !== undefined
    ? Math.pow(SI_PREFIX[prefix]!, power)
    : 1;
  return { label: prefixedLabel(prefix, baseLabel), siFactor, unitType };
}

/**
 * Resolve an IfcConversionBasedUnit. Its `ConversionFactor` is an
 * IfcMeasureWithUnit whose `ValueComponent` (a number) times the SI factor of
 * its `UnitComponent` gives the authored unit's SI factor.
 */
function resolveConversionUnit(line: TypedLine, byId: Map<number, ResolvedUnit>): ResolvedUnit {
  const label = (unwrap((line as Record<string, unknown>).Name) as string | null) ?? 'UNIT';
  const unitType = readEnum(line, 'UnitType');
  const cf = (line as Record<string, unknown>).ConversionFactor as TypedLine | undefined;
  let siFactor = 1;
  if (cf && typeof cf === 'object') {
    const valueComponent = unwrap((cf as Record<string, unknown>).ValueComponent);
    const num = typeof valueComponent === 'number' ? valueComponent : Number(valueComponent);
    const unitRef = readRef(cf, 'UnitComponent');
    const baseSi = unitRef !== null ? byId.get(unitRef)?.siFactor ?? 1 : 1;
    if (Number.isFinite(num)) siFactor = num * baseSi;
  }
  return { label: String(label), siFactor, unitType };
}

/**
 * Build the model's unit table from its parsed records. Records already carry
 * web-ifc typed lines for non-IfcRel entities, including the unit entities.
 */
export function resolveUnits(records: RawRecord[]): UnitTable {
  const byId = new Map<number, ResolvedUnit>();
  const byType = new Map<string, ResolvedUnit>();

  // Pass 1: SI units (no dependencies).
  for (const rec of records) {
    if (rec.type !== 'IFCSIUNIT' || !rec.line) continue;
    byId.set(rec.id, resolveSIUnit(rec.line));
  }
  // Pass 2: conversion-based units (may reference an SI unit resolved in pass 1).
  for (const rec of records) {
    if (rec.type !== 'IFCCONVERSIONBASEDUNIT' || !rec.line) continue;
    byId.set(rec.id, resolveConversionUnit(rec.line, byId));
  }

  // Pass 3: project defaults from IfcUnitAssignment.Units (list of unit refs).
  for (const rec of records) {
    if (rec.type !== 'IFCUNITASSIGNMENT' || !rec.line) continue;
    const units = (rec.line as Record<string, unknown>).Units;
    if (!Array.isArray(units)) continue;
    for (const u of units) {
      const id = typeof u === 'object' && u !== null ? (u as { value?: unknown }).value : null;
      if (typeof id !== 'number') continue;
      const resolved = byId.get(id);
      if (resolved?.unitType) byType.set(resolved.unitType, resolved);
    }
  }

  return { byId, byType };
}

/** IfcQuantity* type → the IfcUnitEnum measure type its value is expressed in. */
const QTY_MEASURE_TYPE: Record<string, string> = {
  IFCQUANTITYLENGTH: 'LENGTHUNIT',
  IFCQUANTITYAREA:   'AREAUNIT',
  IFCQUANTITYVOLUME: 'VOLUMEUNIT',
  IFCQUANTITYWEIGHT: 'MASSUNIT',
  IFCQUANTITYTIME:   'TIMEUNIT',
  IFCQUANTITYCOUNT:  '', // dimensionless
  IFCQUANTITYNUMBER: '', // dimensionless (IFC4X3)
};

/**
 * Resolve the authored unit for a property/quantity entity.
 *   - explicit `Unit` ref on the entity wins;
 *   - else the project default for the quantity's measure type;
 *   - else null (unitless / unknown).
 */
export function resolveValueUnit(
  type: string,
  line: TypedLine | undefined,
  units: UnitTable,
): ResolvedUnit | null {
  if (line) {
    const explicit = readRef(line, 'Unit');
    if (explicit !== null && units.byId.has(explicit)) return units.byId.get(explicit)!;
  }
  const measure = QTY_MEASURE_TYPE[type];
  if (measure) return units.byType.get(measure) ?? null;
  return null;
}

/**
 * The IfcUnitEnum unit type a measure is expressed in, by IFC naming convention:
 * IFCLENGTHMEASURE → LENGTHUNIT, IFCAREAMEASURE → AREAUNIT, … . Returns null for
 * non-measures (IFCLABEL, IFCREAL) and for measures whose derived name is not a
 * real unit type (IFCCOUNTMEASURE → COUNTUNIT), so no bogus conversion happens.
 */
export function measureUnitType(measure: string): string | null {
  const m = measure.toUpperCase();
  if (!m.startsWith('IFC') || !m.endsWith('MEASURE')) return null;
  return `${m.slice(3, -'MEASURE'.length)}UNIT`;
}

/**
 * Resolve the unit a multi-valued property's value is expressed in: the record's
 * explicit unit reference wins, else the project default for the value's measure
 * dimension (a bare IFCLENGTHMEASURE uses the project's LENGTHUNIT).
 */
export function resolvePropertyValueUnit(
  unitRef: number | null,
  measure: string | null,
  units: UnitTable,
): ResolvedUnit | null {
  if (unitRef !== null) {
    const explicit = units.byId.get(unitRef);
    if (explicit) return explicit;
  }
  const unitType = measure ? measureUnitType(measure) : null;
  return unitType ? units.byType.get(unitType) ?? null : null;
}
