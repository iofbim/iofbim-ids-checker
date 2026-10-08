import { describe, it, expect } from 'vitest';
import {
  worldBoxToIfcBox,
  toCompressedGlobalId,
  groupUidsByModel,
  rowToElementInfo,
  type ElementBox,
  type ElementInfoRow,
} from './element-info.js';

// 22-char IFC compressed GlobalId and the expanded GUID it decodes to. Used so
// the normalization tests do not depend on this repo's own encoder to define
// the expected value (the pair was decoded with the IfcOpenShell algorithm).
const IFC_GUID = '2vfBj$L2v0kQR$Wm$wRYol';
const EXPANDED_GUID = 'b9a4bb7f-542e-40b9-a6ff-830ffa6e2caf';

describe('worldBoxToIfcBox — web-ifc Y-up → IFC Z-up', () => {
  // Empirically measured values (see element-info.ts for the full derivation):
  // IDS_wooden-windows_IFC.ifc IfcDoor #7893, whose IFC-frame vertical extent
  // comes from placement Z = 1.211 m and is stored on worldY.
  it('maps a stored Y-up box to the IFC frame (negated axis swaps min/max)', () => {
    const world: ElementBox = [-5.2745, 0.0370, 0.7331, -4.3565, 2.3700, 1.7760];
    const ifc = worldBoxToIfcBox(world);
    // IFC x = world x; IFC y = -world z; IFC z = world y.
    expect(ifc).toEqual([-5.2745, -1.7760, 0.0370, -4.3565, -0.7331, 2.3700]);
    // IFC Z (up) is the stored worldY; IFC Y is the negated stored worldZ.
    expect([ifc[2], ifc[5]]).toEqual([world[1], world[4]]);
    expect([ifc[1], ifc[4]]).toEqual([-world[5], -world[2]]);
  });

  it('keeps a box whose negated axis already ascends monotonic', () => {
    // world z from -2 to -1 → IFC y from 1 to 2.
    expect(worldBoxToIfcBox([0, 0, -2, 1, 3, -1])).toEqual([0, 1, 0, 1, 2, 3]);
  });
});

describe('toCompressedGlobalId — 22-char IFC form for BCF', () => {
  it('leaves an already-compressed 22-char GlobalId unchanged', () => {
    expect(toCompressedGlobalId(IFC_GUID)).toBe(IFC_GUID);
  });

  it('compresses an expanded (hyphenated or bare) GUID', () => {
    expect(toCompressedGlobalId(EXPANDED_GUID)).toBe(IFC_GUID);
    expect(toCompressedGlobalId(EXPANDED_GUID.replace(/-/g, ''))).toBe(IFC_GUID);
    expect(toCompressedGlobalId(`{${EXPANDED_GUID}}`)).toBe(IFC_GUID);
  });

  it('returns null for missing or malformed GlobalIds', () => {
    expect(toCompressedGlobalId(null)).toBeNull();
    expect(toCompressedGlobalId(undefined)).toBeNull();
    expect(toCompressedGlobalId('')).toBeNull();
    expect(toCompressedGlobalId('   ')).toBeNull();
    expect(toCompressedGlobalId('not-a-guid')).toBeNull();
    // Wrong-length compressed-looking string is rejected by the decoder.
    expect(toCompressedGlobalId('2vfBj$L2v0kQR$Wm$wRYo')).toBeNull();
  });
});

describe('groupUidsByModel — one query per model', () => {
  it('groups express ids by model and de-duplicates', () => {
    const grouped = groupUidsByModel(['m1:1', 'm1:2', 'm1:1', 'm2:7']);
    expect(grouped.get('m1')).toEqual(new Set([1, 2]));
    expect(grouped.get('m2')).toEqual(new Set([7]));
    expect(grouped.size).toBe(2);
  });

  it('splits on the last colon so a model id may itself contain one', () => {
    const grouped = groupUidsByModel(['a:b:12']);
    expect(grouped.get('a:b')).toEqual(new Set([12]));
  });

  it('drops malformed uids', () => {
    const grouped = groupUidsByModel(['no-colon', ':5', 'm1:', 'm1:x', 'm1:1.5', 'm1:-1', 'm1:+2']);
    expect(grouped.size).toBe(0);
  });
});

describe('rowToElementInfo — entities row → API shape', () => {
  const base: ElementInfoRow = {
    entity_id: 7893,
    ifc_type: 'IFCDOOR',
    name: 'Houten deur',
    global_id: IFC_GUID,
    bbox_min_x: -5.2745,
    bbox_min_y: 0.0370,
    bbox_min_z: 0.7331,
    bbox_max_x: -4.3565,
    bbox_max_y: 2.3700,
    bbox_max_z: 1.7760,
  };

  it('maps the row and converts the box to the IFC frame', () => {
    expect(rowToElementInfo('model-1', base)).toEqual({
      uid: 'model-1:7893',
      globalId: IFC_GUID,
      ifcType: 'IFCDOOR',
      name: 'Houten deur',
      bbox: [-5.2745, -1.7760, 0.0370, -4.3565, -0.7331, 2.3700],
    });
  });

  it('yields bbox null when any bbox column is missing (element with no geometry)', () => {
    const info = rowToElementInfo('model-1', { ...base, bbox_min_x: null, bbox_max_z: null });
    expect(info.bbox).toBeNull();
  });

  it('yields name and globalId null when authored as absent', () => {
    const info = rowToElementInfo('model-1', { ...base, name: null, global_id: null });
    expect(info.name).toBeNull();
    expect(info.globalId).toBeNull();
  });
});
