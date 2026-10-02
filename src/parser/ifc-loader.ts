/**
 * web-ifc WASM wrapper.
 *
 * Provides the same RawRecord[] shape that our REL_HANDLERS and SYNTHETIC_RULES
 * already consume, so extractor logic is unchanged. The STEP tokenizer is
 * bypassed entirely — web-ifc's C++ parser handles all STEP encoding concerns.
 *
 * Usage (inside a Web Worker or main thread):
 *   const loader = new IfcLoader();
 *   await loader.init(wasmPathUrl);
 *   const { records, schema } = await loader.load(uint8Array);
 *   loader.dispose();
 */

import { IfcAPI, REAL, REF, STRING, LABEL, ENUM, SET_BEGIN, SET_END, LINE_END } from 'web-ifc';
import { IFC_GEOMETRY_TYPES } from './ifc-attr-names.generated.js';
import type { RawRecord } from './tokenizer.js';
import type { TypedLine } from './typed-line.js';

// Geometry / placement / styling classes are skipped wholesale: they never
// become graph nodes. The set is DERIVED FROM THE IFC4X3 SCHEMA
// (scripts/gen-ifc-attr-names.mjs) rather than hand-listed here.
//
// It used to be two hand-maintained name lists — one here, one in
// geometry-filter.ts — which had silently diverged from each other and from the
// schema: together they missed 99 real concrete geometry classes (every
// IFC4X3 alignment class among them: IfcCurveSegment, IfcGradientCurve, the
// spiral family, IfcAxis2PlacementLinear, IfcPointByDistanceExpression), and
// contained 5 names that do not exist in IFC4X3 at all — including the typos
// IFCI_PROFILEDEF and IFCUPROFILEDEF, which meant IfcIShapeProfileDef and
// IfcUShapeProfileDef were never actually filtered.
const GEOMETRY_TYPES = IFC_GEOMETRY_TYPES;

/**
 * Placement classes, needed as a separate set only because `keptIds` (the bbox
 * candidate list) is built before the geometry test. All are also members of
 * GEOMETRY_TYPES via IfcObjectPlacement.
 */
const PLACEMENT_TYPES = new Set([
  'IFCLOCALPLACEMENT',
  'IFCGRIDPLACEMENT',
  'IFCLINEARPLACEMENT',
  'IFCAXIS2PLACEMENT2D',
  'IFCAXIS2PLACEMENT3D',
  'IFCAXIS2PLACEMENTLINEAR',
  'IFCAXIS1PLACEMENT',
]);

/**
 * Axis-aligned world-space bounding box for one product, `[minX,minY,minZ,maxX,maxY,maxZ]`.
 * Coordinates are in the model's own units (metres after web-ifc's length
 * normalization) and in *world* space — the placement chain is already baked in
 * by web-ifc's flat transformation.
 */
export type BBox = [number, number, number, number, number, number];

/**
 * Per-entity geometry statistics accumulated during the same mesh stream that
 * computes the bounding box. Counts are **tessellated mesh** figures produced by
 * web-ifc's mesher, not authored BREP definition points: a swept `IfcSphere`
 * contributes no vertices to the STEP file but hundreds to the mesh. That makes
 * them a render-cost / model-weight metric — which is what the health and
 * insight consumers want — rather than a statement about the source geometry.
 *
 * `vertexCount` sums every placed geometry of the product, so an element that
 * instances one mesh 200 times reports the full expanded count. `uniqueVertexCount`
 * counts each distinct `geometryExpressID` once, so the pair separates "how heavy
 * is this on screen" from "how much distinct geometry does it define".
 */
export interface GeomStats {
  vertexCount: number;
  triangleCount: number;
  uniqueVertexCount: number;
  /** Number of placed geometry parts composing this product's mesh. */
  meshPartCount: number;
}

export interface LoadResult {
  records: RawRecord[];
  schema: string;
  /** World bounding box per express id, for entities that produced geometry. */
  bboxes: Map<number, BBox>;
  /** Tessellated geometry statistics per express id, same population as `bboxes`. */
  geomStats: Map<number, GeomStats>;
}

/**
 * Converts a web-ifc argument value to a string representation that our
 * existing REL_HANDLERS / splitArgs / refId / listRefs helpers can parse.
 *
 * web-ifc argument tokens:
 *   { type: REF, value: number }           → '#123'
 *   { type: STRING, value: string }        → "'value'"
 *   { type: LABEL, value: string }         → 'value'
 *   { type: ENUM, value: string }          → '.VALUE.'
 *   { type: REAL, value: number }          → '1.0'
 *   { type: INTEGER (10), value: number }  → '1'
 *   { type: SET_BEGIN }                    → opens a list
 *   { type: SET_END }                      → closes a list
 *   null / { type: EMPTY/6 }              → '$'
 *   Array                                  → recursive set
 */
/** Re-encode a web-ifc STRING/LABEL value as a STEP string literal, escaping
 *  embedded single-quotes per ISO-10303-21 ('' is one literal quote). */
