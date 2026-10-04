import { describe, it, expect } from 'vitest';
import { predefinedPropertyRows } from './ingest.js';
import type { IfcEntity, RawAttribute } from '../parser/types.js';

function pset(rawAttributes: RawAttribute[]): IfcEntity {
  return { id: 8, type: 'IFCDOORPANELPROPERTIES', name: 'Foo_Bar', rawAttributes };
}

describe('predefinedPropertyRows', () => {
  // Values mirror the web-ifc typed line of an IfcDoorPanelProperties
  // (pass-predefined_properties_are_supported_but_discouraged_1_2.ifc).
  it('exposes the schema attributes by name and skips IfcRoot fields', () => {
    const rows = predefinedPropertyRows(
      pset([
        { name: 'GlobalId', ref: null, value: '16MocU_IDOF8_x3Iqllz0d' },
        { name: 'OwnerHistory', ref: null, value: null },
        { name: 'Name', ref: null, value: 'Foo_Bar' },
        { name: 'Description', ref: null, value: null },
        { name: 'PanelDepth', ref: null, value: null },
        { name: 'PanelOperation', ref: null, value: 'SWINGING' },
        { name: 'PanelWidth', ref: null, value: null },
        { name: 'PanelPosition', ref: null, value: 'LEFT' },
        { name: 'ShapeAspectStyle', ref: 42, value: '#42' },
      ]),
    );
    expect(rows).toEqual([
      { name: 'PanelOperation', value: 'SWINGING' },
      { name: 'PanelPosition', value: 'LEFT' },
    ]);
  });

  it('skips empty and value-less attributes, and fans a SET/LIST out per member', () => {
    const rows = predefinedPropertyRows(
      pset([
        { name: 'PanelOperation', ref: null, value: '' },
        { name: 'PanelWidth', ref: null, value: null },
        { name: 'SomeList', ref: null, value: 'A, B (+1)', values: ['A', 'B', 'C'] },
      ]),
    );
    expect(rows).toEqual([
      { name: 'SomeList', value: 'A' },
      { name: 'SomeList', value: 'B' },
      { name: 'SomeList', value: 'C' },
    ]);
  });
});
