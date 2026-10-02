import { describe, it, expect } from 'vitest';
import { parseIds } from './parse-ids.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info>
    <title>Sample IDS</title>
    <author>tester@example.com</author>
    <date>2026-07-04</date>
  </info>
  <specifications>
    <specification name="Walls must be external" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>IsExternal</simpleValue></baseName>
          <value><simpleValue>TRUE</simpleValue></value>
        </property>
        <attribute minOccurs="0">
          <name><simpleValue>Tag</simpleValue></name>
        </attribute>
        <classification maxOccurs="0">
          <system><simpleValue>Uniclass 2015</simpleValue></system>
        </classification>
      </requirements>
    </specification>
    <specification name="Doors fire rated">
      <applicability>
        <entity>
          <name>
            <xs:restriction xmlns:xs="http://www.w3.org/2001/XMLSchema" base="xs:string">
              <xs:enumeration value="IFCDOOR"/>
              <xs:enumeration value="IFCDOORTYPE"/>
            </xs:restriction>
          </name>
        </entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_DoorCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;

describe('parseIds', () => {
  it('reads document info + specification count', () => {
    const doc = parseIds(SAMPLE, 'fallback.ids');
    expect(doc.title).toBe('Sample IDS');
    expect(doc.author).toBe('tester@example.com');
    expect(doc.specifications).toHaveLength(2);
  });

  it('parses entity applicability facet with simpleValue', () => {
    const doc = parseIds(SAMPLE);
    const spec = doc.specifications[0]!;
    expect(spec.name).toBe('Walls must be external');
    expect(spec.ifcVersion).toEqual(['IFC4']);
    const appl = spec.applicability[0]!;
    expect(appl.kind).toBe('entity');
    if (appl.kind === 'entity') {
      expect(appl.name).toEqual({ kind: 'simpleValue', value: 'IFCWALL' });
    }
  });

  it('parses property requirement with value restriction', () => {
    const spec = parseIds(SAMPLE).specifications[0]!;
    const prop = spec.requirements[0]!;
    expect(prop.cardinality).toBe('required');
    expect(prop.facet.kind).toBe('property');
    if (prop.facet.kind === 'property') {
      expect(prop.facet.propertySet).toEqual({ kind: 'simpleValue', value: 'Pset_WallCommon' });
      expect(prop.facet.baseName).toEqual({ kind: 'simpleValue', value: 'IsExternal' });
      expect(prop.facet.value).toEqual({ kind: 'simpleValue', value: 'TRUE' });
    }
  });

  it('maps minOccurs=0 to optional and maxOccurs=0 to prohibited', () => {
    const reqs = parseIds(SAMPLE).specifications[0]!.requirements;
    expect(reqs[1]!.cardinality).toBe('optional');       // attribute minOccurs=0
    expect(reqs[2]!.cardinality).toBe('prohibited');     // classification maxOccurs=0
  });

  it('reads the explicit cardinality="…" attribute (real authoring tools)', () => {
    const doc = parseIds(`
      <ids xmlns="http://standards.buildingsmart.org/IDS">
        <specifications>
          <specification name="s">
            <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
            <requirements>
              <attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute>
              <attribute cardinality="optional"><name><simpleValue>Tag</simpleValue></name></attribute>
              <attribute cardinality="prohibited"><name><simpleValue>Description</simpleValue></name></attribute>
            </requirements>
          </specification>
        </specifications>
      </ids>`);
    const reqs = doc.specifications[0]!.requirements;
    expect(reqs.map(r => r.cardinality)).toEqual(['required', 'optional', 'prohibited']);
  });

  it('defaults specification cardinality to required when applicability has no min/maxOccurs', () => {
    const doc = parseIds(SAMPLE);
    expect(doc.specifications[0]!.cardinality).toBe('required');
    expect(doc.specifications[1]!.cardinality).toBe('required');
  });

  it('reads specification cardinality from applicability minOccurs/maxOccurs', () => {
    const doc = parseIds(`
      <ids xmlns="http://standards.buildingsmart.org/IDS">
        <specifications>
          <specification name="required-spec">
            <applicability minOccurs="1" maxOccurs="unbounded">
              <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
            </applicability>
            <requirements/>
          </specification>
          <specification name="optional-spec">
            <applicability minOccurs="0" maxOccurs="unbounded">
              <entity><name><simpleValue>IFCDOOR</simpleValue></name></entity>
            </applicability>
            <requirements/>
          </specification>
          <specification name="prohibited-spec">
            <applicability minOccurs="0" maxOccurs="0">
              <entity><name><simpleValue>IFCBEAM</simpleValue></name></entity>
            </applicability>
            <requirements/>
          </specification>
        </specifications>
      </ids>`);
    expect(doc.specifications.map(s => s.cardinality)).toEqual(['required', 'optional', 'prohibited']);
  });

  it('parses xs:enumeration restriction', () => {
    const spec = parseIds(SAMPLE).specifications[1]!;
    const appl = spec.applicability[0]!;
    if (appl.kind === 'entity') {
      expect(appl.name).toEqual({ kind: 'enumeration', values: ['IFCDOOR', 'IFCDOORTYPE'] });
    }
  });

  it('falls back to provided title when info/title absent', () => {
    const doc = parseIds(
      `<ids xmlns="http://standards.buildingsmart.org/IDS"><specifications/></ids>`,
      'myfile.ids',
    );
    expect(doc.title).toBe('myfile.ids');
    expect(doc.specifications).toHaveLength(0);
  });

  it('throws on non-IDS root', () => {
    expect(() => parseIds(`<root/>`)).toThrow(/Not an IDS document/);
  });
});
