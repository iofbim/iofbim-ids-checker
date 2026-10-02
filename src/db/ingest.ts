/**
 * Ingests a fully-parsed ParsedModel into DuckDB tables.
 *
 * Uses Apache Arrow RecordBatches for bulk insertion (10-50× faster than
 * row-by-row parameterised INSERTs for models with >10k entities).
 *
 * The function is idempotent — it drops existing rows for modelId first.
 */

import { tableFromArrays, tableToIPC } from 'apache-arrow';
import * as duckdb from '@duckdb/duckdb-wasm';
import type { ParsedModel } from '../parser/types.js';
import { getDb, setIngestPromise } from './client.js';
import { MATERIALIZED_TABLES } from './schema.js';
import { canonicalizeGlobalId } from '../parser/guid.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest model into DuckDB asynchronously.
 * Registers an ingest promise via setIngestPromise() so queries can await it.
 */
export function ingestModel(model: ParsedModel): void {
  const p = ingestModelAsync(model);
  setIngestPromise(model.modelId, p);
}

async function ingestModelAsync(model: ParsedModel): Promise<void> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    await dropModelRows(conn, model.modelId);
    await insertEntities(db, conn, model);
    await insertTriples(db, conn, model);
    await insertPsets(db, conn, model);
    await insertEntityAttributes(db, conn, model);
    // classifications / materials / documents are SQL views over the base
    // tables above (ADR-016.1) — no per-model insert.
  } finally {
    await conn.close();
  }
}

// ---------------------------------------------------------------------------
// Drop existing rows
// ---------------------------------------------------------------------------

