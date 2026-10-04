import type * as duckdb from '@duckdb/duckdb-wasm';

/** Levels of ReferencedSource walked above a classification reference */
const CLASSIFICATION_DEPTH = 8;

/**
 * (model_id, ref_id, node_id) for every classification entity and each entity above it in
 * its ReferencedSource chain (parent --hasClassificationReference--> child), the entity
 * itself included: one SELECT per level, joined up `depth` times.
 */
function classificationChainSql(depth: number): string {
  const levels: string[] = [];
  for (let d = 0; d <= depth; d++) {
    const joins = Array.from({ length: d }, (_, i) => {
      const child = i === 0 ? 'r.entity_id' : `h${i}.subject`;
      return `JOIN triples h${i + 1} ON h${i + 1}.model_id = r.model_id AND h${i + 1}.object = ${child} AND h${i + 1}.predicate = 'hasClassificationReference'`;
    });
    levels.push([
      `SELECT r.model_id, r.entity_id AS ref_id, ${d === 0 ? 'r.entity_id' : `h${d}.subject`} AS node_id`,
      'FROM entities r',
      ...joins,
      "WHERE upper(r.ifc_type) IN ('IFCCLASSIFICATIONREFERENCE', 'IFCCLASSIFICATION')",
    ].join('\n'));
  }
  return levels.join('\nUNION ALL\n');
}

