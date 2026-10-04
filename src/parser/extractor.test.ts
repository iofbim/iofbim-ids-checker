import { describe, it, expect } from 'vitest';
import { extractFromRecords } from './extractor.js';
import { tokenize, splitArgs, refId, listRefs, decodeStepString, stripTypeCast } from './tokenizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIfc(dataLines: string[]): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
}

/** Tokenize a raw IFC string and run extractFromRecords — used in all extractor tests */
function extract(text: string, filename = 'test.ifc') {
  const { records, schema } = tokenize(text);
  return extractFromRecords(records, schema, filename);
}

// ---------------------------------------------------------------------------
// tokenizer unit tests
// ---------------------------------------------------------------------------

describe('splitArgs', () => {
  it('splits simple args', () => {
    expect(splitArgs("'hello',#1,$")).toEqual(["'hello'", '#1', '$']);
  });

  it('respects nested parens', () => {
    expect(splitArgs('(#1,#2),#3')).toEqual(['(#1,#2)', '#3']);
  });

  it('handles escaped quotes inside strings', () => {
    expect(splitArgs("'it''s a test',$")).toEqual(["'it''s a test'", '$']);
  });

  it('handles type-cast values', () => {
    expect(splitArgs('IFCBOOLEAN(.T.),$')).toEqual(['IFCBOOLEAN(.T.)', '$']);
  });
});

describe('refId', () => {
  it('returns numeric id for #123', () => expect(refId('#123')).toBe(123));
  it('returns null for $', () => expect(refId('$')).toBeNull());
  it('returns null for *', () => expect(refId('*')).toBeNull());
  it('returns null for enum literal', () => expect(refId('.NOTDEFINED.')).toBeNull());
});

describe('listRefs', () => {
  it('extracts all refs from a list', () => {
    expect(listRefs('(#10,#20,#30)')).toEqual([10, 20, 30]);
  });
  it('returns empty for $ list', () => expect(listRefs('$')).toEqual([]));
});

describe('decodeStepString', () => {
  it('strips outer quotes', () => expect(decodeStepString("'hello'")).toBe('hello'));
  it('unescapes double-apostrophe', () => expect(decodeStepString("'it''s'")).toBe("it's"));
  it('returns null for non-strings', () => expect(decodeStepString('$')).toBeNull());
});

describe('stripTypeCast', () => {
  it('strips IFCLABEL wrapper', () => expect(stripTypeCast("IFCLABEL('foo')")).toBe("'foo'"));
  it('strips IFCBOOLEAN wrapper', () => expect(stripTypeCast('IFCBOOLEAN(.T.)')).toBe('.T.'));
  it('passes through plain token', () => expect(stripTypeCast('#42')).toBe('#42'));
});

// ---------------------------------------------------------------------------
// Multi-line parsing
// ---------------------------------------------------------------------------

describe('tokenize — multi-line entities', () => {
  it('assembles a multi-line STEP record', () => {
    const text = makeIfc([
      "#1=IFCWALL('w1',$,",
      "'Wall A'",
      ',$,$,$,$,$,$);',
    ]);
    const { records } = tokenize(text);
    const wall = records.find(r => r.id === 1);
    expect(wall).toBeDefined();
    expect(wall!.type).toBe('IFCWALL');
    expect(wall!.args).toContain("'Wall A'");
  });
});

// ---------------------------------------------------------------------------
// extractFromRecords — schema detection
// ---------------------------------------------------------------------------

describe('extractFromRecords — schema detection', () => {
  it('detects IFC4', () => {
    const m = extract(makeIfc(['#1=IFCPROJECT(\'p1\',$,\'P\',$,$,$,$,(),$);']));
    expect(m.schema).toBe('IFC4');
  });
});

// ---------------------------------------------------------------------------
// Geometry exclusion (geometry-filter.ts still used by tokenizer path)
// ---------------------------------------------------------------------------