async function dropModelRows(conn: duckdb.AsyncDuckDBConnection, modelId: string): Promise<void> {
  const safe = modelId.replace(/'/g, "''");
  for (const t of MATERIALIZED_TABLES) {
    await conn.query(`DELETE FROM ${t} WHERE model_id = '${safe}'`);
  }
}

// ---------------------------------------------------------------------------
// Arrow bulk-insert helpers
// ---------------------------------------------------------------------------

async function insertArrowTable(
  _db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  tableName: string,
  arrowTable: ReturnType<typeof tableFromArrays>,
): Promise<void> {
  if (arrowTable.numRows === 0) return;
  // Serialize to IPC bytes (our apache-arrow), then insert via bytes API
  // to avoid the apache-arrow version mismatch between our package and duckdb's bundled copy.
  const ipc = tableToIPC(arrowTable, 'stream');
  await conn.insertArrowFromIPCStream(ipc, { name: tableName, create: false });
}

// ---------------------------------------------------------------------------
// entities table
// ---------------------------------------------------------------------------

async function insertEntities(
  db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  model: ParsedModel,
): Promise<void> {
  const modelIds:       string[]  = [];
  const entityIds:      number[]  = [];
  const ifcTypes:       string[]  = [];
  const names:          (string | null)[] = [];
  const globalIds:      (string | null)[] = [];
  const globalIdsCanon: (string | null)[] = [];
  const descriptions:   (string | null)[] = [];
  const objectTypes:    (string | null)[] = [];
  const tags:           (string | null)[] = [];
  const predefinedTypes:(string | null)[] = [];
  const longNames:      (string | null)[] = [];
  const identifications:(string | null)[] = [];
  // Nullable Float64 columns — a plain (number|null)[] so Arrow keeps a nullable
  // DOUBLE (a Float64Array can't hold null). Entities without geometry get null.
  const bMinX: (number | null)[] = [];
  const bMinY: (number | null)[] = [];
  const bMinZ: (number | null)[] = [];
  const bMaxX: (number | null)[] = [];
  const bMaxY: (number | null)[] = [];
  const bMaxZ: (number | null)[] = [];
  // Geometry statistics — nullable INTEGER, same population as the bbox columns.
  // Null (no geometry) and 0 (meshed to nothing) are deliberately distinct.
  const vertCounts:   (number | null)[] = [];
  const triCounts:    (number | null)[] = [];
  const uniqVerts:    (number | null)[] = [];
  const meshParts:    (number | null)[] = [];

  for (const [id, e] of model.entities) {
    if (e.type.toUpperCase().startsWith('IFCREL')) continue;
    modelIds.push(model.modelId);
    entityIds.push(id);
    ifcTypes.push(e.type);
    names.push(e.name ?? null);
    globalIds.push(e.globalId ?? null);
    globalIdsCanon.push(canonicalizeGlobalId(e.globalId));
    descriptions.push(e.description ?? null);
    objectTypes.push(e.objectType ?? null);
    tags.push(e.tag ?? null);
    predefinedTypes.push(e.predefinedType ?? null);
    longNames.push(e.longName ?? null);
    identifications.push(e.identification ?? null);
    const bb = e.bbox ?? null;
    bMinX.push(bb ? bb[0] : null); bMinY.push(bb ? bb[1] : null); bMinZ.push(bb ? bb[2] : null);
    bMaxX.push(bb ? bb[3] : null); bMaxY.push(bb ? bb[4] : null); bMaxZ.push(bb ? bb[5] : null);
    vertCounts.push(e.vertexCount ?? null);
    triCounts.push(e.triangleCount ?? null);
    uniqVerts.push(e.uniqueVertexCount ?? null);
    meshParts.push(e.meshPartCount ?? null);
  }

  const table = tableFromArrays({
    model_id:        modelIds,
    entity_id:       new Int32Array(entityIds),
    ifc_type:        ifcTypes,
    name:            names,
    global_id:       globalIds,
    global_id_canonical: globalIdsCanon,
    description:     descriptions,
    object_type:     objectTypes,
    tag:             tags,
    predefined_type: predefinedTypes,
    long_name:       longNames,
    identification:  identifications,
    bbox_min_x:      bMinX,
    bbox_min_y:      bMinY,
    bbox_min_z:      bMinZ,
    bbox_max_x:      bMaxX,
    bbox_max_y:      bMaxY,
    bbox_max_z:      bMaxZ,
    vertex_count:        vertCounts,
    triangle_count:      triCounts,
    unique_vertex_count: uniqVerts,
    mesh_part_count:     meshParts,
  });

  await insertArrowTable(db, conn, 'entities', table);
}

// ---------------------------------------------------------------------------
// triples table
// ---------------------------------------------------------------------------

async function insertTriples(
  db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  model: ParsedModel,
): Promise<void> {
  const modelIds:   string[]  = [];
  const subjects:   number[]  = [];
  const predicates: string[]  = [];
  const objects:    number[]  = [];

  for (const t of model.triples) {
    modelIds.push(model.modelId);
    subjects.push(t.subject);
    predicates.push(t.predicate);
    objects.push(t.object);
  }

  const table = tableFromArrays({
    model_id:  modelIds,
    subject:   new Int32Array(subjects),
    predicate: predicates,
    object:    new Int32Array(objects),
  });

  await insertArrowTable(db, conn, 'triples', table);
}

// ---------------------------------------------------------------------------
// pset_properties table
// Walk (occurrence): entity → IfcRelDefinesByProperties → IfcPropertySet → hasProperty → value
// Walk (type):       IFC*TYPE → hasPropertySet          → IfcPropertySet → hasProperty → value
// IfcComplexProperty nodes carry no value of their own; recurse through their
// own hasProperty children so nested leaf values are not dropped.
// See ADR-016.
// ---------------------------------------------------------------------------

async function insertPsets(
  db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  model: ParsedModel,
): Promise<void> {
  const outEdges = buildOutEdges(model);

  const modelIds:   string[] = [];
  const entityIds:  number[] = [];
  const psetNames:  string[] = [];
  const propNames:  string[] = [];
  const values:     (string | null)[] = [];
  const valuesNum:  (number | null)[] = [];
  const valuesSi:   (number | null)[] = [];
  const units:      (string | null)[] = [];

  // Emit one row for a resolved leaf property/quantity. IfcComplexProperty
  // nodes have no value — recurse into their hasProperty children instead.
  // `seen` guards against pathological cyclic complex-property graphs.
  function emitProperty(
    entityId: number,
    psetName: string,
    propId: number,
    seen: Set<number>,
  ): void {
    if (seen.has(propId)) return;
    seen.add(propId);
    const propEntity = model.entities.get(propId);
    if (!propEntity) return;

    if (propEntity.type.toUpperCase() === 'IFCCOMPLEXPROPERTY') {
      for (const { predicate: cp, object: childId } of outEdges.get(propId) ?? []) {
        if (cp !== 'hasProperty') continue;
        emitProperty(entityId, psetName, childId, seen);
      }
      return;
    }

    const propName = propEntity.name;
    if (!propName) return;

    const rawVal = propEntity.propValue ?? propEntity.qtyValue ?? null;
    // SI-normalized value resolved at parse time (PB-B); fall back to the
    // authored number when no unit was resolvable so numeric queries still
    // work. Stored at full precision — display rounding is a UI concern.
    const siVal = propEntity.propValueSi ?? propEntity.qtyValueSi ?? toNum(rawVal);
    modelIds.push(model.modelId);
    entityIds.push(entityId);
    psetNames.push(psetName);
    propNames.push(propName);
    values.push(rawVal);
    valuesNum.push(toNum(rawVal));
    valuesSi.push(siVal);
    units.push(propEntity.propUnit ?? propEntity.qtyUnit ?? null);
  }

  for (const [entityId] of model.entities) {
    const edges = outEdges.get(entityId) ?? [];
    for (const { predicate, object: psetId } of edges) {
      // Occurrence psets (IfcRelDefinesByProperties) and type psets
      // (synthetic hasPropertySet from IfcTypeObject.HasPropertySets) both
      // resolve to an IfcPropertySet/IfcElementQuantity with hasProperty leaves.
      if (predicate !== 'IfcRelDefinesByProperties' && predicate !== 'hasPropertySet') continue;
      const psetEntity = model.entities.get(psetId);
      if (!psetEntity) continue;
      const psetName = psetEntity.name ?? psetEntity.type;

      const propEdges = outEdges.get(psetId) ?? [];
      for (const { predicate: pp, object: propId } of propEdges) {
        if (pp !== 'hasProperty' && pp !== 'hasQuantity') continue;
        emitProperty(entityId, psetName, propId, new Set());
      }
    }
  }

  const table = tableFromArrays({
    model_id:      modelIds,
    entity_id:     new Int32Array(entityIds),
    pset_name:     psetNames,
    property_name: propNames,
    value:         values,
    // Plain (number|null)[] so Arrow encodes a nullable Float64 column —
    // a Float64Array cannot hold null.
    value_num:     valuesNum,
    value_si:      valuesSi,
    unit:          units,
  });

  await insertArrowTable(db, conn, 'pset_properties', table);
}


// ---------------------------------------------------------------------------
// entity_attributes table
//
// One row per direct STEP attribute (from IfcEntity.rawAttributes) of each
// non-IfcRel entity, so IDS attribute facets can query attributes that aren't
// Tier-1 columns (IfcPerson.FamilyName, IfcOrganization.Roles, …). Positional
// fallbacks (`[n]`) are skipped — an IDS facet only ever names a schema
// attribute, never a bare index. Reference-only attributes (`ref` set, no
// scalar value) are stored with their display value so a presence check passes.
// ---------------------------------------------------------------------------

async function insertEntityAttributes(
  db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  model: ParsedModel,
): Promise<void> {
  const modelIds:  string[] = [];
  const entityIds: number[] = [];
  const attrNames: string[] = [];
  // Always a string, never null: an absent attribute is stored as '' so the
  // Arrow column is unambiguously Utf8. `tableFromArrays` infers a column's type
  // from its values, and a leading run of nulls makes it guess Float64 — which
  // silently drops the whole (mostly-null) batch on insert. Empty-string is the
  // "missing" sentinel here; the facet SQL already treats `value != ''` as
  // presence, so this matches the intended semantics.
  const values:    string[] = [];

  for (const [id, e] of model.entities) {
    if (e.type.toUpperCase().startsWith('IFCREL')) continue;
    if (!e.rawAttributes) continue;
    for (const a of e.rawAttributes) {
      // Skip positional `[n]` fallbacks — not addressable by a named IDS facet.
      if (a.name.startsWith('[')) continue;
      // A SET/LIST attribute becomes ONE ROW PER MEMBER, from the untruncated
      // `values`. `a.value` is only an abbreviated display summary ("A, B (+7)"),
      // so matching against it would make an IDS facet like Roles='ARCHITECT'
      // fail on any list longer than four, and fail on every non-first member.
      // Fanning out means the facet's EXISTS finds the member directly.
      if (a.values) {
        for (const v of a.values) {
          if (v === '' || v === '$') continue;
          modelIds.push(model.modelId);
          entityIds.push(id);
          attrNames.push(a.name);
          values.push(v);
        }
        continue;
      }
      modelIds.push(model.modelId);
      entityIds.push(id);
      attrNames.push(a.name);
      // A reference-only attribute (`ref` set, no scalar) is still present —
      // store its `#id` chip label so a presence check passes; '' means absent.
      values.push(a.value ?? (a.ref !== null ? `#${a.ref}` : ''));
    }
  }

  const table = tableFromArrays({
    model_id:  modelIds,
    entity_id: new Int32Array(entityIds),
    attr_name: attrNames,
    value:     values,
  });

  await insertArrowTable(db, conn, 'entity_attributes', table);
}

// ---------------------------------------------------------------------------
// Numeric coercion for value_num
// ---------------------------------------------------------------------------

/**
 * Coerce a raw STEP value string to a number for the typed `value_num` column.
 * Returns null for empty/non-numeric values (e.g. booleans `.T.`/`.F.`, labels).
 * Full unit/SI normalization is deferred to PB (ADR-009).
 */
function toNum(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Shared adjacency helpers
// ---------------------------------------------------------------------------

function buildOutEdges(model: ParsedModel): Map<number, Array<{ predicate: string; object: number }>> {
  const out = new Map<number, Array<{ predicate: string; object: number }>>();
  for (const t of model.triples) {
    let arr = out.get(t.subject);
    if (!arr) { arr = []; out.set(t.subject, arr); }
    arr.push({ predicate: t.predicate, object: t.object });
  }
  return out;
}
