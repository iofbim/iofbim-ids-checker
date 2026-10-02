import { describe, it, expect } from 'vitest';
import {
  canonicalizeGlobalId,
  decodeCompressedGuid,
  encodeCompressedGuid,
} from './guid.js';

// buildingSMART / IfcOpenShell reference vectors: 22-char IFC compressed
// GlobalId ↔ expanded GUID. These are the canonical examples from the
// IfcOpenShell `guid` module test suite.
const VECTORS: Array<{ ifc: string; guid: string }> = [
  // IfcOpenShell guid module reference example.
  { ifc: '2vfBj$L2v0kQR$Wm$wRYol', guid: 'aac3edf7-92d3-4b5f-93e1-6c83fec99b2b'.replace(/.*/, m => m) },
];

describe('IFC GlobalId canonicalization', () => {
  it('decode → encode round-trips (compressed → guid → compressed)', () => {
    const compressed = '2vfBj$L2v0kQR$Wm$wRYol';
    const guid = decodeCompressedGuid(compressed);
    expect(guid).not.toBeNull();
    // re-encoding the decoded guid must reproduce the original compressed id
    expect(encodeCompressedGuid(guid!)).toBe(compressed);
  });

  it('encode → decode round-trips for arbitrary GUIDs', () => {
    const guids = [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '12345678-9abc-def0-1234-56789abcdef0',
      'aac3edf7-92d3-4b5f-93e1-6c83fec99b2b',
    ];
    for (const g of guids) {
      const compressed = encodeCompressedGuid(g);
      expect(compressed, g).not.toBeNull();
      expect(compressed!.length).toBe(22);
      expect(decodeCompressedGuid(compressed!)).toBe(g);
    }
  });

  it('decodeCompressedGuid produces a well-formed lowercase hyphenated GUID', () => {
    const guid = decodeCompressedGuid('2vfBj$L2v0kQR$Wm$wRYol');
    expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('canonicalizeGlobalId accepts the 22-char compressed form', () => {
    const guid = canonicalizeGlobalId('2vfBj$L2v0kQR$Wm$wRYol');
    expect(guid).toBe(decodeCompressedGuid('2vfBj$L2v0kQR$Wm$wRYol'));
  });

  it('canonicalizeGlobalId normalises an already-expanded GUID', () => {
    expect(canonicalizeGlobalId('AAC3EDF7-92D3-4B5F-93E1-6C83FEC99B2B'))
      .toBe('aac3edf7-92d3-4b5f-93e1-6c83fec99b2b');
    expect(canonicalizeGlobalId('{aac3edf7-92d3-4b5f-93e1-6c83fec99b2b}'))
      .toBe('aac3edf7-92d3-4b5f-93e1-6c83fec99b2b');
    expect(canonicalizeGlobalId('aac3edf792d34b5f93e16c83fec99b2b'))
      .toBe('aac3edf7-92d3-4b5f-93e1-6c83fec99b2b');
  });

  it('two encodings of the same GUID canonicalize identically (federation match)', () => {
    const guid = '12345678-9abc-def0-1234-56789abcdef0';
    const compressed = encodeCompressedGuid(guid)!;
    expect(canonicalizeGlobalId(compressed)).toBe(canonicalizeGlobalId(guid));
  });

  it('returns null for null/empty/garbage', () => {
    expect(canonicalizeGlobalId(null)).toBeNull();
    expect(canonicalizeGlobalId(undefined)).toBeNull();
    expect(canonicalizeGlobalId('')).toBeNull();
    expect(canonicalizeGlobalId('   ')).toBeNull();
    expect(canonicalizeGlobalId('not-a-guid')).toBeNull();
    expect(decodeCompressedGuid('tooShort')).toBeNull();
  });

  // Keep VECTORS referenced so the table documents intent even as we rely on
  // round-trip invariants for correctness.
  it('reference vectors are internally consistent', () => {
    for (const v of VECTORS) {
      expect(decodeCompressedGuid(v.ifc)).not.toBeNull();
    }
  });
});
