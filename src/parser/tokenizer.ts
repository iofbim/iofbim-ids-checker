import type { IfcEntity, RawAttribute, PropertySubtypeValue } from './types.js';
import type { TypedLine } from './typed-line.js';
import { readString, readEnum, unwrap, isEmptyString, readRef, readTypedValue, readValueType } from './typed-line.js';

export interface RawRecord {
  id: number;
  type: string;
  args: string;
  /**
   * web-ifc `GetLine` typed object (named attributes). Present for non-geometry,
   * non-IfcRel entities when parsed via the WASM loader. Field extraction reads
   * this by name (ADR-009); `args` is retained for triple extraction only.
   */
  line?: TypedLine;
}

/**
 * Accumulates raw STEP text lines into complete entity records.
 *
 * Handles:
 * - Multi-line entities (accumulates until open-paren depth returns to 0)
 * - Escaped single-quotes ('') inside string literals
 * - Enum literals (.NOTDEFINED.) — not resolved
 * - Type-cast values (IFCBOOLEAN(.T.), IFCLABEL('foo'))
 * - Null refs: $ = null, * = derived
 */
export class StepAccumulator {
  private buffer = '';
  private pendingId: number | null = null;
  private pendingType = '';

  /** Feed one raw line. Returns a completed RawRecord when ready, else null. */
  feed(rawLine: string): RawRecord | null {
    const line = rawLine.trim();
    if (!line || line === 'DATA;' || line === 'ENDSEC;' || line === 'END-ISO-10303-21;') {
      return null;
    }

    if (this.pendingId !== null) {
      // Continuation of a multi-line record
      this.buffer += ' ' + line;
      if (openDepth(this.buffer) === 0) {
        return this.flush();
      }
      return null;
    }

    if (!line.startsWith('#')) return null;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return null;

    const idStr = line.slice(1, eqIdx).trim();
    const id = parseInt(idStr, 10);
    if (isNaN(id)) return null;

    const rest = line.slice(eqIdx + 1).trim();
    const parenIdx = rest.indexOf('(');
    if (parenIdx === -1) return null;

    const type = rest.slice(0, parenIdx).toUpperCase();
    this.pendingId = id;
    this.pendingType = type;
    this.buffer = rest.slice(parenIdx);

    if (openDepth(this.buffer) === 0) {
      return this.flush();
    }
    return null;
  }

  private flush(): RawRecord {
    const id = this.pendingId!;
    const type = this.pendingType;
    // Strip outermost parens and trailing semicolons
    const raw = this.buffer.replace(/;+\s*$/, '').trim();
    const args = raw.slice(1, raw.length - 1); // remove leading ( and trailing )
    this.buffer = '';
    this.pendingId = null;
    this.pendingType = '';
    return { id, type, args };
  }
}

/** Count net open parentheses depth (ignores parens inside string literals) */
function openDepth(s: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inStr) { inStr = true; continue; }
    if (c === "'" && inStr) {
      // '' is an escaped quote inside the string, not end-of-string
      if (s[i + 1] === "'") { i++; continue; }
      inStr = false;
      continue;
    }
    if (inStr) continue;
    if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return depth;
}

/**
 * Split a top-level argument string into individual argument tokens.
 * Respects nested parentheses and STEP string literals.
 */
export function splitArgs(argsStr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < argsStr.length; i++) {
    const c = argsStr[i];
    if (c === "'" && !inStr) { inStr = true; cur += c; continue; }
    if (c === "'" && inStr) {
      if (argsStr[i + 1] === "'") { cur += "''"; i++; continue; }
      inStr = false; cur += c; continue;
    }
    if (inStr) { cur += c; continue; }
    if (c === '(') { depth++; cur += c; }
    else if (c === ')') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim() !== '') args.push(cur.trim());
  return args;
}

