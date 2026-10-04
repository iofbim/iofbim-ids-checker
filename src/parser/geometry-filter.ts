/**
 * Geometry / placement classification.
 *
 * The type sets are DERIVED FROM THE IFC4X3 SCHEMA
 * (see scripts/gen-ifc-attr-names.mjs → IFC_GEOMETRY_TYPES), not hand-listed.
 *
 * This file previously carried its own hand-maintained GEOMETRY_TYPES /
 * PLACEMENT_TYPES lists, which had drifted apart from the near-duplicate lists
 * in ifc-loader.ts: 15 types were filtered only here and 52 only there, and
 * neither covered the ~99 concrete geometry classes the schema actually
 * declares. Both now resolve against the single generated set, so the WASM path
 * (ifc-loader) and the string-tokenizer path (extractor) can no longer disagree
 * about what counts as geometry.
 */

import { IFC_GEOMETRY_TYPES } from './ifc-attr-names.generated.js';

/** Every concrete geometry / representation / placement class. */
export const GEOMETRY_TYPES = IFC_GEOMETRY_TYPES;

/**
 * Placement-chain types — kept only to resolve coords in the legacy string
 * tokenizer path, not stored as entities. A subset of GEOMETRY_TYPES.
 */
export const PLACEMENT_TYPES = new Set<string>([
  'IFCLOCALPLACEMENT',
  'IFCGRIDPLACEMENT',
  'IFCLINEARPLACEMENT',
  'IFCAXIS2PLACEMENT3D',
  'IFCAXIS2PLACEMENT2D',
  'IFCAXIS2PLACEMENTLINEAR',
  'IFCAXIS1PLACEMENT',
  'IFCCARTESIANPOINT',
]);

export function isGeometry(type: string): boolean {
  return GEOMETRY_TYPES.has(type);
}

export function isPlacementType(type: string): boolean {
  return PLACEMENT_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Placement coordinate resolver
// ---------------------------------------------------------------------------

import { splitArgs, refId } from './tokenizer.js';
import type { RawRecord } from './tokenizer.js';

interface PlacementMap {
  localPlacements: Map<number, number>;   // id → IfcAxis2Placement3D id
  axis2Placements: Map<number, number>;   // id → IfcCartesianPoint id
  cartesianPoints: Map<number, [number, number, number]>;
}

/**
 * Build look-up tables from the raw records for the placement chain.
 * Call once after tokenization; use resolvePlacementCoords() per entity.
 */
export function buildPlacementMap(records: RawRecord[]): PlacementMap {
  const localPlacements = new Map<number, number>();
  const axis2Placements = new Map<number, number>();
  const cartesianPoints = new Map<number, [number, number, number]>();

  for (const rec of records) {
    const type = rec.type;
    if (type === 'IFCCARTESIANPOINT') {
      const args = splitArgs(rec.args);
      const coordToken = args[0] ?? '';
      const coords = parseCoordList(coordToken);
      if (coords) cartesianPoints.set(rec.id, coords);
    } else if (type === 'IFCAXIS2PLACEMENT3D') {
      const args = splitArgs(rec.args);
      const ptId = refId(args[0] ?? '');
      if (ptId !== null) axis2Placements.set(rec.id, ptId);
    } else if (type === 'IFCLOCALPLACEMENT') {
      const args = splitArgs(rec.args);
      const plId = refId(args[1] ?? '');
      if (plId !== null) localPlacements.set(rec.id, plId);
    }
  }

  return { localPlacements, axis2Placements, cartesianPoints };
}

/** Parse a STEP coordinate list token `(1.,2.,3.)` into a numeric triple */
function parseCoordList(token: string): [number, number, number] | null {
  const inner = token.trim().replace(/^\(|\)$/g, '');
  const parts = inner.split(',').map(s => parseFloat(s.trim()));
  if (parts.length < 3 || parts.some(isNaN)) return null;
  const [x, y, z] = parts;
  if (x === undefined || y === undefined || z === undefined) return null;
  return [x, y, z];
}

/**
 * Resolve the 3D placement origin for a placement reference id.
 * Returns null if the chain is incomplete or refers to a 2D placement.
 */
export function resolvePlacementCoords(
  placementId: number,
  map: PlacementMap,
): [number, number, number] | null {
  const axis2Id = map.localPlacements.get(placementId);
  if (axis2Id === undefined) return null;
  const ptId = map.axis2Placements.get(axis2Id);
  if (ptId === undefined) return null;
  return map.cartesianPoints.get(ptId) ?? null;
}
