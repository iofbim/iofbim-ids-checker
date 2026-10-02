import { describe, it, expect } from 'vitest';
import { STRING, REF, ENUM } from 'web-ifc';
import { recordToEntity, type RawRecord } from './tokenizer.js';
import type { TypedLine } from './typed-line.js';

// recordToEntity attaches a full `rawAttributes` list (every direct STEP
// attribute in schema order) so the Properties panel can show all attributes,
// not just the curated Tier-1 fields.
describe('recordToEntity — rawAttributes', () => {
  it('builds named attributes from a web-ifc typed line, in order', () => {
    const line: TypedLine = {
      expressID: 5,
      type: 999,
      GlobalId: { type: STRING, value: '0aB1cD2eF3gH4iJ5kL6mN7' },
      OwnerHistory: { type: REF, value: 41 },
      Name: { type: STRING, value: 'Basic Wall' },
      Description: null,
      PredefinedType: { type: ENUM, value: 'SOLIDWALL' },
    };
    const rec: RawRecord = { id: 5, type: 'IFCWALL', args: '', line };
    const entity = recordToEntity(rec);

    expect(entity.rawAttributes).toBeDefined();
    // expressID / type are dropped; schema attributes keep declaration order.
    expect(entity.rawAttributes!.map(a => a.name)).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description', 'PredefinedType',
    ]);
  });

  it('keeps every member of a list attribute, not just the display summary', () => {
    // Six roles: the display string truncates at four, but `values` must carry
    // all six so an IDS facet on Roles can match the fifth or sixth member.
    const line: TypedLine = {
      expressID: 7, type: 999,
      Roles: ['ARCHITECT', 'ENGINEER', 'CONTRACTOR', 'CLIENT', 'CONSULTANT', 'SUPPLIER']
        .map(v => ({ type: STRING, value: v })),
    };
    const entity = recordToEntity({ id: 7, type: 'IFCORGANIZATION', args: '', line });
    const roles = entity.rawAttributes!.find(a => a.name === 'Roles')!;

    expect(roles.value).toBe('ARCHITECT, ENGINEER, CONTRACTOR, CLIENT (+2)');
    expect(roles.values).toEqual([
      'ARCHITECT', 'ENGINEER', 'CONTRACTOR', 'CLIENT', 'CONSULTANT', 'SUPPLIER',
    ]);
  });

  it('marks a #ref attribute so the panel can link it', () => {
    const line: TypedLine = {
      expressID: 5, type: 999,
      OwnerHistory: { type: REF, value: 41 },
    };
    const entity = recordToEntity({ id: 5, type: 'IFCWALL', args: '', line });
    const owner = entity.rawAttributes!.find(a => a.name === 'OwnerHistory')!;
    expect(owner.ref).toBe(41);
    expect(owner.value).toBe('#41');
  });

  it('renders a null ($) attribute as an empty value', () => {
    const line: TypedLine = { expressID: 5, type: 999, Description: null };
    const entity = recordToEntity({ id: 5, type: 'IFCWALL', args: '', line });
    const desc = entity.rawAttributes!.find(a => a.name === 'Description')!;
    expect(desc.ref).toBeNull();
    expect(desc.value).toBeNull();
  });

  it('falls back to positional args when no typed line is present', () => {
    // Legacy string path (tests / no web-ifc): index-labelled attributes.
    const rec: RawRecord = { id: 5, type: 'IFCWALL', args: "'0aB1cD',#41,'Basic Wall',$" };
    const entity = recordToEntity(rec);
    expect(entity.rawAttributes!.map(a => a.name)).toEqual(['[0]', '[1]', '[2]', '[3]']);
    expect(entity.rawAttributes![1]).toMatchObject({ ref: 41, value: '#41' });
    expect(entity.rawAttributes![2]!.value).toBe('Basic Wall');
    expect(entity.rawAttributes![3]!.value).toBeNull();
  });
});
