import { describe, it, expect } from 'vitest';
import { unwrap, readString, readEnum, readRef, type TypedLine } from './typed-line.js';
import { recordToEntity, type RawRecord } from './tokenizer.js';

// web-ifc value/enum/handle box shapes.
const label = (v: string) => ({ value: v, type: 1, name: 'IfcLabel' });
const enumTok = (v: string) => ({ value: v, type: 3 });
const ref = (id: number) => ({ value: id, type: 5 });
const real = (v: number) => ({ value: v, type: 4, name: 'IfcReal' });

describe('typed-line readers', () => {
  it('unwraps boxed values, leaves primitives, maps null', () => {
    expect(unwrap(label('Wall-01'))).toBe('Wall-01');
    expect(unwrap(real(2.5))).toBe(2.5);
    expect(unwrap(null)).toBeNull();
    expect(unwrap(42)).toBe(42);
  });

  it('readString rejects refs and empty strings', () => {
    const line: TypedLine = { Name: label('Basic Wall'), Placement: ref(99), Blank: label('  ') };
    expect(readString(line, 'Name')).toBe('Basic Wall');
    expect(readString(line, 'Placement')).toBeNull(); // a handle is never a field value
    expect(readString(line, 'Blank')).toBeNull();
    expect(readString(line, 'Missing')).toBeNull();
  });

  it('readEnum returns enum literals as-is, including NOTDEFINED / USERDEFINED', () => {
    // NOTDEFINED / USERDEFINED are valid IFC enum values — the attribute is
    // defined in the IFC sense, so they are kept (not dropped to null).
    expect(readEnum({ PredefinedType: enumTok('STANDARD') }, 'PredefinedType')).toBe('STANDARD');
    expect(readEnum({ PredefinedType: enumTok('NOTDEFINED') }, 'PredefinedType')).toBe('NOTDEFINED');
    expect(readEnum({ PredefinedType: enumTok('USERDEFINED') }, 'PredefinedType')).toBe('USERDEFINED');
  });

  it('readRef returns the express id a handle points to', () => {
    expect(readRef({ Unit: ref(17) }, 'Unit')).toBe(17);
    expect(readRef({ Unit: label('x') }, 'Unit')).toBeNull();
  });
});

describe('recordToEntity — typed line path (schema-robust)', () => {
  // A typed line gives named attributes regardless of arg order. The `args`
  // string is deliberately empty here to prove fields come from the typed line,
  // not from positional parsing.
  it('extracts Tag and PredefinedType by name, not by arg index', () => {
    const rec: RawRecord = {
      id: 42,
      type: 'IFCWALL',
      args: '',
      line: {
        GlobalId: label('3vB2_xQ...'),
        Name: label('Basic Wall:Interior'),
        Tag: label('331874'),
        PredefinedType: enumTok('SOLIDWALL'),
      },
    };
    const e = recordToEntity(rec);
    expect(e.name).toBe('Basic Wall:Interior');
    expect(e.globalId).toBe('3vB2_xQ...');
    expect(e.tag).toBe('331874');
    expect(e.predefinedType).toBe('SOLIDWALL');
  });

  it('reads Name at the same attribute for a property (no NAME_AT_ARG0 split)', () => {
    const rec: RawRecord = {
      id: 7,
      type: 'IFCPROPERTYSINGLEVALUE',
      args: '',
      line: { Name: label('FireRating'), NominalValue: label('2HR'), Unit: ref(5) },
    };
    const e = recordToEntity(rec);
    expect(e.name).toBe('FireRating');
    expect(e.propValue).toBe('2HR');
    // Unit is a #ref resolved in PB-B, never captured as an inline label here.
    expect(e.propUnit ?? null).toBeNull();
  });

  it('decodes a numeric quantity value from its typed attribute', () => {
    const rec: RawRecord = {
      id: 9,
      type: 'IFCQUANTITYAREA',
      args: '',
      line: { Name: label('NetSideArea'), Unit: ref(3), AreaValue: real(12.5) },
    };
    const e = recordToEntity(rec);
    expect(e.qtyValue).toBe('12.5');
  });
});