/** Extract a single entity reference `#id` → number, or null */
export function refId(token: string): number | null {
  const m = token.match(/^#(\d+)$/);
  if (!m) return null;
  const id = m[1];
  return id !== undefined ? parseInt(id, 10) : null;
}

/** Extract all `#id` references from a list token `(#1,#2,...)` */
export function listRefs(token: string): number[] {
  const matches = token.matchAll(/#(\d+)/g);
  return [...matches].map(m => {
    const id = m[1];
    return id !== undefined ? parseInt(id, 10) : NaN;
  }).filter(n => !isNaN(n));
}

/** Strip type-cast wrapper: `IFCLABEL('foo')` → `'foo'`; `IFCBOOLEAN(.T.)` → `.T.` */
export function stripTypeCast(token: string): string {
  const m = token.match(/^[A-Z0-9]+\((.+)\)$/);
  if (!m) return token;
  const inner = m[1];
  return inner !== undefined ? inner : token;
}

/** Decode a STEP string token `'...'` to a plain JS string (handles '' escape) */
export function decodeStepString(token: string): string | null {
  if (!token.startsWith("'") || !token.endsWith("'")) return null;
  return token.slice(1, -1).replace(/''/g, "'");
}

/**
 * Parse the FILE_SCHEMA line and return the detected IFC version string.
 * e.g. `FILE_SCHEMA(('IFC4'));` → `'IFC4'`
 */
export function detectSchema(text: string): string {
  const m = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
  if (!m) return 'UNKNOWN';
  const schema = m[1];
  return schema !== undefined ? schema.toUpperCase() : 'UNKNOWN';
}

/**
 * Types whose Name lives at arg[0] instead of the IfcRoot default (arg[2]).
 * IfcProperty*, IfcQuantity*, IfcMaterial*, IfcPhysicalQuantity and a few others
 * derive from IfcPropertyAbstraction / IfcPhysicalSimpleQuantity, not IfcRoot.
 */
const NAME_AT_ARG0 = new Set([
  // IfcProperty subtypes
  'IFCPROPERTYSINGLEVALUE', 'IFCPROPERTYENUMERATEDVALUE',
  'IFCPROPERTYBOUNDEDVALUE', 'IFCPROPERTYTABLEVALUE',
  'IFCPROPERTYREFERENCEVALUE', 'IFCPROPERTYLISTVALUE',
  'IFCCOMPLEXPROPERTY',
  // IfcPhysicalQuantity subtypes
  'IFCQUANTITYLENGTH', 'IFCQUANTITYAREA', 'IFCQUANTITYVOLUME',
  'IFCQUANTITYCOUNT', 'IFCQUANTITYWEIGHT', 'IFCQUANTITYTIME',
  'IFCQUANTITYNUMBER',
  // Material leaf types
  'IFCMATERIAL', 'IFCMATERIALLAYER', 'IFCMATERIALCONSTITUENT',
  'IFCMATERIALPROFILE',
  // IfcMaterial sets — Name at arg[0]
  'IFCMATERIALLAYERSET', 'IFCMATERIALCONSTITUENTSET', 'IFCMATERIALPROFILESET',
]);

/**
 * Extract the display name from a STEP args string.
 * IfcRoot subtypes: Name at arg[2].
 * IfcProperty* / IfcQuantity* / IfcMaterial*: Name at arg[0].
 * Uses decodeArg so both quoted ('foo') and bare LABEL strings are handled.
 */
export function extractName(type: string, args: string[]): string | null {
  const idx = NAME_AT_ARG0.has(type) ? 0 : 2;
  return decodeArg(args[idx] ?? '');
}

/**
 * Arg index at which the IFC schema stores the Identification (code/number) field,
 * for entity types that carry one. Not all entities have this field.
 *
 * Derived from IFC4 schema:
 *   IfcExternalReference subtype hierarchy (Classification/Document/LibraryReference):
 *     args[0]=Location, args[1]=Identification, args[2]=Name
 *   IfcClassification: no Identification field (code lives on the reference, not the system)
 */
const IDENTIFICATION_ARG_INDEX: Record<string, number> = {
  IFCCLASSIFICATIONREFERENCE: 1,
  IFCDOCUMENTREFERENCE:       1,
  IFCLIBRARYREFERENCE:        1,
  IFCEXTERNALREFERENCE:       1,
};

export function extractIdentification(type: string, args: string[]): string | null {
  const idx = IDENTIFICATION_ARG_INDEX[type];
  if (idx === undefined) return null;
  return decodeArg(args[idx] ?? '');
}

/** Decode a STEP arg to a plain string: strips type-cast, decodes quoted strings, resolves enums */
export function decodeArg(raw: string): string | null {
  if (!raw || raw === '$' || raw === '*') return null;
  const stripped = stripTypeCast(raw);
  const str = decodeStepString(stripped);
  if (str !== null) return str || null;
  // Enum literal .VALUE. — NOTDEFINED / USERDEFINED are valid IFC enum values
  // and returned as-is (the attribute is defined in the IFC sense).
  if (stripped.startsWith('.') && stripped.endsWith('.')) {
    const val = stripped.slice(1, -1);
    return val || null;
  }
  return stripped || null;
}

/**
 * IFC GlobalId lives at arg[0] on all IfcRoot subtypes (IfcObjectDefinition,
 * IfcRelationship, IfcPropertyDefinition).  It is always a 22-char encoded string.
 */
export function extractGlobalId(args: string[]): string | null {
  return decodeArg(args[0] ?? '');
}

/** arg[3] on IfcRoot — free-text Description */
export function extractDescription(args: string[]): string | null {
  return decodeArg(args[3] ?? '');
}

/**
 * ObjectType — arg[4] on IfcObject.
 * Only meaningful on IfcObject subtypes; ignored for IfcTypeObject (which uses Name).
 */
const OBJECT_TYPE_TYPES = new Set([
  'IFCOBJECT', 'IFCPRODUCT', 'IFCACTOR', 'IFCCONTROL', 'IFCGROUP',
  'IFCPROCESS', 'IFCRESOURCE',
  // Spatial
  'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
  'IFCEXTERNALSPATIALELEMENT', 'IFCSPATIALZONE',
  // Physical products
  'IFCELEMENT', 'IFCBUILDINGELEMENT', 'IFCWALL', 'IFCWALLSTANDARDCASE',
  'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCDOOR', 'IFCWINDOW', 'IFCROOF',
  'IFCSTAIR', 'IFCRAMP', 'IFCCOVERING', 'IFCFURNISHINGELEMENT',
  'IFCDISTRIBUTIONELEMENT', 'IFCDISTRIBUTIONFLOWDIRECTEDELEMENT',
  'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL', 'IFCFLOWFITTING', 'IFCFLOWCONTROLLER',
  'IFCENERGYCONVERSIONDEVICE', 'IFCFLOWSTORAGEDEVICE', 'IFCFLOWMOVINGDEVICE',
  'IFCBUILDINGELEMENTPROXY', 'IFCCIVILELEMENT', 'IFCGEOGRAPHICELEMENT',
  'IFCTRANSPORTELEMENT', 'IFCVIRTUALELEMENT',
  // Structural
  'IFCSTRUCTURALMEMBER', 'IFCSTRUCTURALCONNECTION', 'IFCSTRUCTURALACTIVITY',
  // MEP
  'IFCPIPESEGMENT', 'IFCPIPEFITTING', 'IFCDUCTFITTING', 'IFCDUCTSEGMENT',
  'IFCCABLEFITTING', 'IFCCABLESEGMENT', 'IFCELECTRICALELEMENT',
  'IFCAIRTERMINAL', 'IFCPUMP', 'IFCFAN', 'IFCBOILER', 'IFCCHILLER',
  'IFCHEATEXCHANGER', 'IFCLAMP', 'IFCACTUATOR', 'IFCSENSOR', 'IFCALARM',
]);

export function extractObjectType(type: string, args: string[]): string | null {
  if (!OBJECT_TYPE_TYPES.has(type)) return null;
  return decodeArg(args[4] ?? '');
}

/**
 * Tag / Mark field.  Position varies by schema and supertype depth:
 *   IFC4  IfcElement: GlobalId[0] OwnerHistory[1] Name[2] Description[3]
 *                     ObjectType[4] ObjectPlacement[5] Representation[6] Tag[7]
 *   Some subtypes add extra attrs pushing Tag to [8] or [9].
 * We check [7], [8], [9] in order and take the first non-null looking like a tag
 * (not a ref, not an enum).
 */
const TAG_TYPES = new Set([
  'IFCELEMENT', 'IFCBUILDINGELEMENT', 'IFCWALL', 'IFCWALLSTANDARDCASE',
  'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCDOOR', 'IFCWINDOW',
  'IFCROOF', 'IFCSTAIR', 'IFCRAMP', 'IFCCOVERING', 'IFCFURNISHINGELEMENT',
  'IFCBUILDINGELEMENTPROXY', 'IFCCIVILELEMENT', 'IFCDISTRIBUTIONELEMENT',
  'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL', 'IFCFLOWFITTING', 'IFCFLOWCONTROLLER',
  'IFCENERGYCONVERSIONDEVICE', 'IFCFLOWSTORAGEDEVICE', 'IFCFLOWMOVINGDEVICE',
  'IFCPIPESEGMENT', 'IFCPIPEFITTING', 'IFCDUCTSEGMENT', 'IFCDUCTFITTING',
  'IFCCABLESEGMENT', 'IFCCABLEFITTING', 'IFCELECTRICALELEMENT',
  'IFCAIRTERMINAL', 'IFCPUMP', 'IFCFAN', 'IFCBOILER', 'IFCCHILLER',
  'IFCHEATEXCHANGER', 'IFCLAMP', 'IFCACTUATOR', 'IFCSENSOR', 'IFCALARM',
  'IFCGEOGRAPHICELEMENT', 'IFCTRANSPORTELEMENT',
  // Structural
  'IFCSTRUCTURALMEMBER', 'IFCSTRUCTURALCONNECTION',
]);

export function extractTag(type: string, args: string[]): string | null {
  if (!TAG_TYPES.has(type)) return null;
  for (const idx of [7, 8, 9]) {
    const raw = args[idx] ?? '';
    if (!raw || raw === '$' || raw.startsWith('#')) continue;
    const val = decodeArg(raw);
    if (val) return val;
  }
  return null;
}

/**
 * PredefinedType enum — typically the last positional arg on most IfcProduct
 * subtypes. We scan from the end backwards (up to last 4 args) for an enum
 * literal. `NOTDEFINED` / `USERDEFINED` are valid IFC enum values and returned
 * as-is (the attribute is defined in the IFC sense).
 */
export function extractPredefinedType(args: string[]): string | null {
  const end = Math.max(0, args.length - 4);
  for (let i = args.length - 1; i >= end; i--) {
    const raw = args[i] ?? '';
    if (raw.startsWith('.') && raw.endsWith('.')) {
      const val = raw.slice(1, -1);
      return val || null;
    }
  }
  return null;
}

/**
 * LongName — IfcSpatialElement (Site, Building, Storey, Space, Zone) arg[8],
 * and IfcSpatialStructureElement arg[8].
 */
const LONG_NAME_TYPES = new Set([
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
  'IFCSPATIALZONE', 'IFCEXTERNALSPATIALELEMENT',
  'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCROAD', 'IFCRAILWAY',
  'IFCMARINESTRUCTURE',
]);

export function extractLongName(type: string, args: string[]): string | null {
  if (!LONG_NAME_TYPES.has(type)) return null;
  return decodeArg(args[8] ?? '');
}

// ---------------------------------------------------------------------------
// Typed property / quantity value decoding
// ---------------------------------------------------------------------------

/**
 * Decode a raw NominalValue arg from an IfcPropertySingleValue.
 * Arg[2] is the value, wrapped in a type-cast: IFCLABEL('foo'), IFCREAL(1.5), etc.
 * Returns { value, unit } where unit is parsed from arg[3] if present.
 */
export function decodePropValue(args: string[]): { value: string | null; unit: string | null } {
  const rawVal = args[2] ?? '';
  const rawUnit = args[3] ?? '';

  let value: string | null = null;
  if (rawVal && rawVal !== '$') {
    value = decodeArg(rawVal);
  }

  let unit: string | null = null;
  if (rawUnit && rawUnit !== '$') {
    // Unit is usually a ref (#id) to an IfcNamedUnit — we can't resolve it here,
    // but if it's a direct label or enum we capture it.
    if (!rawUnit.startsWith('#')) {
      unit = decodeArg(rawUnit);
    }
  }

  return { value, unit };
}

/**
 * Decode a STEP value-list token `(IFCLABEL('a'),IFCLABEL('b'))` or a bare
 * `('a','b')` into a comma-joined display string. Returns null if empty.
 * Used for IfcPropertyEnumeratedValue / IfcPropertyListValue.
 */
function decodeValueList(raw: string): string | null {
  if (!raw || raw === '$' || !raw.startsWith('(')) return null;
  const inner = raw.slice(1, -1);
  if (!inner.trim()) return null;
  const parts = splitArgs(inner).map(decodeArg).filter((v): v is string => v !== null);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Decode the display value for any IfcProperty* subtype (beyond SingleValue).
 * All map onto the shared propValue/propUnit fields the properties panel reads.
 *   IfcPropertyEnumeratedValue [2]=values(list)        [3]=enum ref (skip)
 *   IfcPropertyListValue       [2]=values(list)        [3]=unit
 *   IfcPropertyBoundedValue    [2]=upper [3]=lower      [4]=unit
 *   IfcPropertyReferenceValue  [2]=usageName           [3]=ref (skip)
 *   IfcComplexProperty         [2]=usageName           [3]=props(list, via triples)
 *   IfcPropertyTableValue      [2]=definingValues(list)
 */
export function decodePropertySubtypeValue(
  type: string,
  args: string[],
): { value: string | null; unit: string | null } {
  const unitFrom = (idx: number): string | null => {
    const u = args[idx] ?? '';
    return u && u !== '$' && !u.startsWith('#') ? decodeArg(u) : null;
  };
  switch (type) {
    case 'IFCPROPERTYENUMERATEDVALUE':
      return { value: decodeValueList(args[2] ?? ''), unit: null };
    case 'IFCPROPERTYLISTVALUE':
      return { value: decodeValueList(args[2] ?? ''), unit: unitFrom(3) };
    case 'IFCPROPERTYBOUNDEDVALUE': {
      const upper = decodeArg(args[2] ?? '');
      const lower = decodeArg(args[3] ?? '');
      const unit = unitFrom(4);
      if (upper === null && lower === null) return { value: null, unit };
      return { value: `${lower ?? '−∞'} … ${upper ?? '+∞'}`, unit };
    }
    case 'IFCPROPERTYTABLEVALUE':
      return { value: decodeValueList(args[2] ?? ''), unit: null };
    case 'IFCPROPERTYREFERENCEVALUE':
      // arg[2]=UsageName (label); the referenced value is a #ref resolved elsewhere
      return { value: decodeArg(args[2] ?? ''), unit: null };
    case 'IFCCOMPLEXPROPERTY':
      // Child properties surface as their own rows via the hasProperty triples.
      return { value: decodeArg(args[2] ?? ''), unit: null };
    default:
      return { value: null, unit: null };
  }
}

/** Decode one wrapped STEP value, keeping its IFC measure wrapper and unit slot. */
function decodeTypedValue(
  raw: string,
  args: string[],
  unitArgIndex: number | null,
): PropertySubtypeValue | null {
  if (!raw || raw === '$' || raw === '*') return null;
  const value = decodeArg(raw);
  if (value === null) return null;
  const wrapper = raw.match(/^([A-Z0-9_]+)\s*\(/);
  return {
    value,
    measure: wrapper?.[1] ?? null,
    unitRef: unitArgIndex !== null ? refId(args[unitArgIndex] ?? '') : null,
  };
}

/**
 * Every authored value of a multi-valued IfcProperty* subtype, so the IDS
 * property facet can test each one: with a simple IDS value, at least one IFC
 * value must match (UserManual/property-facet.md). Each value keeps the IFC
 * measure it was wrapped in and the record arg index of the unit that applies,
 * so the extractor can SI-normalize it per value.
 *
 *   IfcPropertyEnumeratedValue [2]=values
 *   IfcPropertyListValue       [2]=values, unit [3]
 *   IfcPropertyBoundedValue    [2]=upper [3]=lower [5]=setpoint, unit [4]
 *   IfcPropertyTableValue      [2]=definingValues (unit [5]),
 *                              [3]=definedValues  (unit [6])
 *
 * Single-valued and unsupported (reference / complex) subtypes return [].
 */
export function decodePropertySubtypeValues(
  type: string,
  args: string[],
): PropertySubtypeValue[] {
  const list = (raw: string, unitArgIndex: number | null): PropertySubtypeValue[] => {
    if (!raw || raw === '$' || !raw.startsWith('(')) return [];
    return splitArgs(raw.slice(1, -1))
      .map((token) => decodeTypedValue(token, args, unitArgIndex))
      .filter((v): v is PropertySubtypeValue => v !== null);
  };
  const one = (raw: string, unitArgIndex: number | null): PropertySubtypeValue[] => {
    const v = decodeTypedValue(raw, args, unitArgIndex);
    return v ? [v] : [];
  };
  switch (type) {
    case 'IFCPROPERTYENUMERATEDVALUE':
      return list(args[2] ?? '', null);
    case 'IFCPROPERTYLISTVALUE':
      return list(args[2] ?? '', 3);
    case 'IFCPROPERTYBOUNDEDVALUE':
      return [
        ...one(args[2] ?? '', 4),
        ...one(args[3] ?? '', 4),
        ...one(args[5] ?? '', 4),
      ];
    case 'IFCPROPERTYTABLEVALUE':
      return [
        ...list(args[2] ?? '', 5),
        ...list(args[3] ?? '', 6),
      ];
    default:
      return [];
  }
}

/**
 * Multi-valued property values read from a web-ifc typed line. The positional
 * `args` string cannot supply these reliably: web-ifc decodes a measure to a
 * bare real and drops its wrapper, so only the named attribute keeps the IFC
 * measure (IFCLENGTHMEASURE, …) needed to SI-normalize each value.
 */
export function decodePropertySubtypeValuesFromLine(
  type: string,
  line: TypedLine,
): PropertySubtypeValue[] {
  const values = (attr: unknown, unitRef: number | null): PropertySubtypeValue[] => {
    const items = Array.isArray(attr) ? attr : [attr];
    return items
      .map((item) => readTypedValue(item))
      .filter((v): v is { value: string; measure: string | null } => v !== null)
      .map((v) => ({ value: v.value, measure: v.measure, unitRef }));
  };
  const unit = readRef(line, 'Unit');
  switch (type) {
    case 'IFCPROPERTYENUMERATEDVALUE':
      return values(line.EnumerationValues, null);
    case 'IFCPROPERTYLISTVALUE':
      return values(line.ListValues, unit);
    case 'IFCPROPERTYBOUNDEDVALUE':
      return [
        ...values(line.UpperBoundValue, unit),
        ...values(line.LowerBoundValue, unit),
        ...values(line.SetPointValue, unit),
      ];
    case 'IFCPROPERTYTABLEVALUE':
      return [
        ...values(line.DefiningValues, readRef(line, 'DefiningUnit')),
        ...values(line.DefinedValues, readRef(line, 'DefinedUnit')),
      ];
    default:
      return [];
  }
}

/** Quantity value arg positions per IfcQuantity* subtype */
const QTY_VALUE_ARG: Record<string, number> = {
  IFCQUANTITYLENGTH:  3,
  IFCQUANTITYAREA:    3,
  IFCQUANTITYVOLUME:  3,
  IFCQUANTITYCOUNT:   3,
  IFCQUANTITYWEIGHT:  3,
  IFCQUANTITYTIME:    3,
  IFCQUANTITYNUMBER:  3,
};

export function decodeQtyValue(type: string, args: string[]): { value: string | null; unit: string | null } {
  const valIdx = QTY_VALUE_ARG[type];
  if (valIdx === undefined) return { value: null, unit: null };
  const raw = args[valIdx] ?? '';
  const value = raw && raw !== '$' ? decodeArg(raw) : null;
  // Unit is arg[2] for all IfcQuantity* — also usually a ref, captured if inline
  const rawUnit = args[2] ?? '';
  const unit = rawUnit && rawUnit !== '$' && !rawUnit.startsWith('#') ? decodeArg(rawUnit) : null;
  return { value, unit };
}

/**
 * Tokenize a full IFC text into RawRecord[] plus the schema identifier.
 * This is the main entry point for synchronous (≤50 MB) parsing.
 */
export function tokenize(text: string): { records: RawRecord[]; schema: string } {
  const schema = detectSchema(text);
  const acc = new StepAccumulator();
  const records: RawRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const rec = acc.feed(line);
    if (rec) records.push(rec);
  }
  return { records, schema };
}

const PROP_SINGLE_VALUE = 'IFCPROPERTYSINGLEVALUE';
const QTY_TYPES = new Set(Object.keys(QTY_VALUE_ARG));
/** IfcProperty* subtypes (other than SingleValue) that carry a displayable value */
const PROP_SUBTYPES = new Set([
  'IFCPROPERTYENUMERATEDVALUE', 'IFCPROPERTYLISTVALUE', 'IFCPROPERTYBOUNDEDVALUE',
  'IFCPROPERTYTABLEVALUE', 'IFCPROPERTYREFERENCEVALUE', 'IFCCOMPLEXPROPERTY',
]);

/** IfcProperty* subtype → typed-line attribute whose value type the IDS compares. */
const PROP_VALUE_TYPE_ATTR: Record<string, string> = {
  IFCPROPERTYENUMERATEDVALUE: 'EnumerationValues',
  IFCPROPERTYLISTVALUE:       'ListValues',
  IFCPROPERTYBOUNDEDVALUE:    'UpperBoundValue',
  IFCPROPERTYTABLEVALUE:      'DefiningValues',
};

/** IfcQuantity* subtype → typed-line attribute holding the numeric value. */
const QTY_VALUE_ATTR: Record<string, string> = {
  IFCQUANTITYLENGTH: 'LengthValue',
  IFCQUANTITYAREA:   'AreaValue',
  IFCQUANTITYVOLUME: 'VolumeValue',
  IFCQUANTITYCOUNT:  'CountValue',
  IFCQUANTITYWEIGHT: 'WeightValue',
  IFCQUANTITYTIME:   'TimeValue',
  IFCQUANTITYNUMBER: 'NumberValue',
};

// ---------------------------------------------------------------------------
// Raw-attribute extraction (Properties panel "All Attributes" section)
// ---------------------------------------------------------------------------

/**
 * Keys web-ifc adds to a typed line that are not schema attributes — excluded
 * from the raw-attribute list so it reflects only the entity's real fields.
 */
const NON_ATTR_LINE_KEYS = new Set(['expressID', 'type']);

/**
 * Summarise a nested SET/LIST arg (already boxed by web-ifc).
 *
 * Returns BOTH representations:
 *   - `value`  — an abbreviated display string (`#1, #2 (+3)`) for the panel;
 *   - `values` — every member, untruncated, for `entity_attributes` ingest.
 *
 * Keeping the full list matters because an IDS attribute facet compares against
 * a single stored value: with only the truncated summary, `Roles = 'ARCHITECT'`
 * could never match a list rendered as `ARCHITECT, ENGINEER (+2)`.
 */
function summariseList(
  arr: unknown[],
): { ref: number | null; value: string | null; values: string[] } {
  if (arr.length === 0) return { ref: null, value: '()', values: [] };
  const parts = arr.map(item => {
    if (isRefHandle(item)) return `#${item.value as number}`;
    const v = unwrap(item);
    if (v === null) return '$';
    if (typeof v === 'object') return '(…)';
    return String(v);
  });
  const shown = parts.slice(0, 4).join(', ');
  const extra = parts.length > 4 ? ` (+${parts.length - 4})` : '';
  return { ref: null, value: shown + extra, values: parts };
}

function isRefHandle(v: unknown): v is { type: number; value: unknown } {
  return typeof v === 'object' && v !== null && (v as { type?: number }).type === 5 /* REF */;
}

/** Build the ordered raw-attribute list from a web-ifc typed line. */
function rawAttributesFromLine(line: TypedLine): RawAttribute[] {
  const out: RawAttribute[] = [];
  for (const [name, raw] of Object.entries(line)) {
    if (NON_ATTR_LINE_KEYS.has(name)) continue;
    if (raw === null || raw === undefined) {
      out.push({ name, ref: null, value: null });
      continue;
    }
    if (Array.isArray(raw)) {
      const { ref, value, values } = summariseList(raw);
      out.push({ name, ref, value, values });
      continue;
    }
    if (isRefHandle(raw)) {
      const id = (raw as { value: unknown }).value;
      out.push({ name, ref: typeof id === 'number' ? id : null, value: typeof id === 'number' ? `#${id}` : null });
      continue;
    }
    const v = unwrap(raw);
    if (v === null || typeof v === 'object') {
      out.push({ name, ref: null, value: null });
    } else if (typeof v === 'boolean') {
      out.push({ name, ref: null, value: v ? 'TRUE' : 'FALSE' });
    } else {
      const s = String(v).trim();
      out.push({ name, ref: null, value: s === '' ? null : s });
    }
  }
  return out;
}

/** Fallback: build raw attributes from positional STEP arg tokens. */
function rawAttributesFromArgs(args: string[]): RawAttribute[] {
  return args.map((raw, i) => {
    const ref = refId(raw);
    return { name: `[${i}]`, ref, value: ref !== null ? `#${ref}` : decodeArg(raw) };
  });
}

/**
 * Build a fully-enriched IfcEntity from a RawRecord.
 *
 * When the record carries a web-ifc typed line (`rec.line`), all scalar fields
 * are read by **named attribute** — schema-robust, no positional guessing
 * (ADR-009). The positional `args` helpers remain as a fallback for records
 * without a typed line (legacy string path / tests).
 */
export function recordToEntity(rec: RawRecord): IfcEntity {
  const args = splitArgs(rec.args);
  const type = rec.type;
  const line = rec.line;

  const entity: IfcEntity = {
    id: rec.id,
    type,
    // `Name` is the schema attribute on IfcRoot, IfcProperty*, IfcMaterial*,
    // IfcPhysicalQuantity alike — reading it by name retires the NAME_AT_ARG0 map.
    name: line ? readString(line, 'Name') : extractName(type, args),
  };

  const globalId = line ? readString(line, 'GlobalId') : extractGlobalId(args);
  if (globalId) entity.globalId = globalId;

  const description = line ? readString(line, 'Description') : extractDescription(args);
  if (description) entity.description = description;

  const objectType = line ? readString(line, 'ObjectType') : extractObjectType(type, args);
  if (objectType) entity.objectType = objectType;

  const identification = line ? readString(line, 'Identification') : extractIdentification(type, args);
  if (identification) entity.identification = identification;

  const tag = line ? readString(line, 'Tag') : extractTag(type, args);
  if (tag) entity.tag = tag;

  const predefinedType = line ? readEnum(line, 'PredefinedType') : extractPredefinedType(args);
  if (predefinedType) entity.predefinedType = predefinedType;

  const longName = line ? readString(line, 'LongName') : extractLongName(type, args);
  if (longName) entity.longName = longName;

  // '' reads as null above; remember which were authored empty (IDS: present, not absent)
  if (line) {
    const empty = ['Name', 'GlobalId', 'Description', 'ObjectType', 'Identification', 'Tag', 'LongName']
      .filter((k) => isEmptyString(line, k))
      .map((k) => k.toLowerCase());
    if (empty.length) entity.emptyAttrs = empty;
  }

  // Typed property value (IfcPropertySingleValue)
  if (type === PROP_SINGLE_VALUE) {
    const { value, unit } = line ? decodePropValueTyped(line) : decodePropValue(args);
    if (value !== null) entity.propValue = value;
    if (unit !== null) entity.propUnit = unit;
    // The value's IFC type (IFCLENGTHMEASURE, IFCLABEL, …) — web-ifc keeps it in
    // the value box's `name`; the legacy tokenizer path still spells it as a cast.
    const valueType = (line ? readValueType(line, 'NominalValue') : null) ?? typeCastName(args[2]);
    if (valueType !== null) entity.propType = valueType;
  } else if (PROP_SUBTYPES.has(type)) {
    // Other IfcProperty* subtypes — enumerated, list, bounded, table, reference, complex.
    // These carry nested value lists/refs that the typed line does not flatten,
    // so the positional decoder (which already handles them) stays authoritative.
    const { value, unit } = decodePropertySubtypeValue(type, args);
    if (value !== null) entity.propValue = value;
    if (unit !== null) entity.propUnit = unit;
    // Keep every authored value for the IDS property facet, which must test
    // each one (property-facet.md). Prefer the typed line: it retains each
    // value's IFC measure wrapper, which web-ifc drops from the args.
    const values = line
      ? decodePropertySubtypeValuesFromLine(type, line)
      : decodePropertySubtypeValues(type, args);
    if (values.length > 0) entity.propValues = values;
    const attr = PROP_VALUE_TYPE_ATTR[type];
    const valueType = (line && attr ? readValueType(line, attr) : null) ?? typeCastName(args[2]);
    if (valueType !== null) entity.propType = valueType;
  }

  // Typed quantity value (IfcQuantity*)
  if (QTY_TYPES.has(type)) {
    const { value, unit } = line ? decodeQtyValueTyped(type, line) : decodeQtyValue(type, args);
    if (value !== null) entity.qtyValue = value;
    if (unit !== null) entity.qtyUnit = unit;
    const attr = QTY_VALUE_ATTR[type];
    const valueType = (line && attr ? readValueType(line, attr) : null) ?? typeCastName(args[QTY_VALUE_ARG[type] ?? -1]);
    if (valueType !== null) entity.qtyType = valueType;
  }

  // Full attribute list for the Properties panel — prefer named attributes from
  // the typed line; fall back to positional args (legacy string path / tests).
  const rawAttributes = line ? rawAttributesFromLine(line) : rawAttributesFromArgs(args);
  if (rawAttributes.length) entity.rawAttributes = rawAttributes;

  return entity;
}

/**
 * The IFC type-cast name at the head of a raw STEP value token, e.g.
 * `IFCLENGTHMEASURE(2.)` → `IFCLENGTHMEASURE`. Null when the token is a bare
 * literal (`'foo'`, `42.`, `$`) or a reference. Used only on the legacy
 * tokenizer path; the web-ifc path reads the type from the value box's `name`.
 */
function typeCastName(raw: string | undefined): string | null {
  if (!raw) return null;
  // A single value is `IFCLABEL('x')`; a value list is `(IFCLABEL('a'),…)` —
  // take the first type-cast in either.
  const m = /([A-Z][A-Z0-9_]*)\(/.exec(raw);
  return m ? m[1]! : null;
}

/**
 * Decode IfcPropertySingleValue.NominalValue from a typed line.
 * The unit (`Unit`) is a `#ref` to an IfcNamedUnit; it is resolved per-model in
 * the unit-resolution pass (PB-B), not here.
 */
function decodePropValueTyped(line: TypedLine): { value: string | null; unit: string | null } {
  const raw = readScalar(line, 'NominalValue');
  return { value: raw, unit: null };
}

/** Decode an IfcQuantity* numeric value from its typed attribute. */
function decodeQtyValueTyped(type: string, line: TypedLine): { value: string | null; unit: string | null } {
  const attr = QTY_VALUE_ATTR[type];
  if (!attr) return { value: null, unit: null };
  return { value: readScalar(line, attr), unit: null };
}

/**
 * Read a value attribute (NominalValue / *Value) as a display string. Unlike
 * {@link readString} this accepts numbers and booleans (a property value may be
 * any IfcValue), but still rejects refs and nested objects.
 */
function readScalar(line: TypedLine, key: string): string | null {
  const v = unwrap((line as Record<string, unknown>)[key]);
  if (v === null || typeof v === 'object') return null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = String(v).trim();
  return s === '' ? null : s;
}
