/**
 * Per-element and per-model facts for BCF export (and similar read-only views).
 *
 * Elements are addressed by their checker Uid `${modelId}:${entityId}` (see
 * check.ts / ids/types.ts). The `entities` table is the source of truth; this
 * module only reads it, so it composes with the same DuckDB layer as the IDS
 * evaluator (getDb + awaitIngest).
 *
 * Two axis facts are easy to get wrong and are worth stating once:
 *   - Coordinates are metres: web-ifc normalizes the project length unit
 *     (millimetre → metres) into `flatTransformation` at parse time.
 *   - web-ifc meshes into a Y-up (three.js) frame, while BCF, IFC and the IDS
 *     spatial filters speak the IFC Z-up frame. {@link worldBoxToIfcBox} rotates
 *     the stored box back.
 */

import { getDb, awaitIngest } from './db/client.js';
import { canonicalizeGlobalId, encodeCompressedGuid } from './parser/guid.js';

/** World axis-aligned box in the IFC model's own frame: metres, Z up. [minX, minY, minZ, maxX, maxY, maxZ] */
export type ElementBox = [number, number, number, number, number, number];

export interface ElementInfo {
  uid: string;
  /** 22-character IFC GlobalId (compressed form, as BCF IfcGuid needs); null when the entity has none or it is invalid */
  globalId: string | null;
  ifcType: string;      // as stored, e.g. IFCWALL
  name: string | null;
  bbox: ElementBox | null; // null when the element produced no geometry
}

export interface ModelInfo {
  modelId: string;
  /** GlobalId (22-char) of the model's IfcProject, null if none */
  projectGuid: string | null;
  projectName: string | null;
}

/**
 * Convert a stored bounding box from web-ifc's Y-up world frame to the IFC
 * Z-up frame (metres both ways).
 *
 * EMPIRICAL EVIDENCE — IDS_wooden-windows_IFC.ifc (IFC2X3, millimetres), loaded
 * through this package's loader with COORDINATE_TO_ORIGIN off. IfcWindow
 * `#10484`'s ObjectPlacement `#10483` points at RelativePlacement
 * `#43325 = IfcAxis2Placement3D(#43323)` with
 * `#43323 = IfcCartesianPoint((-5804.51948790172, -1678.06884601914, 1504.))`.
 * The mesh part's `flatTransformation` is column-major
 * `[1,0,0,0, 0,0,-1,0, 0,1,0,0, -5.7935,1.4930,1.6781,1]` at 0.001 scale, so it
 * maps local `(x,y,z)` to world `(x, z, -y)`: the translation is exactly the
 * placement with worldY = IFC Z (1.493 ≈ 1.504) and worldZ = -IFC Y
 * (1.6781 = 1.67807). IfcDoor `#7893` agrees — its 2.42 m vertical extent lands
 * on worldY (0.037…2.370), not on the stored worldZ (0.733…1.776).
 * So: world = (IFC x, IFC z, -IFC y) and, inverting with the negated axis
 * swapping min/max, IFC box = [minX, -maxZ, minY, maxX, -minZ, maxY].
 */
export function worldBoxToIfcBox(box: ElementBox): ElementBox {
  const [minX, minY, minZ, maxX, maxY, maxZ] = box;
  return [minX, -maxZ, minY, maxX, -minZ, maxY];
}

/**
 * Normalize a stored GlobalId to the 22-character IFC compressed form that a
 * BCF `IfcGuid` needs. `entities.global_id` holds whatever the file authored —
 * the 22-char compressed form or an expanded GUID — so accept either and
 * canonicalize through the shared guid helpers. Null when the entity has no
 * GlobalId or it is malformed.
 */
export function toCompressedGlobalId(raw: string | null | undefined): string | null {
  const canonical = canonicalizeGlobalId(raw);
  return canonical === null ? null : encodeCompressedGuid(canonical);
}

/**
 * Group requested uids by model so {@link getElementInfo} runs one query per
 * model rather than one per uid. Malformed uids (no colon, non-integer entity
 * id) are dropped — an unknown uid is simply absent from the result.
 */
export function groupUidsByModel(uids: string[]): Map<string, Set<number>> {
  const byModel = new Map<string, Set<number>>();
  for (const uid of uids) {
    const sep = uid.lastIndexOf(':');
    if (sep <= 0) continue;
    const modelId = uid.slice(0, sep);
    const idPart = uid.slice(sep + 1);
    // Digits only: rejects '' (Number('') is 0), signs, decimals and junk.
    if (!/^\d+$/.test(idPart)) continue;
    let ids = byModel.get(modelId);
    if (!ids) byModel.set(modelId, (ids = new Set()));
    ids.add(Number(idPart));
  }
  return byModel;
}

