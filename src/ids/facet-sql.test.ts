import { describe, it, expect } from 'vitest';
import { facetToSql, facetToValueSql, restrictionToSql } from './facet-sql.js';
import type { IdsFacet } from './types.js';

describe('restrictionToSql', () => {
  it('undefined restriction → presence check', () => {
    expect(restrictionToSql('e.name', undefined)).toEqual({ sql: 'e.name IS NOT NULL', params: [] });
  });

  it('simpleValue → case-insensitive equality with bound param', () => {
    const p = restrictionToSql('e.name', { kind: 'simpleValue', value: 'Wall A' });
    expect(p.sql).toBe('lower(e.name) = lower(?)');
    expect(p.params).toEqual(['Wall A']);
  });

  it('enumeration → IN list with one bound param each', () => {
    const p = restrictionToSql('e.ifc_type', { kind: 'enumeration', values: ['IFCDOOR', 'IFCWINDOW'] });
    expect(p.sql).toBe('lower(e.ifc_type) IN (lower(?), lower(?))');
    expect(p.params).toEqual(['IFCDOOR', 'IFCWINDOW']);
  });

  it('empty enumeration → always false', () => {
    expect(restrictionToSql('e.ifc_type', { kind: 'enumeration', values: [] })).toEqual({ sql: '1=0', params: [] });
  });

  it('pattern → regexp_full_match (anchored like XSD), case-insensitive', () => {
    const p = restrictionToSql('e.name', { kind: 'pattern', pattern: '^FD\\d+$' });
    expect(p.sql).toBe("regexp_full_match(e.name, ?, 'i')");
    expect(p.params).toEqual(['^FD\\d+$']);
  });

  it('bounds → SI numeric column comparison, inclusivity respected', () => {
    const p = restrictionToSql('pp.value', {
      kind: 'bounds', min: 10, max: 20, minInclusive: true, maxInclusive: false,
    }, 'pp.value_si');
    expect(p.sql).toBe('pp.value_si >= ? AND pp.value_si < ?');
    expect(p.params).toEqual([10, 20]);
  });
});

describe('facetToSql', () => {
  it('entity facet with predefined type ANDs both columns', () => {
    const facet: IdsFacet = {
      kind: 'entity',
      name: { kind: 'simpleValue', value: 'IFCWALL' },
      predefinedType: { kind: 'simpleValue', value: 'SOLIDWALL' },
    };
    const p = facetToSql(facet);
    expect(p.sql).toContain('lower(e.ifc_type) = lower(?)');
    expect(p.sql).toContain('lower(e.predefined_type) = lower(?)');
    expect(p.params).toEqual(['IFCWALL', 'SOLIDWALL']);
  });

  it('non-Tier-1 attribute → EXISTS over entity_attributes, name bound', () => {
    const facet: IdsFacet = { kind: 'attribute', name: { kind: 'simpleValue', value: 'FamilyName' } };
    const p = facetToSql(facet);
    expect(p.sql).toContain('EXISTS (SELECT 1 FROM entity_attributes ea');
    expect(p.sql).toContain('lower(ea.attr_name) = lower(?)');
    expect(p.sql).toContain("ea.value != ''");
    expect(p.params).toEqual(['FamilyName']);
  });

  it('non-Tier-1 attribute with a value restriction binds name then value', () => {
    const facet: IdsFacet = {
      kind: 'attribute',
      name: { kind: 'simpleValue', value: 'Roles' },
      value: { kind: 'simpleValue', value: 'ARCHITECT' },
    };
    const p = facetToSql(facet);
    expect(p.sql).toContain('lower(ea.value) = lower(?)');
    expect(p.params).toEqual(['Roles', 'ARCHITECT']);
  });

  it('attribute with a non-simpleValue name → always false (nothing to look up)', () => {
    const facet: IdsFacet = { kind: 'attribute', name: { kind: 'pattern', pattern: '.*' } };
    expect(facetToSql(facet)).toEqual({ sql: '1=0', params: [] });
  });

  it('attribute presence check for a known Tier-1 column', () => {
    const facet: IdsFacet = { kind: 'attribute', name: { kind: 'simpleValue', value: 'Tag' } };
    const p = facetToSql(facet);
    expect(p.sql).toBe("(e.tag IS NOT NULL AND e.tag != '')");
    expect(p.params).toEqual([]);
  });

  it('presence check on PredefinedType compares the column (NOTDEFINED stored as a real value)', () => {
    const facet: IdsFacet = { kind: 'attribute', name: { kind: 'simpleValue', value: 'PredefinedType' } };
    const p = facetToSql(facet);
    // NOTDEFINED/USERDEFINED are stored (not dropped), so the standard non-null
    // presence check is correct — an entity with PredefinedType=NOTDEFINED passes.
    expect(p.sql).toBe("(e.predefined_type IS NOT NULL AND e.predefined_type != '')");
    expect(p.params).toEqual([]);
  });

  it('property facet → matches occurrence psets AND inherited type psets', () => {
    const facet: IdsFacet = {
      kind: 'property',
      propertySet: { kind: 'simpleValue', value: 'Pset_WallCommon' },
      baseName: { kind: 'simpleValue', value: 'IsExternal' },
      value: { kind: 'simpleValue', value: 'TRUE' },
    };
    const p = facetToSql(facet);
    // Direct occurrence pset EXISTS.
    expect(p.sql).toContain('FROM pset_properties pp');
    expect(p.sql).toContain('pp.entity_id = e.entity_id');
    // Type-inherited pset EXISTS via IfcRelDefinesByType (type = subject).
    expect(p.sql).toContain("dt.predicate = 'IfcRelDefinesByType'");
    expect(p.sql).toContain('dt.object = e.entity_id');
    expect(p.sql).toContain('tp.entity_id = dt.subject');
    // Params: the filter is emitted twice (direct then type), in that order.
    expect(p.params).toEqual([
      'Pset_WallCommon', 'IsExternal', 'TRUE',
      'Pset_WallCommon', 'IsExternal', 'TRUE',
    ]);
  });

  it('classification facet → EXISTS over classifications view', () => {
    const facet: IdsFacet = {
      kind: 'classification',
      system: { kind: 'simpleValue', value: 'Uniclass 2015' },
      value: { kind: 'simpleValue', value: 'EF_25_10' },
    };
    const p = facetToSql(facet);
    expect(p.sql).toContain('EXISTS (SELECT 1 FROM classifications cl');
    expect(p.params).toEqual(['Uniclass 2015', 'EF_25_10']);
  });

  it('material facet with no value → EXISTS any material', () => {
    const p = facetToSql({ kind: 'material' });
    expect(p.sql).toContain('EXISTS (SELECT 1 FROM materials mat');
    expect(p.params).toEqual([]);
  });

  it('partOf facet → OR of both edge directions', () => {
    const facet: IdsFacet = {
      kind: 'partOf',
      relation: 'IFCRELAGGREGATES',
      entity: { kind: 'entity', name: { kind: 'simpleValue', value: 'IFCBUILDINGSTOREY' } },
    };
    const p = facetToSql(facet);
    // Both directions present, relation bound twice, whole-type bound twice.
    expect((p.sql.match(/EXISTS/g) ?? []).length).toBe(2);
    expect(p.params).toEqual(['IFCRELAGGREGATES', 'IFCBUILDINGSTOREY', 'IFCRELAGGREGATES', 'IFCBUILDINGSTOREY']);
  });
});

