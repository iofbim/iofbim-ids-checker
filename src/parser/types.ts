/**
 * Parser/extraction schema version. Bump whenever the parser, tokenizer, or
 * extractor changes how entities/triples/property values are produced. The
 * persistence cache key (JSON model cache + Arrow snapshot) folds this in, so a
 * bump auto-invalidates every stored snapshot and forces a clean re-parse —
 * preventing a fixed parser from being masked by a stale cache.
 *
 * Versioning scheme (since app 1.0.0, the first deployed release):
 * `<app major>.<2-digit serial>` as a STRING — `'1.01'`, `'1.02'`, … `'1.10'`.
 * A string, not a number: `1.10` and `1.1` are the same *number*, so the tenth
 * bump would silently collide with the first and reuse its stale caches.
 * The major tracks the app's major line; the serial increments per parser
 * change within it. Reset to `<n>.01` when the app goes to a new major.
 *
 * The pre-1.0 line ran 1…12 as bare integers; that history is in the changelog
 * (search "PARSER_VERSION") and in docs/decisions/023. It is not repeated here
 * because none of those caches can survive the switch to the string scheme —
 * every key changed shape, so 1.01 re-parses everything exactly once.
 *
 * History:
 *   1.01 — first deployed parser (app 1.0.0, 2026-09-04). Content is pre-1.0
 *          v12: schema-derived geometry filtering (IFC_GEOMETRY_TYPES),
 *          corrected IfcRelConnects* arg indices, IfcRelConnectsWithEccentricity,
 *          IfcQuantityNumber decoding, and list-valued raw attributes fanned out
 *          one row per member (ADR-023).
 *   1.02 — geometry statistics captured during the parse-time mesh stream:
 *          vertexCount / triangleCount / uniqueVertexCount / meshPartCount on
 *          every geometry-bearing entity (ADR-025). Requires a re-parse because
 *          cached models carry no counts and would read as zero-vertex elements.
 *   1.03 — emptyAttrs: the common string attributes authored as '' (read as null),
 *          so an IDS optional attribute facet can tell "present but empty" (must
 *          match, so fails) from "absent" ($, passes).
 *   1.04 — IfcExternalReferenceRelationship: resources that are not IfcRoot (e.g.
 *          IfcMaterial) get their classification references as edges.
 *   1.05 — styling/presentation classes (IfcSurfaceStyleRendering,
 *          IfcSurfaceStyleRefraction, colours, …) kept as entities instead of
 *          being filtered as geometry; web-ifc measure envelopes
 *          (`_internalValue`) are unwrapped so numeric attributes are stored.
 *   1.06 — multi-valued IfcProperty* subtypes (enumerated / list / bounded /
 *          table) keep every authored value in `propValues`, each SI-normalized
 *          to the IDS unit so an IDS value check can test each one.
 *   1.07 — pset_properties carries the value's IFC data type (`propType`), and
 *          single-value measures resolve their unit from that measure (SI
 *          conversion), so IDS dataType and unit comparisons work.
 */
export const PARSER_VERSION = '1.07';

/**
 * One authored value of a multi-valued IfcProperty* subtype
 * (IfcPropertyEnumeratedValue / ListValue / BoundedValue / TableValue).
 *
 * `measure` is the IFC measure wrapper the value was authored in (e.g.
 * `IFCLENGTHMEASURE`) and `unitRef` the record's explicit unit reference, if
 * any. The extractor fills `si` (value normalized to the IDS SI base unit) and
 * `unit` once the model's units are resolved.
 */
export interface PropertySubtypeValue {
  value: string;
  measure: string | null;
  unitRef: number | null;
  si?: number | null;
  unit?: string | null;
}

