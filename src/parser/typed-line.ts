/**
 * Helpers for reading web-ifc `GetLine` typed line objects by **named attribute**
 * instead of positional STEP arg indices (ADR-009, PB-A).
 *
 * `IfcAPI.GetLine(modelID, expressID)` returns a plain object whose keys are the
 * schema attribute names (`Name`, `Tag`, `PredefinedType`, `LongName`, …). Each
 * value is one of:
 *
 *   - a measure/simple-value wrapper:  `{ value: 'Foo', type, name }`  (IfcLabel,
 *     IfcReal, IfcText, IfcIdentifier, IfcBoolean, IfcLengthMeasure, …)
 *   - an enum token:                   `{ type: 3 /* ENUM *\/, value: 'STANDARD' }`
 *   - a `Handle<T>`:                   `{ value: 123, type: 5 /* REF *\/ }`  (an
 *     express-ID reference to another line)
 *   - a nested array (SET / LIST)
 *   - `null` (`$`) or `undefined` (`*`, derived)
 *
 * Because attributes are read by name, the same code is correct across
 * IFC2X3 / IFC4 / IFC4X3 — there is no `[7]/[8]/[9]` Tag guessing or
 * "scan the last four args for an enum" PredefinedType heuristic.
 */

/** A web-ifc typed line object as returned by `GetLine` (named attributes). */
export type TypedLine = Record<string, unknown> & { expressID?: number; type?: number };

/** True for the boxed objects web-ifc returns for values, enums, and handles. */
function isBoxed(v: unknown): v is { value?: unknown; type?: number } {
  return typeof v === 'object' && v !== null && 'value' in (v as object);
}

/**
 * Unwrap a typed attribute to its primitive value.
 *   wrapper/enum/handle → its `.value`;  primitive → itself;  null/$ → null.
 * Handles (refs) return their numeric express ID — callers that want a *field*
 * value should use {@link readString} / {@link readEnum}, which reject refs.
 */
export function unwrap(attr: unknown): unknown {
  if (attr === null || attr === undefined) return null;
  if (isBoxed(attr)) return attr.value ?? null;
  return attr;
}

/**
 * Read a string-ish attribute (IfcLabel / IfcText / IfcIdentifier) as a plain
 * string. Returns null for missing values, refs (handles), and empty strings.
 */
export function readString(line: TypedLine | undefined, key: string): string | null {
  if (!line) return null;
  const raw = line[key];
  if (raw === null || raw === undefined) return null;
  // A Handle (REF token, type 5) is an express-ID reference, never a field value.
  if (isBoxed(raw) && raw.type === 5 /* REF */) return null;
  const v = unwrap(raw);
  if (v === null || typeof v === 'object') return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Whether a string attribute is authored as an empty (or blank) string, which readString returns as null */
export function isEmptyString(line: TypedLine | undefined, key: string): boolean {
  if (!line) return false;
  const raw = line[key];
  if (raw === null || raw === undefined) return false;
  if (isBoxed(raw) && raw.type === 5 /* REF */) return false;
  const v = unwrap(raw);
  return typeof v === 'string' && v.trim() === '';
}

/**
 * Read an enum attribute (PredefinedType, …) as its literal name.
 *
 * `NOTDEFINED` / `USERDEFINED` are valid IFC enum values and are returned as-is
 * (the attribute *is* defined in the IFC sense) — they are not dropped. Only a
 * genuinely absent (`$`) attribute yields null.
 */
export function readEnum(line: TypedLine | undefined, key: string): string | null {
  return readString(line, key);
}

/** Express ID a Handle attribute points to, or null when absent / not a ref. */
export function readRef(line: TypedLine | undefined, key: string): number | null {
  if (!line) return null;
  const raw = line[key];
  if (!isBoxed(raw)) return null;
  const v = raw.value;
  return typeof v === 'number' ? v : null;
}