/** One `entities` row as read by {@link getElementInfo}; bbox columns nullable. */
export interface ElementInfoRow {
  entity_id: number;
  ifc_type: string;
  name: string | null;
  global_id: string | null;
  bbox_min_x: number | null;
  bbox_min_y: number | null;
  bbox_min_z: number | null;
  bbox_max_x: number | null;
  bbox_max_y: number | null;
  bbox_max_z: number | null;
}

/**
 * Map one row to an {@link ElementInfo}. Pure, so the column→API translation
 * (GUID form, nullable name, Y-up→IFC box) is unit-testable without DuckDB.
 * `bbox` is null unless all six columns are present — a non-physical entity has
 * none of them, and a geometry-bearing one has all six.
 */
export function rowToElementInfo(modelId: string, row: ElementInfoRow): ElementInfo {
  const {
    bbox_min_x: minX, bbox_min_y: minY, bbox_min_z: minZ,
    bbox_max_x: maxX, bbox_max_y: maxY, bbox_max_z: maxZ,
  } = row;
  const bbox = minX !== null && minY !== null && minZ !== null
    && maxX !== null && maxY !== null && maxZ !== null
    ? worldBoxToIfcBox([minX, minY, minZ, maxX, maxY, maxZ])
    : null;
  return {
    uid: `${modelId}:${entityIdOf(row)}`,
    globalId: toCompressedGlobalId(row.global_id),
    ifcType: String(row.ifc_type),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    bbox,
  };
}

/** `entity_id` may arrive as number or BigInt depending on the Arrow path. */
function entityIdOf(row: ElementInfoRow): number {
  return Number(row.entity_id);
}

/**
 * Element facts for BCF export and similar; unknown uids are absent from the
 * result. One query per model, not per uid. Waits for any in-flight ingest of
 * each model first, exactly like the IDS evaluator.
 */
export async function getElementInfo(uids: string[]): Promise<Record<string, ElementInfo>> {
  const byModel = groupUidsByModel(uids);
  const out: Record<string, ElementInfo> = {};
  if (byModel.size === 0) return out;

  const db = await getDb();
  for (const [modelId, ids] of byModel) {
    await awaitIngest(modelId);
    const conn = await db.connect();
    try {
      // entity_ids are validated integers and modelId is bound, so the IN list
      // is built from the placeholders only — no injection path.
      const placeholders = [...ids].map(() => '?').join(', ');
      const stmt = await conn.prepare(
        `SELECT entity_id, ifc_type, name, global_id,
                bbox_min_x, bbox_min_y, bbox_min_z,
                bbox_max_x, bbox_max_y, bbox_max_z
           FROM entities
          WHERE model_id = ? AND entity_id IN (${placeholders})`,
      );
      try {
        const res = await stmt.query(modelId, ...ids);
        for (const raw of res.toArray()) {
          const row = raw as ElementInfoRow;
          out[`${modelId}:${entityIdOf(row)}`] = rowToElementInfo(modelId, row);
        }
      } finally {
        await stmt.close();
      }
    } finally {
      await conn.close();
    }
  }
  return out;
}

/**
 * The model's project identity: the 22-char GlobalId and Name of its
 * IfcProject. Null when the model has no IfcProject row (never ingested / not
 * a building model). A model has at most one IfcProject; if a malformed file
 * carries several, the lowest express id wins deterministically.
 */
export async function getModelInfo(modelId: string): Promise<ModelInfo | null> {
  const db = await getDb();
  await awaitIngest(modelId);
  const conn = await db.connect();
  try {
    const stmt = await conn.prepare(
      `SELECT global_id, name
         FROM entities
        WHERE model_id = ? AND upper(ifc_type) = 'IFCPROJECT'
        ORDER BY entity_id
        LIMIT 1`,
    );
    try {
      const res = await stmt.query(modelId);
      const rows = res.toArray();
      if (rows.length === 0) return null;
      const row = rows[0] as { global_id: string | null; name: string | null };
      return {
        modelId,
        projectGuid: toCompressedGlobalId(row.global_id),
        projectName: row.name === null || row.name === undefined ? null : String(row.name),
      };
    } finally {
      await stmt.close();
    }
  } finally {
    await conn.close();
  }
}