describe('facetToValueSql', () => {
  it('attribute facet → the Tier-1 column itself, no params', () => {
    const facet: IdsFacet = { kind: 'attribute', name: { kind: 'simpleValue', value: 'Name' } };
    const v = facetToValueSql(facet);
    expect(v).toEqual({ sql: 'e.name', params: [] });
  });

  it('non-Tier-1 attribute → correlated subquery over entity_attributes', () => {
    const facet: IdsFacet = { kind: 'attribute', name: { kind: 'simpleValue', value: 'FamilyName' } };
    const v = facetToValueSql(facet);
    expect(v).not.toBeNull();
    // A SET/LIST attribute is stored one row per member, so the reported value
    // aggregates the members rather than picking an arbitrary one via LIMIT 1.
    expect(v!.sql).toContain("string_agg(ea.value, ', ') FROM entity_attributes ea");
    expect(v!.sql).toContain('lower(ea.attr_name) = lower(?)');
    expect(v!.sql).not.toContain('LIMIT 1');
    expect(v!.params).toEqual(['FamilyName']);
  });

  it('attribute with a non-simpleValue name → null (no scalar to report)', () => {
    const facet: IdsFacet = { kind: 'attribute', name: { kind: 'pattern', pattern: '.*' } };
    expect(facetToValueSql(facet)).toBeNull();
  });

  it('property facet → COALESCE of occurrence then type-inherited value', () => {
    const facet: IdsFacet = {
      kind: 'property',
      propertySet: { kind: 'simpleValue', value: 'Pset_WallCommon' },
      baseName: { kind: 'simpleValue', value: 'IsExternal' },
    };
    const v = facetToValueSql(facet);
    expect(v).not.toBeNull();
    expect(v!.sql).toContain('COALESCE(');
    expect(v!.sql).toContain('SELECT pp.value FROM pset_properties pp');
    expect(v!.sql).toContain("dt.predicate = 'IfcRelDefinesByType'");
    // pset + property name bound once per branch (occurrence then type).
    expect(v!.params).toEqual(['Pset_WallCommon', 'IsExternal', 'Pset_WallCommon', 'IsExternal']);
  });

  it('set-membership facets have no scalar value → null', () => {
    expect(facetToValueSql({ kind: 'material' })).toBeNull();
    expect(facetToValueSql({ kind: 'classification' })).toBeNull();
    expect(facetToValueSql({ kind: 'entity', name: { kind: 'simpleValue', value: 'IFCWALL' } })).toBeNull();
    expect(facetToValueSql({ kind: 'partOf', relation: 'IFCRELAGGREGATES' })).toBeNull();
  });
});