export interface IfcEntity {
  id: number;
  type: string;
  /** IfcRoot arg[0] — 22-char IFC GlobalId */
  globalId?: string | null;
  name: string | null;
  /** IfcRoot arg[3] */
  description?: string | null;
  /** IfcObject arg[4] — user-defined subtype override */
  objectType?: string | null;
  /** IfcExternalReference arg[1] — classification code, doc id, etc. */
  identification?: string | null;
  /** IfcElement arg[6–9] depending on schema — physical mark/tag */
  tag?: string | null;
  /** Last enum arg on most IfcProduct subtypes — e.g. WALL, COLUMN, DOOR */
  predefinedType?: string | null;
  /**
   * Lower-case names of the common string attributes (name, description, …) authored as
   * an empty string: those read as null like `$`, but IDS tells them apart (an optional
   * attribute facet fails on '' and passes on $). Absent when none.
   */
  emptyAttrs?: string[];
  /** IfcSpatialElement / IfcSpace — human-readable long name */
  longName?: string | null;
  coords?: [number, number, number];
  /**
   * World-space axis-aligned bounding box `[minX,minY,minZ,maxX,maxY,maxZ]`,
   * computed by meshing the element's geometry at parse time (ifc-loader). Only
   * present for entities that produce geometry (physical products); non-physical
   * entities (materials, classifications, tasks, …) have none. Powers the
   * spatial query filters (proximity / elevation / bounding box). See {@link BBox}.
   */
  bbox?: [number, number, number, number, number, number];
  /**
   * Tessellated mesh vertex count, summed over every placed geometry of this
   * product. Counted during the same parse-time mesh stream as `bbox`, so it is
   * present on exactly the same population (geometry-bearing entities).
   *
   * This is a **render-cost / model-weight** figure from web-ifc's mesher, not a
   * count of authored BREP points: a swept solid has no vertices in the STEP
   * file but many in the mesh. Instanced geometry is counted once per placement,
   * so a curtain wall with 200 identical mullions reports the full expanded
   * count — see `uniqueVertexCount` for the deduplicated figure.
   */
  vertexCount?: number;
  /** Tessellated triangle count, summed over every placed geometry. */
  triangleCount?: number;
  /** Vertex count with each distinct source mesh counted once (instancing removed). */
  uniqueVertexCount?: number;
  /** Number of placed geometry parts composing this product's mesh. */
  meshPartCount?: number;
  /** Decoded property value — the aggregate display for a multi-valued property */
  propValue?: string | null;
  /**
   * Every authored value of a multi-valued IfcProperty* subtype. The IDS
   * property facet tests each one (property-facet.md: with a simple IDS value,
   * ANY IFC value may match), so the store gets one row per value.
   */
  propValues?: PropertySubtypeValue[];
  /**
   * IFC value type of the property's value (e.g. `IFCLENGTHMEASURE`,
   * `IFCLABEL`), from the web-ifc typed value box. An IDS `dataType` must match
   * this exactly, and measure types are converted to SI before comparison.
   */
  propType?: string | null;
  /** Resolved property unit label (e.g. MILLIMETRE) — IfcPropertySingleValue (PB-B) */
  propUnit?: string | null;
  /** Property value normalized to SI base units, when numeric (PB-B) */
  propValueSi?: number | null;
  /** Decoded quantity value — set only on IfcQuantity* entities */
  qtyValue?: string | null;
  /** IFC measure type of the quantity's value (e.g. `IFCLENGTHMEASURE`). */
  qtyType?: string | null;
  /** Resolved quantity unit label (e.g. SQUARE METRE) — IfcQuantity* (PB-B) */
  qtyUnit?: string | null;
  /** Quantity value normalized to SI base units, when numeric (PB-B) */
  qtyValueSi?: number | null;
  /**
   * Every direct STEP attribute of this entity, in schema declaration order.
   * Populated in `recordToEntity` for non-IfcRel entities so the Properties
   * panel can show the complete attribute list, not just the curated Tier-1
   * fields. See {@link RawAttribute}.
   */
  rawAttributes?: RawAttribute[];
}

/**
 * One direct attribute of an entity, as shown in the Properties panel's
 * "All Attributes" section.
 *   - `name`   — schema attribute name (from the web-ifc typed line) or `[n]`
 *                when only positional args are available.
 *   - `ref`    — express id when the attribute is a single `#id` reference, so
 *                the panel can render a clickable chip; else null.
 *   - `value`  — decoded **display** string (null for `$` / `*` / empty). For a
 *                SET/LIST attribute this is an abbreviated summary, truncated to
 *                the first few members with a `(+N)` suffix — it is for humans,
 *                never for matching.
 *   - `values` — present only for a SET/LIST attribute: the complete, untruncated
 *                member values. This is what `entity_attributes` is ingested from
 *                (one row per member), so an IDS attribute facet on a list-valued
 *                attribute (IfcOrganization.Roles, …) matches a real member
 *                rather than the abbreviated display string.
 */
export interface RawAttribute {
  name: string;
  ref: number | null;
  value: string | null;
  values?: string[];
}

/** Subject–predicate–object triple derived from an IfcRel* entity */
export interface Triple {
  subject: number;
  predicate: string;
  object: number;
  /**
   * Optional edge sub-label. Set by the Tier-2 generic `references` fallback to
   * the source STEP attribute slot name (`ForLayerSet`, `RelatingStructure`, …)
   * so the renderer can show the reference *role* instead of the flat `Ref`.
   * Render-time only — not persisted to DuckDB/Arrow.
   */
  detail?: string;
}

/** Lightweight index built after parsing; supports on-demand lookup. */
export type EntityIndex = Map<number, IfcEntity>;

export interface ParsedModel {
  entities: EntityIndex;
  triples: Triple[];
  /** IFC schema version detected from FILE_SCHEMA header */
  schema: string;
  /** Source filename */
  filename: string;
  /** Stable unique ID: sha256.slice(0,8) + '_' + sanitised filename */
  modelId: string;
  /** Accent color assigned from the model palette */
  accentColor: string;
  /** Full SHA-256 hex of the source file text — used for revision matching */
  sha256: string;
}