export const DDL = `
CREATE TABLE IF NOT EXISTS entities (
  model_id            VARCHAR NOT NULL,
  entity_id           INTEGER NOT NULL,
  ifc_type            VARCHAR NOT NULL,
  name                VARCHAR,
  global_id           VARCHAR,   -- raw authored GlobalId (22-char or expanded)
  global_id_canonical VARCHAR,   -- normalized lowercase hyphenated GUID (PC C2.1)
  description         VARCHAR,
  object_type         VARCHAR,
  tag                 VARCHAR,
  predefined_type     VARCHAR,
  long_name           VARCHAR,
  identification      VARCHAR,
  -- Common string attributes authored as '' (stored above as NULL), as ",name,tag,"
  empty_attrs         VARCHAR,
  -- World-space axis-aligned bounding box (metres), meshed at parse time.
  -- NULL for non-physical entities that produced no geometry. Powers the
  -- spatial query filters (proximity / elevation / bounding box).
  bbox_min_x          DOUBLE,
  bbox_min_y          DOUBLE,
  bbox_min_z          DOUBLE,
  bbox_max_x          DOUBLE,
  bbox_max_y          DOUBLE,
  bbox_max_z          DOUBLE,
  -- Tessellated mesh statistics from the same parse-time mesh stream as the
  -- bbox. NULL for entities that produced no geometry (same population as the
  -- bbox columns), so "no geometry" and "meshed to zero vertices" stay
  -- distinguishable: the latter is 0, not NULL, and is a real health signal.
  -- These are render-cost figures, not authored BREP point counts.
  vertex_count        INTEGER,
  triangle_count      INTEGER,
  -- Vertex count with each distinct source mesh counted once, so an element
  -- instancing one geometry N times is not inflated N-fold.
  unique_vertex_count INTEGER,
  mesh_part_count     INTEGER,
  PRIMARY KEY (model_id, entity_id)
);
-- Heaviest-element and geometry-outlier queries scan on this ordering.
CREATE INDEX IF NOT EXISTS idx_entities_verts ON entities (model_id, vertex_count);
-- Federation/diff match key — entities sharing a canonical GlobalId across
-- models are the same real-world thing (ADR-008).
CREATE INDEX IF NOT EXISTS idx_entities_guid ON entities (global_id_canonical);

CREATE TABLE IF NOT EXISTS triples (
  model_id  VARCHAR  NOT NULL,
  subject   INTEGER  NOT NULL,
  predicate VARCHAR  NOT NULL,
  object    INTEGER  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triples_subj ON triples (model_id, subject);
CREATE INDEX IF NOT EXISTS idx_triples_obj  ON triples (model_id, object);

CREATE TABLE IF NOT EXISTS pset_properties (
  model_id      VARCHAR NOT NULL,
  entity_id     INTEGER NOT NULL,
  pset_name     VARCHAR NOT NULL,
  property_name VARCHAR NOT NULL,
  value         VARCHAR,           -- authored value as text; NULL for $, '' and LOGICAL unknown
  value_num     DOUBLE,            -- authored value as a number, when numeric
  value_si      DOUBLE,            -- value normalized to SI base units (PB-B)
  unit          VARCHAR,           -- resolved authored unit label, e.g. MILLIMETRE
  -- IFC value type of the property/quantity (IFCLENGTHMEASURE, IFCLABEL, …).
  -- An IDS dataType must equal this, and a measure is compared in SI (value_si).
  data_type     VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_pset ON pset_properties (model_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_pset_name ON pset_properties (model_id, pset_name, property_name);

-- The property sets an entity actually has for IDS: its own occurrence property
-- sets (IfcRelDefinesByProperties → row with entity_id = the element) plus the
-- property sets it inherits from its type (IfcRelDefinesByType is stored
-- subject = type, object = occurrence). An occurrence property set overrides the
-- type's set of the same name (test case
-- properties_can_be_overriden_by_an_occurrence), so an inherited row is dropped
-- when the occurrence already defines that property-set name.
CREATE VIEW IF NOT EXISTS effective_properties AS
SELECT pp.model_id, pp.entity_id, pp.pset_name, pp.property_name,
       pp.value, pp.value_num, pp.value_si, pp.unit, pp.data_type
FROM pset_properties pp
UNION ALL
SELECT tp.model_id, dt.object AS entity_id, tp.pset_name, tp.property_name,
       tp.value, tp.value_num, tp.value_si, tp.unit, tp.data_type
FROM triples dt
JOIN pset_properties tp
  ON tp.model_id = dt.model_id AND tp.entity_id = dt.subject
WHERE dt.predicate = 'IfcRelDefinesByType'
  AND NOT EXISTS (
    SELECT 1 FROM pset_properties dp
    WHERE dp.model_id = dt.model_id AND dp.entity_id = dt.object
      AND dp.pset_name = tp.pset_name
  );

-- Every direct STEP attribute of a non-IfcRel entity, in schema order, as text.
-- The entities table only materializes the curated Tier-1 columns (name, tag,
-- predefined_type, …); IDS attribute facets can reference ANY schema attribute
-- (IfcPerson.FamilyName, IfcOrganization.Roles, …), so those live here. Without
-- this table an attribute facet on a non-Tier-1 name is always-false → every
-- applicable entity is a false-negative failure.
CREATE TABLE IF NOT EXISTS entity_attributes (
  model_id   VARCHAR NOT NULL,
  entity_id  INTEGER NOT NULL,
  attr_name  VARCHAR NOT NULL,   -- schema attribute name, e.g. "FamilyName"
  value      VARCHAR             -- decoded display value; NULL for $ / * / empty
);
CREATE INDEX IF NOT EXISTS idx_entity_attr ON entity_attributes (model_id, entity_id, attr_name);

-- classifications / materials / documents are DERIVED views over triples ⋈
-- entities, not materialized tables (ADR-016.1). Each is a one-hop walk whose
-- values (system/code/name/title/location) all live on the entities table, so
-- expressing the traversal as a join means it can never silently drop a
-- predicate path the way a hand walk can. The base tables carry (model_id,
-- subject/object) indexes, so these joins are indexed. Views need no snapshot —
-- they rebuild from entities/triples on reload.
--
-- The IfcRelAssociates* rel-entity is NOT a node in triples: the extractor
-- collapses it to a direct edge subject=decorated element, object=reference
-- (see extractor.ts). So each view is a single subject→object hop, joined to
-- entities on the object for the reference's scalar fields. The reference type
-- is filtered so an unrelated same-predicate edge cannot leak in.

-- Classification system and codes per classification entity, as IDS reads them
-- (specifications.md, classification facet). A reference's system is the Name of the
-- IfcClassification at the root of its ReferencedSource chain (the parser emits each
-- link as parent --hasClassificationReference--> reference); its codes are the
-- Identification of the reference and of every reference above it, so a value EF_25_10
-- matches an element classified EF_25_10_25. An element associated straight to an
-- IfcClassification ("lightweight") has the system and no code. A reference with no
-- root has system ''. The chain is walked to a fixed depth (CLASSIFICATION_DEPTH levels
-- above the reference) by joins, not a recursive CTE: DuckDB fails to bind a recursive
-- CTE in a view used from a correlated EXISTS.
CREATE VIEW IF NOT EXISTS classification_chain AS
${classificationChainSql(CLASSIFICATION_DEPTH)};

CREATE VIEW IF NOT EXISTS classification_codes AS
WITH roots AS (
  SELECT u.model_id, u.ref_id, max(COALESCE(n.name, '')) AS system
  FROM classification_chain u
  JOIN entities n ON n.model_id = u.model_id AND n.entity_id = u.node_id
  WHERE upper(n.ifc_type) = 'IFCCLASSIFICATION'
  GROUP BY u.model_id, u.ref_id
)
SELECT DISTINCT u.model_id                 AS model_id,
       u.ref_id                            AS ref_id,
       COALESCE(r.system, '')              AS system,
       CASE WHEN upper(n.ifc_type) = 'IFCCLASSIFICATIONREFERENCE' THEN n.identification END AS code
FROM classification_chain u
JOIN entities n ON n.model_id = u.model_id AND n.entity_id = u.node_id
LEFT JOIN roots r ON r.model_id = u.model_id AND r.ref_id = u.ref_id
WHERE upper(n.ifc_type) = 'IFCCLASSIFICATIONREFERENCE'
   OR u.node_id = u.ref_id;

-- Classifications of each element: its own (IfcRelAssociatesClassification, and
-- IfcExternalReferenceRelationship for resources, both stored as the same edge), plus
-- those of its type (IfcRelDefinesByType, stored subject = type, object = occurrence)
-- in any system the occurrence does not classify itself — occurrences override the
-- type per system. code is NULL for a lightweight classification.
CREATE VIEW IF NOT EXISTS classifications AS
WITH own AS (
  SELECT t.model_id, t.subject AS entity_id, cc.system, cc.code
  FROM triples t
  JOIN classification_codes cc ON cc.model_id = t.model_id AND cc.ref_id = t.object
  WHERE t.predicate = 'IfcRelAssociatesClassification'
)
SELECT model_id, entity_id, system, code FROM own
UNION
SELECT dt.model_id, dt.object AS entity_id, ty.system, ty.code
FROM triples dt
JOIN own ty ON ty.model_id = dt.model_id AND ty.entity_id = dt.subject
WHERE dt.predicate = 'IfcRelDefinesByType'
  AND NOT EXISTS (
    SELECT 1 FROM own o
    WHERE o.model_id = dt.model_id AND o.entity_id = dt.object AND o.system = ty.system
  );

-- material_entity_id is the STEP express id of the material-related node the
-- name/category came from — NOT a UUID and NOT stable across re-exports. It is
-- carried purely as a join key so a probe can walk one further hop, material →
-- hasMaterialClassification → classification reference, to reach an external
-- environmental-dataset identifier. An IfcMaterial is not an IfcRoot subtype
-- and so has no GlobalId; the attached classification is the only place a
-- durable identifier can live.
--
-- IDS material values match any Material/Layer/Profile/Constituent Name *or*
-- Category, and the value may live on the set itself (IfcMaterialLayerSet.
-- LayerSetName), a set member, or the IfcMaterial leaf. So the view descends
-- element → (association, direct or inherited from the element's type) →
-- list/set/usage → member → material and emits one row per reached node with
-- both its name and its category. The descent is unrolled to a fixed depth (a
-- recursive CTE cannot be bound in a view referenced from a correlated EXISTS,
-- see above).
CREATE VIEW IF NOT EXISTS materials AS
WITH assoc AS (
  -- element → material node, direct …
  SELECT t.model_id, t.subject AS entity_id, t.object AS node
  FROM triples t
  WHERE t.predicate = 'IfcRelAssociatesMaterial'
  UNION
  -- … plus the material of the element's type (IfcRelDefinesByType is stored
  -- subject = type, object = occurrence), unless the element carries its own
  -- association, which overrides the type's.
  SELECT dt.model_id, dt.object AS entity_id, t.object AS node
  FROM triples dt
  JOIN triples t
    ON t.model_id = dt.model_id AND t.subject = dt.subject
   AND t.predicate = 'IfcRelAssociatesMaterial'
  WHERE dt.predicate = 'IfcRelDefinesByType'
    AND NOT EXISTS (
      SELECT 1 FROM triples own
      WHERE own.model_id = dt.model_id AND own.subject = dt.object
        AND own.predicate = 'IfcRelAssociatesMaterial'
    )
),
-- IfcMaterial*SetUsage → the set it references (ForLayerSet / ForProfileSet).
assoc_set AS (
  SELECT a.model_id, a.entity_id, COALESCE(u.object, a.node) AS node
  FROM assoc a
  LEFT JOIN triples u
    ON u.model_id = a.model_id AND u.subject = a.node
   AND u.predicate IN ('hasMaterialLayerSet', 'hasMaterialProfileSet')
),
-- set/list → member (IfcMaterialLayer / Constituent / Profile, or IfcMaterial).
members AS (
  SELECT s.model_id, s.entity_id, hm.object AS node
  FROM assoc_set s
  JOIN triples hm
    ON hm.model_id = s.model_id AND hm.subject = s.node
   AND hm.predicate IN ('hasMaterialLayer', 'hasMaterialConstituent',
                        'hasMaterialProfile', 'hasMaterial')
),
-- member → IfcMaterial leaf.
leaves AS (
  SELECT m.model_id, m.entity_id, hm.object AS node
  FROM members m
  JOIN triples hm
    ON hm.model_id = m.model_id AND hm.subject = m.node
   AND hm.predicate = 'hasMaterial'
),
related AS (
  SELECT model_id, entity_id, node FROM assoc_set
  UNION SELECT model_id, entity_id, node FROM members
  UNION SELECT model_id, entity_id, node FROM leaves
)
SELECT DISTINCT
  r.model_id                        AS model_id,
  r.entity_id                       AS entity_id,
  r.node                            AS material_entity_id,
  -- The node's Name, or a layer set's LayerSetName (IfcMaterialLayerSet has no
  -- Name attribute). entity_attributes holds both; entities.name is the
  -- curated Tier-1 column and the fallback when the side table is absent.
  COALESCE(
    NULLIF((SELECT ea.value FROM entity_attributes ea
             WHERE ea.model_id = r.model_id AND ea.entity_id = r.node
               AND lower(ea.attr_name) IN ('name', 'layersetname')
             LIMIT 1), ''),
    e.name
  )                                 AS name,
  -- Category (IfcMaterial / Layer / Profile / Constituent).
  NULLIF((SELECT ea.value FROM entity_attributes ea
           WHERE ea.model_id = r.model_id AND ea.entity_id = r.node
             AND lower(ea.attr_name) = 'category'
           LIMIT 1), '')            AS category
FROM related r
JOIN entities e ON e.model_id = r.model_id AND e.entity_id = r.node;

-- Material → external classification reference (the environmental-dataset link).
--
-- Both schema spellings are unioned because the extractor emits the same
-- "hasMaterialClassification" predicate from the relationship node in each, but
-- the node sits between material and reference differently:
--
--   IFC2x3  relationship --hasMaterialClassification--> reference
--           relationship --references--> material          (generic fallback)
--   IFC4    relationship --hasMaterialClassification--> reference
--           relationship --references--> material          (list arg[3])
--
-- so in both cases the material and the reference are siblings hanging off the
-- same relationship node, and the join is a self-join on that node.
CREATE VIEW IF NOT EXISTS material_classifications AS
SELECT mc.model_id                           AS model_id,
       mat.entity_id                         AS material_entity_id,
       COALESCE(refe.name, '')               AS system,
       COALESCE(refe.identification, '')     AS code
FROM triples mc
JOIN entities refe
  ON refe.model_id = mc.model_id AND refe.entity_id = mc.object
JOIN triples sib
  ON sib.model_id = mc.model_id AND sib.subject = mc.subject
JOIN entities mat
  ON mat.model_id = sib.model_id AND mat.entity_id = sib.object
WHERE mc.predicate = 'hasMaterialClassification'
  AND upper(refe.ifc_type) LIKE '%CLASSIFICATION%'
  AND upper(mat.ifc_type) LIKE '%MATERIAL%'
  AND (refe.name IS NOT NULL OR refe.identification IS NOT NULL);

CREATE VIEW IF NOT EXISTS documents AS
SELECT t.model_id                            AS model_id,
       t.subject                             AS entity_id,
       doc.name                              AS title,
       doc.identification                    AS location
FROM triples t
JOIN entities doc ON doc.model_id = t.model_id AND doc.entity_id = t.object
WHERE t.predicate = 'IfcRelAssociatesDocument'
  AND upper(doc.ifc_type) LIKE '%DOCUMENT%';

-- Federation overlay tables (PC C2.2). These are NOT per-model — they are a
-- whole-tree mirror of the store's reparentOps/sameAsOps arrays, truncated and
-- rewritten wholesale by syncFederationToDb whenever those arrays change. The
-- store arrays remain authoritative for editing/persistence; DuckDB is the
-- queryable + resolvable mirror (ADR-008).
CREATE TABLE IF NOT EXISTS reparent_ops (
  id                VARCHAR,
  node_model_id     VARCHAR,
  node_entity_id    INTEGER,
  parent_model_id   VARCHAR,
  parent_entity_id  INTEGER
);
CREATE TABLE IF NOT EXISTS sameas_members (
  op_id      VARCHAR,
  model_id   VARCHAR,
  entity_id  INTEGER,
  ifc_type   VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_sameas_member ON sameas_members (model_id, entity_id);
`;

// Only the materialized base/projection tables are deleted per-model.
// classifications/materials/documents are views (ADR-016.1) — deleting their
// base rows (entities/triples) empties them automatically.
export const MATERIALIZED_TABLES = ['entities', 'triples', 'pset_properties', 'entity_attributes'] as const;

export const DROP_MODEL_SQL = `
DELETE FROM entities          WHERE model_id = ?;
DELETE FROM triples           WHERE model_id = ?;
DELETE FROM pset_properties   WHERE model_id = ?;
DELETE FROM entity_attributes WHERE model_id = ?;
`;

export async function initSchema(conn: duckdb.AsyncDuckDBConnection): Promise<void> {
  await conn.query(DDL);
}