describe('extractFromRecords — geometry exclusion', () => {
  it('excludes IFCEXTRUDEDAREASOLID from entity index', () => {
    const text = makeIfc([
      "#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);",
      "#2=IFCEXTRUDEDAREASOLID($,(#3),#4,1.);",
    ]);
    const m = extract(text);
    expect(m.entities.has(1)).toBe(true);
    expect(m.entities.has(2)).toBe(false);
  });

  // Regression: the geometry set is now derived from the IFC4X3 schema, not
  // hand-listed. These classes were all MISSED by the old hand-written lists and
  // leaked into the graph as nodes.
  it.each([
    ['IFCPOLYGONALFACESET', '#2=IFCPOLYGONALFACESET(#3,$,(#4),$);'],
    ['IFCCURVESEGMENT',     '#2=IFCCURVESEGMENT(.CONTINUOUS.,#3,#4,#5,#6);'],
    ['IFCGRADIENTCURVE',    '#2=IFCGRADIENTCURVE((#3),.F.,#4,$);'],
    ['IFCCLOTHOID',         '#2=IFCCLOTHOID(#3,1.);'],
    ['IFCISHAPEPROFILEDEF', "#2=IFCISHAPEPROFILEDEF(.AREA.,'I',#3,1.,1.,1.,1.,$,$,$);"],
    ['IFCUSHAPEPROFILEDEF', "#2=IFCUSHAPEPROFILEDEF(.AREA.,'U',#3,1.,1.,1.,1.,$,$,$);"],
    ['IFCBOUNDINGBOX',      '#2=IFCBOUNDINGBOX(#3,1.,1.,1.);'],
    ['IFCAXIS2PLACEMENTLINEAR', '#2=IFCAXIS2PLACEMENTLINEAR(#3,$,$);'],
  ])('excludes %s from entity index (schema-derived)', (_name, line) => {
    const text = makeIfc(["#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);", line]);
    const m = extract(text);
    expect(m.entities.has(1)).toBe(true);
    expect(m.entities.has(2)).toBe(false);
  });

  // Styling values are IDS-addressable resources, not representation geometry:
  // attribute facets target them (IfcSurfaceStyleRendering.DiffuseColour, …).
  it.each([
    ['IFCSURFACESTYLEREFRACTION', '#2=IFCSURFACESTYLEREFRACTION(42.,$);'],
    ['IFCSURFACESTYLERENDERING',  '#2=IFCSURFACESTYLERENDERING(#3,0.5,$,$,$,$,$,$,$,$);'],
    ['IFCCOLOURRGB',              '#2=IFCCOLOURRGB($,1.,0.,0.);'],
  ])('keeps styling value %s as an entity', (_name, line) => {
    const text = makeIfc(["#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);", line]);
    const m = extract(text);
    expect(m.entities.has(2)).toBe(true);
  });

  it('excludes IFCPOLYLOOP from entity index', () => {
    const text = makeIfc([
      "#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);",
      '#2=IFCPOLYLOOP((#3,#4,#5));',
    ]);
    const m = extract(text);
    expect(m.entities.has(2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Null ref / derived ref handling
// ---------------------------------------------------------------------------

describe('extractFromRecords — null refs produce no triples', () => {
  it('$ in IfcRelAggregates children → no triple', () => {
    const text = makeIfc([
      "#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);",
      "#10=IFCRELAGGREGATES('ra1',$,$,$,#1,($));",
    ]);
    const m = extract(text);
    expect(m.triples).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// IfcRel type coverage
// ---------------------------------------------------------------------------

describe('IfcRelAggregates', () => {
  it('emits parent→child triples', () => {
    const text = makeIfc([
      "#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);",
      "#5=IFCSITE('s1',$,'Site',$,$,$,$,$,$,$,$,$,$,$);",
      "#6=IFCBUILDING('b1',$,'Bldg',$,$,$,$,$,$,$,$,$);",
      "#50=IFCRELAGGREGATES('ra1',$,$,$,#1,(#5,#6));",
    ]);
    const m = extract(text);
    const agg = m.triples.filter(t => t.predicate === 'IfcRelAggregates');
    expect(agg).toHaveLength(2);
    expect(agg[0]).toEqual({ subject: 1, predicate: 'IfcRelAggregates', object: 5 });
    expect(agg[1]).toEqual({ subject: 1, predicate: 'IfcRelAggregates', object: 6 });
  });
});

describe('IfcRelContainedInSpatialStructure', () => {
  it('emits container→element triples', () => {
    const text = makeIfc([
      "#7=IFCBUILDINGSTOREY('st1',$,'L1',$,$,$,$,$,$,$);",
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#21=IFCWALL('w2',$,'Wall B',$,$,$,$,$,$);",
      "#53=IFCRELCONTAINEDINSPATIALSTRUCTURE('rc1',$,$,$,(#20,#21),#7);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelContainedInSpatialStructure');
    expect(t).toHaveLength(2);
    expect(t[0]).toEqual({ subject: 7, predicate: 'IfcRelContainedInSpatialStructure', object: 20 });
  });
});

describe('IfcRelDefinesByProperties', () => {
  it('emits object→pset triples', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#35=IFCPROPERTYSET('ps1',$,'Pset_WallCommon',$,());",
      "#54=IFCRELDEFINESBYPROPERTIES('rdp1',$,$,$,(#20),#35);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelDefinesByProperties');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 20, predicate: 'IfcRelDefinesByProperties', object: 35 });
  });
});

describe('IfcRelDefinesByType', () => {
  it('emits type→instance triples', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#24=IFCWALLTYPE('wt1',$,'WAL-200',$,$,$,$,$,$,.NOTDEFINED.);",
      "#56=IFCRELDEFINESBYTYPE('rdt1',$,$,$,(#20),#24);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelDefinesByType');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 24, predicate: 'IfcRelDefinesByType', object: 20 });
  });
});

describe('IfcRelVoidsElement', () => {
  it('emits host→opening triple', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#42=IFCOPENINGELEMENT('op1',$,'Op1',$,$,$,$,$,$);",
      "#61=IFCRELVOIDSELEMENT('rve1',$,$,$,#20,#42);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelVoidsElement');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 20, predicate: 'IfcRelVoidsElement', object: 42 });
  });
});

describe('IfcRelFillsElement', () => {
  it('emits opening→filling triple', () => {
    const text = makeIfc([
      "#22=IFCDOOR('d1',$,'Door 01',$,$,$,$,$,$);",
      "#42=IFCOPENINGELEMENT('op1',$,'Op1',$,$,$,$,$,$);",
      "#62=IFCRELFILLSELEMENT('rfe1',$,$,$,#42,#22);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelFillsElement');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 42, predicate: 'IfcRelFillsElement', object: 22 });
  });
});

// IfcRelConnectsElements and its subtypes declare ConnectionGeometry at
// args[4], so RelatingElement/RelatedElement are at args[5]/[6] — NOT [4]/[5].
describe('IfcRelConnectsElements', () => {
  it('emits A→B triple', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#21=IFCWALL('w2',$,'Wall B',$,$,$,$,$,$);",
      // [4]=ConnectionGeometry($) [5]=RelatingElement [6]=RelatedElement
      "#70=IFCRELCONNECTSELEMENTS('rce1',$,$,$,$,#20,#21);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelConnectsElements');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 20, predicate: 'IfcRelConnectsElements', object: 21 });
  });

  it('still resolves when ConnectionGeometry is populated', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#21=IFCWALL('w2',$,'Wall B',$,$,$,$,$,$);",
      // A real ConnectionGeometry ref at [4] must not be mistaken for an element.
      "#70=IFCRELCONNECTSELEMENTS('rce1',$,$,$,#99,#20,#21);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelConnectsElements');
    expect(t).toEqual([{ subject: 20, predicate: 'IfcRelConnectsElements', object: 21 }]);
  });
});

describe('IfcRelConnectsPathElements', () => {
  it('emits A→B triple', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#21=IFCWALL('w2',$,'Wall B',$,$,$,$,$,$);",
      "#71=IFCRELCONNECTSPATHELEMENTS('rcpe1',$,$,$,$,#20,#21,$,$,$,$);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelConnectsPathElements');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 20, predicate: 'IfcRelConnectsPathElements', object: 21 });
  });
});

describe('IfcRelConnectsWithEccentricity', () => {
  it('collapses onto the IfcRelConnectsStructuralMember predicate', () => {
    const text = makeIfc([
      "#40=IFCSTRUCTURALCURVEMEMBER('m1',$,'Member',$,$,$,$,.RIGID_JOINED_MEMBER.,$);",
      "#41=IFCSTRUCTURALPOINTCONNECTION('c1',$,'Conn',$,$,$,$,$,$);",
      // [4]=RelatingStructuralMember [5]=RelatedStructuralConnection
      "#72=IFCRELCONNECTSWITHECCENTRICITY('rcwe1',$,$,$,#40,#41,$,$,$,$,$);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelConnectsStructuralMember');
    expect(t).toEqual([{ subject: 40, predicate: 'IfcRelConnectsStructuralMember', object: 41 }]);
  });
});

describe('IfcRelAssociatesClassification', () => {
  it('emits object→classification triples', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#41=IFCCLASSIFICATIONREFERENCE($,'A-10','Superstructure',$,$);",
      "#60=IFCRELASSOCIATESCLASSIFICATION('rac1',$,$,$,(#20),#41);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelAssociatesClassification');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 20, predicate: 'IfcRelAssociatesClassification', object: 41 });
  });
});

describe('IfcRelAssociatesDocument', () => {
  it('emits object→document triples', () => {
    const text = makeIfc([
      "#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);",
      "#40=IFCDOCUMENTINFORMATION('doc1','D001','Specs',$,$,$,$,$,$,$,$,$,$,$,$,$);",
      "#59=IFCRELASSOCIATESDOCUMENT('rad1',$,$,$,(#1),#40);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelAssociatesDocument');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 1, predicate: 'IfcRelAssociatesDocument', object: 40 });
  });
});

describe('IfcRelAssociatesMaterial', () => {
  it('emits object→material triples', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#30=IFCMATERIAL('mat1',$,'Concrete');",
      "#58=IFCRELASSOCIATESMATERIAL('ram1',$,$,$,(#20),#30);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelAssociatesMaterial');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 20, predicate: 'IfcRelAssociatesMaterial', object: 30 });
  });
});

describe('synthetic material-usage edges', () => {
  it('links IfcMaterialLayerSetUsage → IfcMaterialLayerSet (ForLayerSet)', () => {
    const text = makeIfc([
      "#30=IFCMATERIAL('mat1',$,'Concrete');",
      "#31=IFCMATERIALLAYERSET((#32),'WallLS');",
      '#32=IFCMATERIALLAYER(#30,0.2,$,$,$,$,$);',
      '#33=IFCMATERIALLAYERSETUSAGE(#31,.AXIS2.,.POSITIVE.,0.1,$);',
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'hasMaterialLayerSet');
    expect(t).toEqual([{ subject: 33, predicate: 'hasMaterialLayerSet', object: 31 }]);
    // and the layer set still fans out to its layer → material
    expect(m.triples).toContainEqual({ subject: 31, predicate: 'hasMaterialLayer', object: 32 });
    expect(m.triples).toContainEqual({ subject: 32, predicate: 'hasMaterial', object: 30 });
  });

  it('links IfcMaterialProfileSetUsage → IfcMaterialProfileSet (ForProfileSet)', () => {
    const text = makeIfc([
      "#40=IFCMATERIALPROFILESET('PS',$,(#41),$);",
      "#41=IFCMATERIALPROFILE('P1',$,$,$,$,$);",
      '#42=IFCMATERIALPROFILESETUSAGE(#40,$,$);',
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'hasMaterialProfileSet');
    expect(t).toEqual([{ subject: 42, predicate: 'hasMaterialProfileSet', object: 40 }]);
  });
});

describe('generic reference fallback', () => {
  it('emits a `references` edge for an unmapped attribute ref between kept nodes', () => {
    // IfcClassification arg[5] (IFC4 `Specification`) here points at another
    // IfcClassification — no named REL/synthetic rule covers it. The generic
    // fallback labels the edge with the source STEP attribute slot name.
    const text = makeIfc([
      "#1=IFCCLASSIFICATION('src',$,$,'Parent System',$,$,$);",
      "#2=IFCCLASSIFICATION('src2',$,$,'Child System',$,#1,$);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'references');
    expect(t).toContainEqual({
      subject: 2, predicate: 'references', object: 1, detail: 'Specification',
    });
  });

  it('labels the generic edge with the source STEP attribute slot name', () => {
    // IfcSurfaceStyle arg[2] (Styles list) references an IfcSurfaceStyleShading
    // via an unmapped attribute; the slot name should surface as `detail`.
    // Use a type whose arg-slot ref has no semantic rule: IfcActor.TheActor.
    const text = makeIfc([
      "#5=IFCPERSON($,'Doe','John',$,$,$,$,$);",
      "#6=IFCACTOR('actorGuid',$,$,$,$,#5);",
    ]);
    const m = extract(text);
    const t = m.triples.find(
      t => t.predicate === 'references' && t.subject === 6 && t.object === 5,
    );
    expect(t?.detail).toBe('TheActor');
  });

  it('does not duplicate an edge a semantic rule already produced', () => {
    const text = makeIfc([
      "#30=IFCMATERIAL('mat1',$,'Concrete');",
      '#32=IFCMATERIALLAYER(#30,0.2,$,$,$,$,$);',
    ]);
    const m = extract(text);
    // hasMaterial exists; no parallel `references` edge for the same pair
    expect(m.triples).toContainEqual({ subject: 32, predicate: 'hasMaterial', object: 30 });
    const refDup = m.triples.filter(
      t => t.predicate === 'references' &&
        ((t.subject === 32 && t.object === 30) || (t.subject === 30 && t.object === 32)),
    );
    expect(refDup).toHaveLength(0);
  });

  it('never links to geometry or placement (they are not kept entities)', () => {
    const text = makeIfc([
      '#100=IFCCARTESIANPOINT((0.,0.,0.));',
      '#101=IFCAXIS2PLACEMENT3D(#100,$,$);',
      '#102=IFCLOCALPLACEMENT($,#101);',
      "#20=IFCWALL('w1',$,'Wall A',$,$,#102,$,$,$);",
    ]);
    const m = extract(text);
    const refs = m.triples.filter(t => t.predicate === 'references');
    // wall's placement ref points at #102 which is not a kept entity → no edge
    expect(refs.every(t => m.entities.has(t.subject) && m.entities.has(t.object))).toBe(true);
    expect(refs.some(t => t.object === 102 || t.object === 101 || t.object === 100)).toBe(false);
  });
});

describe('IfcRelAssignsToGroup', () => {
  it('emits group→member triples', () => {
    const text = makeIfc([
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#90=IFCGROUP('g1',$,'Group A',$,$);",
      "#91=IFCRELASSIGNSTOGROUP('rag1',$,$,$,(#20),$,#90);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelAssignsToGroup');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 90, predicate: 'IfcRelAssignsToGroup', object: 20 });
  });
});

describe('IfcRelSpaceBoundary', () => {
  it('emits space→element triple', () => {
    const text = makeIfc([
      "#8=IFCSPACE('sp1',$,'Space 01',$,$,$,$,$,$,$,$,$);",
      "#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);",
      "#92=IFCRELSPACEBOUNDARY('rsb1',$,$,$,#8,#20,$,$,$);",
    ]);
    const m = extract(text);
    const t = m.triples.filter(t => t.predicate === 'IfcRelSpaceBoundary');
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ subject: 8, predicate: 'IfcRelSpaceBoundary', object: 20 });
  });
});

// ---------------------------------------------------------------------------
// Placement coordinates — still resolved via geometry-filter in tokenizer path
// ---------------------------------------------------------------------------

describe('extractFromRecords — placement coordinates', () => {
  it('does not store IFCCARTESIANPOINT as an entity', () => {
    const text = makeIfc([
      '#100=IFCCARTESIANPOINT((10.,20.,5.));',
      "#1=IFCPROJECT('p1',$,'P',$,$,$,$,(),$);",
    ]);
    const m = extract(text);
    expect(m.entities.has(100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full demo IFC roundtrip
// ---------------------------------------------------------------------------

describe('extractFromRecords — full demo roundtrip', () => {
  const DEMO = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('proj1',$,'Demo Project',$,$,$,$,(),#10);
#10=IFCUNITASSIGNMENT((#2,#3,#4));
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#5=IFCSITE('site1',$,'Site A',$,$,$,$,$,$,$,$,$,$,$);
#6=IFCBUILDING('bld1',$,'Building 1',$,$,$,$,$,$,$,$,$);
#7=IFCBUILDINGSTOREY('sty1',$,'Level 1',$,$,$,$,$,$,$);
#8=IFCBUILDINGSTOREY('sty2',$,'Level 2',$,$,$,$,$,$,$);
#20=IFCWALL('w1',$,'Wall A',$,$,$,$,$,$);
#21=IFCWALL('w2',$,'Wall B',$,$,$,$,$,$);
#22=IFCDOOR('d1',$,'Door 01',$,$,$,$,$,2.,0.9,$,.SINGLE_SWING_LEFT.,$);
#23=IFCWINDOW('win1',$,'Window 01',$,$,$,$,$,1.2,1.0,$,$,$,$);
#24=IFCWALLTYPE('wt1',$,'WAL-200',$,$,$,$,$,$,.NOTDEFINED.);
#25=IFCDOORTYPE('dt1',$,'DT-01',$,$,$,$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,$,$);
#30=IFCMATERIAL('mat1',$,'Concrete');
#31=IFCMATERIALLAYERSET((#32),'WallLS');
#32=IFCMATERIALLAYER(#30,0.2,$,$,$,$,$);
#35=IFCPROPERTYSET('ps1',$,'Pset_WallCommon',$,(#36,#37));
#36=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#37=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('WAL-200'),$);
#38=IFCPROPERTYSET('ps2',$,'Pset_DoorCommon',$,(#39));
#39=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('FD30'),$);
#40=IFCDOCUMENTINFORMATION('doc1','D001','Project Specifications',$,$,$,$,$,$,$,$,$,$,$,$,$);
#41=IFCCLASSIFICATIONREFERENCE($,'A-10','Superstructure',$,$);
#42=IFCOPENINGELEMENT('op1',$,'Opening 01',$,$,$,$,$,$);
#50=IFCRELAGGREGATES('ra1',$,$,$,#1,(#5));
#51=IFCRELAGGREGATES('ra2',$,$,$,#5,(#6));
#52=IFCRELAGGREGATES('ra3',$,$,$,#6,(#7,#8));
#53=IFCRELCONTAINEDINSPATIALSTRUCTURE('rc1',$,$,$,(#20,#21,#22,#23),#7);
#54=IFCRELDEFINESBYPROPERTIES('rdp1',$,$,$,(#20,#21),#35);
#55=IFCRELDEFINESBYPROPERTIES('rdp2',$,$,$,(#22),#38);
#56=IFCRELDEFINESBYTYPE('rdt1',$,$,$,(#20,#21),#24);
#57=IFCRELDEFINESBYTYPE('rdt2',$,$,$,(#22),#25);
#58=IFCRELASSOCIATESMATERIAL('ram1',$,$,$,(#20,#21),#31);
#59=IFCRELASSOCIATESDOCUMENT('rad1',$,$,$,(#1,#20),#40);
#60=IFCRELASSOCIATESCLASSIFICATION('rac1',$,$,$,(#20),#41);
#61=IFCRELVOIDSELEMENT('rve1',$,$,$,#20,#42);
#62=IFCRELFILLSELEMENT('rfe1',$,$,$,#42,#22);
ENDSEC;
END-ISO-10303-21;`;

  it('parses all entities (no geometry in demo)', () => {
    const m = extract(DEMO, 'demo.ifc');
    expect(m.entities.size).toBeGreaterThan(20);
    expect(m.entities.get(1)?.name).toBe('Demo Project');
    expect(m.entities.get(20)?.name).toBe('Wall A');
  });

  it('extracts correct triple count', () => {
    const m = extract(DEMO, 'demo.ifc');
    // Named REL + synthetic edges (excludes the Tier-2 generic `references` pass,
    // which additionally links project→units and unit-assignment→units here).
    const named = m.triples.filter(t => t.predicate !== 'references');
    expect(named.length).toBe(26);
  });

  it('schema is IFC4', () => {
    const m = extract(DEMO, 'demo.ifc');
    expect(m.schema).toBe('IFC4');
  });
});