function quoteStepString(value: unknown): string {
  const s = String(value ?? '').replace(/'/g, "''");
  return `'${s}'`;
}

/**
 * web-ifc WASM objects expose `delete()` to free C++ memory, but some objects
 * returned in 0.0.77 lack it at runtime even though the .d.ts declares it, and a
 * missing `delete()` throws — inside a StreamMeshes callback that aborts the
 * whole stream. Free defensively.
 */
function safeIfcDelete(obj: unknown): void {
  const d = (obj as { delete?: () => void } | null)?.delete;
  if (typeof d === 'function') {
    try { d.call(obj); } catch { /* already freed / no-op */ }
  }
}

function argToString(arg: unknown): string {
  if (arg === null || arg === undefined) return '$';
  if (Array.isArray(arg)) {
    return '(' + arg.map(argToString).join(',') + ')';
  }
  const token = arg as { type: number; value?: unknown };
  switch (token.type) {
    case REF: return `#${token.value as number}`;
    // web-ifc decodes string/label values without their STEP quotes. We must
    // re-quote AND escape embedded single-quotes (→ '') so splitArgs treats the
    // value as one atom — otherwise a value containing a comma (e.g. a Revit
    // "Corridor Space,Terrace Space" text) gets shredded into several args,
    // shifting NominalValue/Unit and corrupting every downstream property.
    case STRING: return quoteStepString(token.value);
    case LABEL: return quoteStepString(token.value);
    case ENUM: return `.${String(token.value ?? '')}.`;
    case REAL: return String(token.value ?? '0');
    case 10: return String(token.value ?? '0'); // INTEGER
    case SET_BEGIN: return '(';
    case SET_END: return ')';
    case 6: return '$'; // EMPTY
    case LINE_END: return '';
    default: {
      if (token.value !== undefined) return String(token.value);
      return '$';
    }
  }
}

/**
 * Converts a web-ifc RawLineData.arguments array into the flat comma-joined
 * args string that our tokenizer helpers (splitArgs, refId, listRefs) expect.
 *
 * Sets/arrays are serialised as '(#1,#2,#3)' which listRefs already handles.
 */
export function argsToString(webIfcArgs: unknown[]): string {
  return webIfcArgs.map(argToString).join(',');
}

export class IfcLoader {
  private api: InstanceType<typeof IfcAPI> | null = null;

  async init(wasmPath?: string): Promise<void> {
    this.api = new IfcAPI();
    if (wasmPath) {
      this.api.SetWasmPath(wasmPath, true);
    }
    // Force single-threaded WASM (web-ifc.wasm, not web-ifc-mt.wasm).
    // The MT variant spawns sub-workers via classic Worker() which conflicts
    // with our own module Worker context. Single-threaded is sufficient since
    // we already run the entire parse inside a Web Worker.
    await this.api.Init(undefined, true);
  }

  async load(
    data: Uint8Array,
    onProgress?: (percent: number, parsed: number) => void,
  ): Promise<LoadResult> {
    if (!this.api) throw new Error('IfcLoader not initialised — call init() first');

    const modelID = this.api.OpenModel(data, {
      COORDINATE_TO_ORIGIN: false,
    });

    if (modelID < 0) throw new Error('web-ifc failed to open model (returned -1)');

    const schema = this.api.GetModelSchema(modelID) ?? 'IFC2X3';

    const allLines = this.api.GetAllLines(modelID);
    const total = allLines.size();
    const records: RawRecord[] = [];
    // Express ids of kept entities — the candidate set for geometry/bbox
    // extraction. Only kept (non-geometry, non-placement, non-rel) entities can
    // become graph nodes, so only they need a bounding box.
    const keptIds: number[] = [];
    let lastPercent = 0;

    for (let i = 0; i < total; i++) {
      const expressID = allLines.get(i);
      try {
        const raw = this.api.GetRawLineData(modelID, expressID);
        // GetNameFromTypeCode returns Pascal case (e.g. "IfcRelAggregates").
        // All downstream code (REL_HANDLERS, SYNTHETIC_RULES, geometry sets) expects
        // upper-case type names, so normalise here.
        const typeName = this.api.GetNameFromTypeCode(raw.type).toUpperCase();

        // Skip geometry and placement types — same as geometry-filter.ts
        if (GEOMETRY_TYPES.has(typeName) || PLACEMENT_TYPES.has(typeName)) continue;

        if (!typeName.startsWith('IFCREL')) keptIds.push(expressID);

        const argsStr = argsToString(raw.arguments);
        const record: RawRecord = { id: expressID, type: typeName, args: argsStr };

        // Attach the typed line (named attributes) for entity field extraction.
        // IfcRel* entities only feed triple extraction from `args`, so skip the
        // extra GetLine call for them (ADR-009, PB-A).
        if (!typeName.startsWith('IFCREL')) {
          try {
            const line = this.api.GetLine(modelID, expressID);
            if (line && typeof line === 'object') record.line = line as TypedLine;
          } catch {
            // Typed read failed — entity falls back to no enriched fields.
          }
        }

        records.push(record);
      } catch {
        // Malformed or unsupported line — skip silently
      }

      if (onProgress) {
        const pct = Math.floor((i / total) * 90);
        if (pct > lastPercent) {
          lastPercent = pct;
          onProgress(pct, records.length);
        }
      }
    }

    // Compute world bounding boxes while the model is still open. This meshes
    // each product's geometry (CPU-heavy) but is the only reliable source of a
    // true world-space extent — the placement chain (element→storey→building→
    // site, with rotation) is baked into web-ifc's flat transformation.
    const { bboxes, geomStats } = this.computeGeometry(modelID, keptIds, onProgress);

    this.api.CloseModel(modelID);
    onProgress?.(100, records.length);

    return { records, schema, bboxes, geomStats };
  }

  /**
   * Stream meshes for `expressIDs` and accumulate, per entity that produces
   * geometry, an axis-aligned world bbox **and** its tessellated vertex /
   * triangle counts. Both come from the same pass: the bbox loop already visits
   * every vertex, so the counts cost a few additions rather than a second
   * meshing run (which is the expensive part).
   *
   * Non-physical entities (no geometry) are simply absent from both maps. Runs
   * with COORDINATE_TO_ORIGIN off (see OpenModel above) so coordinates stay in
   * the model's own world frame — consistent across a federated set that shares
   * a survey origin.
   */
  private computeGeometry(
    modelID: number,
    expressIDs: number[],
    onProgress?: (percent: number, parsed: number) => void,
  ): { bboxes: Map<number, BBox>; geomStats: Map<number, GeomStats> } {
    const bboxes = new Map<number, BBox>();
    const geomStats = new Map<number, GeomStats>();
    if (!this.api || expressIDs.length === 0) return { bboxes, geomStats };

    try {
      this.api.StreamMeshes(modelID, expressIDs, (flatMesh) => {
        try {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          let vertexCount = 0;
          let triangleCount = 0;
          let uniqueVertexCount = 0;
          let meshPartCount = 0;
          // Distinct source meshes, so an element instancing one geometry N
          // times is not counted as N times the unique geometry.
          const seenGeometry = new Set<number>();
          const placed = flatMesh.geometries;

          for (let i = 0; i < placed.size(); i++) {
            const pg = placed.get(i);
            const ifcGeo = this.api!.GetGeometry(modelID, pg.geometryExpressID);
            const vptr = ifcGeo.GetVertexData();
            const vsize = ifcGeo.GetVertexDataSize();
            if (vsize === 0) { safeIfcDelete(ifcGeo); continue; }
            const verts = this.api!.GetVertexArray(vptr, vsize);
            const m = pg.flatTransformation; // 4x4 column-major world transform

            // web-ifc interleaves [px,py,pz, nx,ny,nz] — 6 floats per vertex, so
            // the float count divided by 6 is the vertex count. Indices are a
            // flat triangle list, 3 per face.
            const partVerts = Math.floor(vsize / 6);
            vertexCount += partVerts;
            triangleCount += Math.floor(ifcGeo.GetIndexDataSize() / 3);
            meshPartCount++;
            if (!seenGeometry.has(pg.geometryExpressID)) {
              seenGeometry.add(pg.geometryExpressID);
              uniqueVertexCount += partVerts;
            }

            for (let v = 0; v < verts.length; v += 6) {
              const lx = verts[v]!, ly = verts[v + 1]!, lz = verts[v + 2]!;
              // Apply the column-major 4x4 to the local vertex → world position.
              const wx = m[0]! * lx + m[4]! * ly + m[8]!  * lz + m[12]!;
              const wy = m[1]! * lx + m[5]! * ly + m[9]!  * lz + m[13]!;
              const wz = m[2]! * lx + m[6]! * ly + m[10]! * lz + m[14]!;
              if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
              if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
              if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
            }
            safeIfcDelete(ifcGeo);
          }

          if (minX <= maxX) {
            bboxes.set(flatMesh.expressID, [minX, minY, minZ, maxX, maxY, maxZ]);
          }
          // Recorded even when the bbox is degenerate: a product that meshed to
          // zero vertices is exactly what the "geometry-free product" health
          // check looks for, and dropping the row would hide it.
          if (meshPartCount > 0 || minX <= maxX) {
            geomStats.set(flatMesh.expressID, {
              vertexCount, triangleCount, uniqueVertexCount, meshPartCount,
            });
          }
        } finally {
          safeIfcDelete(flatMesh);
        }
      });
    } catch (err) {
      // Meshing failed wholesale (e.g. a corrupt geometry stream) — fall back to
      // whatever boxes were accumulated before the throw rather than aborting the
      // whole parse. Location filtering degrades gracefully to "no location".
      console.warn('[ifc-loader] geometry streaming aborted:', err);
    }

    onProgress?.(99, expressIDs.length);
    return { bboxes, geomStats };
  }

  dispose(): void {
    this.api = null;
  }
}
