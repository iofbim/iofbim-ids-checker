/**
 * IDS facet → DuckDB SQL boolean predicate (P5).
 *
 * Each facet becomes a boolean SQL expression evaluated per candidate entity
 * `e` (alias `e` on the `entities` table). Reuses the query engine's tables and
 * the shared operator module semantics (ADR-007): all user *values* are bound
 * (`?`); identifiers are fixed allowlisted columns.
 *
 * This module is pure (no DuckDB import) so it is unit-testable in Vitest.
 * {@link evaluateSpec} in evaluate-ids.ts assembles and runs the SQL.
 */

import { xsdToRe2 } from './xsd-regex.js';
import { MEASURE_UNIT_TYPE } from '../parser/units.js';
import type {
  IdsFacet,
  IdsValueRestriction,
  EntityFacet,
  AttributeFacet,
  PropertyFacet,
  ClassificationFacet,
  MaterialFacet,
  PartOfFacet,
} from './types.js';

/** A SQL boolean expression plus its bound params, in placeholder order. */
export interface SqlPredicate {
  sql: string;
  params: unknown[];
}

/** Column map for attribute-name facets → entities columns. */
const ATTR_COL: Record<string, string> = {
  name: 'e.name',
  globalid: 'e.global_id',
  description: 'e.description',
  objecttype: 'e.object_type',
  tag: 'e.tag',
  predefinedtype: 'e.predefined_type',
  longname: 'e.long_name',
  identification: 'e.identification',
};

const ALWAYS_FALSE: SqlPredicate = { sql: '1=0', params: [] };

/** Measure data types whose values IDS compares in SI units (UserManual/units.md). */
const MEASURE_TYPES = new Set(Object.keys(MEASURE_UNIT_TYPE));

/** Whether an IDS `dataType` names an IFC measure (IFCLENGTHMEASURE, …). */
function isMeasureDataType(dataType: string | undefined): boolean {
  return dataType != null && MEASURE_TYPES.has(dataType.toUpperCase());
}

// ---------------------------------------------------------------------------
// Value restriction → SQL comparison on a given column
// ---------------------------------------------------------------------------

/** IDS floating-point equality tolerance (ImplementersDocumentation/tolerance.md) */
const TOLERANCE = 1e-6;

/** A number as IDS writes one: 42, 42., 42.0, -0.5, 1e-3. Null for anything else */
function numericLiteral(v: string): number | null {
  const t = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * One IDS value compared with `col`. Strings match exactly and case-sensitively; a numeric
 * value also matches a stored number within the tolerance, v ± (|v|·ε + ε), so "42" matches
 * 42. and 42.0 (type casting) and 99999.899999 equals 100000; booleans are written true /
 * false in IDS and stored upper case by IFC, so they compare case-insensitively.
 *
 * When `numCol` is given, a numeric value also matches its SI-normalized column, because an
 * IDS value with a measure dataType is expressed in SI while the model may use project units
 * (e.g. IDS 1 m matches an authored IFC length of 1000 mm). Multi-valued properties store one
 * row per value, each carrying its own SI value.
 */
function valueEqualsSql(col: string, v: string, numCol?: string): SqlPredicate {
  if (v === 'true' || v === 'false') return { sql: `lower(${col}) = ?`, params: [v] };
  const n = numericLiteral(v);
  if (n === null) return { sql: `${col} = ?`, params: [v] };
  const d = Math.abs(n) * TOLERANCE + TOLERANCE;
  // The IDS bounds are decimal numbers, but `n ± d` is computed in binary
  // floating point and can land a hair *inside* the exact decimal bound. A
  // conformance value that is written exactly as the bound (e.g. x = 0.0000009000001
  // for v = -0.0000001) must still pass, so widen by a few ULPs (≈ bound·2⁻⁵²)
  // — far below the tolerance, but enough to swallow the rounding.
  const guard = Math.max(Math.abs(n - d), Math.abs(n + d)) * Number.EPSILON * 4;
  const lo = n - d - guard;
  const hi = n + d + guard;
  const params: unknown[] = [v, lo, hi];
  const si = numCol ? ` OR ${numCol} BETWEEN ? AND ?` : '';
  if (numCol) params.push(lo, hi);
  return {
    sql: `(${col} = ? OR TRY_CAST(${col} AS DOUBLE) BETWEEN ? AND ?${si})`,
    params,
  };
}

/**
 * A numeric `col` equals IDS value `v` within the IDS tolerance. Unlike
 * {@link valueEqualsSql} there is no text form: the column already holds a
 * number, and the IDS value is compared numerically.
 */
function numericValueEqualsSql(col: string, v: string): SqlPredicate {
  const n = numericLiteral(v);
  if (n === null) return { sql: `${col} = ?`, params: [v] };
  const d = Math.abs(n) * TOLERANCE + TOLERANCE;
  return { sql: `(${col} BETWEEN ? AND ?)`, params: [n - d, n + d] };
}

/**
 * A measure restriction compared against the SI-normalized numeric column
 * (`value_si`), so a model authored in mm and an IDS value in m agree. Simple
 * values and enumerations are numeric only; bounds/pattern/length reuse the
 * shared builder.
 */
function measureRestrictionToSql(col: string, restr: IdsValueRestriction | undefined): SqlPredicate {
  if (!restr) return { sql: `${col} IS NOT NULL`, params: [] };
  switch (restr.kind) {
    case 'simpleValue':
      return numericValueEqualsSql(col, restr.value);
    case 'enumeration': {
      if (restr.values.length === 0) return ALWAYS_FALSE;
      const each = restr.values.map((v) => numericValueEqualsSql(col, v));
      return { sql: `(${each.map((p) => p.sql).join(' OR ')})`, params: each.flatMap((p) => p.params) };
    }
    default:
      return restrictionToSql(col, restr, col);
  }
}

/**
 * Build a boolean predicate comparing `col` against a restriction.
 *
 * @param col      a safe, allowlisted column identifier (e.g. `e.name`)
 * @param restr    the restriction, or undefined = "present" (col IS NOT NULL)
 * @param numCol   optional SI-normalized numeric column for `bounds` compares
 */
export function restrictionToSql(
  col: string,
  restr: IdsValueRestriction | undefined,
  numCol?: string,
): SqlPredicate {
  if (!restr) return { sql: `${col} IS NOT NULL`, params: [] };

  switch (restr.kind) {
    case 'simpleValue':
      return valueEqualsSql(col, restr.value, numCol);

    case 'enumeration': {
      if (restr.values.length === 0) return ALWAYS_FALSE;
      const each = restr.values.map((v) => valueEqualsSql(col, v, numCol));
      return { sql: `(${each.map((p) => p.sql).join(' OR ')})`, params: each.flatMap((p) => p.params) };
    }

    case 'pattern':
      // XSD patterns are implicitly anchored: the whole value must match, not a substring
      // ("ST-KRS-[^-]+" must reject "ST-KRS-BETON-C30"), so full match, not regexp_matches.
      // Case-sensitive, like every IDS string comparison.
      // RE2 has no XSD class subtraction ("[\p{L}-[_]]"): such classes are spelled out
      return { sql: `regexp_full_match(${col}, ?)`, params: [xsdToRe2(restr.pattern)] };

    case 'length': {
      const parts: string[] = [];
      const params: unknown[] = [];
      if (restr.length != null) { parts.push(`length(${col}) = ?`); params.push(restr.length); }
      if (restr.minLength != null) { parts.push(`length(${col}) >= ?`); params.push(restr.minLength); }
      if (restr.maxLength != null) { parts.push(`length(${col}) <= ?`); params.push(restr.maxLength); }
      return { sql: `(${col} IS NOT NULL AND ${parts.join(' AND ')})`, params };
    }

    case 'bounds': {
      const target = numCol ?? `TRY_CAST(${col} AS DOUBLE)`;
      const parts: string[] = [];
      const params: unknown[] = [];
      if (restr.min != null) {
        parts.push(`${target} ${restr.minInclusive ? '>=' : '>'} ?`);
        params.push(restr.min);
      }
      if (restr.max != null) {
        parts.push(`${target} ${restr.maxInclusive ? '<=' : '<'} ?`);
        params.push(restr.max);
      }
      if (parts.length === 0) return { sql: `${target} IS NOT NULL`, params: [] };
      return { sql: parts.join(' AND '), params };
    }
  }
}

// ---------------------------------------------------------------------------
// Facet → SQL predicate (evaluated against entity alias `e`)
// ---------------------------------------------------------------------------

export function facetToSql(facet: IdsFacet): SqlPredicate {
  switch (facet.kind) {
    case 'entity':        return entitySql(facet);
    case 'attribute':     return attributeSql(facet);
    case 'property':      return propertySql(facet);
    case 'classification':return classificationSql(facet);
    case 'material':      return materialSql(facet);
    case 'partOf':        return partOfSql(facet);
  }
}

/**
 * Whether the facet's subject is there at all, whatever its value: the named attribute has a
 * value (an empty string counts), the property exists in its set, a classification exists (in
 * the named system), the entity has any material. An **optional** requirement passes when its
 * subject is absent, and otherwise must hold like a required one (IDS specifications.md:
 * "either don't have the property, or if they do, it is of the expected datatype and value").
 * Entity and partOf have no optional state in IDS; their anchor is the facet itself, so an
 * optional one written anyway always passes.
 */
export function facetAnchorSql(facet: IdsFacet): SqlPredicate {
  switch (facet.kind) {
    case 'attribute': {
      const attrName = facet.name.kind === 'simpleValue' ? facet.name.value : '';
      const col = ATTR_COL[attrName.toLowerCase()];
      // NULL is either $ or '': empty_attrs tells which (an authored '' is present)
      if (col) return { sql: `(${col} IS NOT NULL OR contains(coalesce(e.empty_attrs, ''), ?))`, params: [`,${attrName.toLowerCase()},`] };
      // A Name restriction (pattern / enumeration / …) matches any attribute
      // whose name satisfies it; the subject is present when one of them has a
      // value (attribute-facet.md "Name restrictions will match any result").
      if (facet.name.kind !== 'simpleValue') return attributeNameRestrictionSql(facet.name, undefined);
      if (!attrName) return ALWAYS_FALSE;
      return {
        sql: 'EXISTS (SELECT 1 FROM entity_attributes ea WHERE ea.model_id = e.model_id AND ea.entity_id = e.entity_id AND lower(ea.attr_name) = lower(?) AND ea.value IS NOT NULL)',
        params: [attrName],
      };
    }
    case 'property':       return propertySql({ ...facet, value: undefined, dataType: undefined });
    // Any classification at all, own or from the type, whatever its system or fields (test
    // case fail-an_optional_classification_value_fails_if_no_match: a classification named '')
    case 'classification': return {
      sql: 'EXISTS (SELECT 1 FROM classifications cl WHERE cl.model_id = e.model_id AND cl.entity_id = e.entity_id)',
      params: [],
    };
    case 'material':       return materialSql({ ...facet, value: undefined });
    case 'entity':
    case 'partOf':         return facetToSql(facet);
  }
}

/**
 * SQL scalar: the entity that supplies the IDS predefined type for `alias`.
 *
 * Per UserManual/entity-facet.md a typed occurrence takes the value from its
 * IfcTypeObject when that type defines one; a type "defines" a predefined type
 * when its PredefinedType is set and not NOTDEFINED (USERDEFINED counts — the
 * value is then its ElementType/ProcessType/ResourceType). When the type leaves
 * it undefined (or there is no type) the value comes from the occurrence, which
 * is how an occurrence "overrides" the type. The extractor stores
 * IfcRelDefinesByType as (subject = type, object = occurrence).
 */
function predefinedTypeSourceIdSql(alias: string): string {
  return `COALESCE(
    (SELECT dt.subject FROM triples dt
     JOIN entities ty ON ty.model_id = dt.model_id AND ty.entity_id = dt.subject
     WHERE dt.model_id = ${alias}.model_id
       AND dt.predicate = 'IfcRelDefinesByType'
       AND dt.object = ${alias}.entity_id
       AND ty.predefined_type IS NOT NULL
       AND upper(ty.predefined_type) <> 'NOTDEFINED'
     LIMIT 1),
    ${alias}.entity_id)`;
}

/** SQL scalar: the resolved PredefinedType enum value for `alias`. */
function resolvedPredefinedTypeSql(alias: string): string {
  return `(SELECT s.predefined_type FROM entities s
    WHERE s.model_id = ${alias}.model_id
      AND s.entity_id = ${predefinedTypeSourceIdSql(alias)})`;
}

/**
 * SQL scalar: the resolved user-defined type string for `alias` — the
 * `ObjectType` of an occurrence, or the `ElementType` / `ProcessType` /
 * `ResourceType` of a type object (all live in the `entity_attributes` side
 * table, not in the `object_type` column).
 */
function resolvedUserDefinedTypeSql(alias: string): string {
  return `(SELECT ea.value FROM entity_attributes ea
    WHERE ea.model_id = ${alias}.model_id
      AND ea.entity_id = ${predefinedTypeSourceIdSql(alias)}
      AND lower(ea.attr_name) IN ('objecttype', 'elementtype', 'processtype', 'resourcetype')
      AND ea.value IS NOT NULL AND ea.value <> ''
    LIMIT 1)`;
}

/**
 * Entity facet: the entity class AND, when a predefinedType restriction is
 * present, its resolved predefined type. When the resolved enum is USERDEFINED
 * both the literal `USERDEFINED` and the user-supplied type string are
 * acceptable (UserManual/entity-facet.md "Examples of interpering IFC
 * Predefined Types").
 */
function entitySql(facet: EntityFacet): SqlPredicate {
  const namePred = restrictionToSql('e.ifc_type', facet.name);
  if (!facet.predefinedType) return namePred;

  const enumVal = resolvedPredefinedTypeSql('e');
  const userVal = resolvedUserDefinedTypeSql('e');
  const onEnum = restrictionToSql(enumVal, facet.predefinedType);
  const onUser = restrictionToSql(userVal, facet.predefinedType);
  return {
    sql:
      `(${namePred.sql}) AND (` +
      `(${onEnum.sql})` +
      ` OR (upper(${enumVal}) = 'USERDEFINED' AND ${userVal} IS NOT NULL AND (${onUser.sql}))` +
      `)`,
    params: [...namePred.params, ...onEnum.params, ...onUser.params],
  };
}

/**
 * Attribute facet: the entity has the named attribute (optionally satisfying a
 * value). A Tier-1 attribute (Name, Tag, PredefinedType, …) is a materialized
 * column; any other schema attribute (IfcPerson.FamilyName,
 * IfcOrganization.Roles, …) lives in the `entity_attributes` side table and is
 * matched via EXISTS. Matching only against Tier-1 columns produced false
 * negatives — every non-Tier-1 attribute facet was always-false.
 *
 * `NOTDEFINED` / `USERDEFINED` are valid IFC enum values and are stored as such
 * (not dropped), so a presence check on PredefinedType/ObjectType passes for an
 * entity whose authored value is NOTDEFINED — as IFC intends.
 */
function attributeSql(facet: AttributeFacet): SqlPredicate {
  const attrName = facet.name.kind === 'simpleValue' ? facet.name.value : '';
  const col = ATTR_COL[attrName.toLowerCase()];
  if (col) {
    // Presence: column IS NOT NULL and non-empty. Plus optional value constraint.
    const present = `(${col} IS NOT NULL AND ${col} != '')`;
    if (!facet.value) return { sql: present, params: [] };
    const val = restrictionToSql(col, facet.value);
    return { sql: `(${present}) AND (${val.sql})`, params: val.params };
  }
  if (facet.name.kind === 'simpleValue') {
    if (!attrName) return ALWAYS_FALSE; // empty name — nothing to look up
    return attributeExistsSql(attrName, facet.value);
  }
  // Name restriction (pattern / enumeration / …): match ANY attribute whose
  // name satisfies it, and pass when any of those satisfies the requirement
  // (UserManual/attribute-facet.md "Name restrictions will match any result").
  return attributeNameRestrictionSql(facet.name, facet.value);
}

/**
 * EXISTS over `entity_attributes` for an attribute facet whose **Name** is a
 * restriction rather than a simple value. The IDS rule is existential: the
 * name restriction matches every schema attribute whose name it accepts
 * (e.g. `.*Name.*` matches `LayerSetName`, and the enumeration
 * `Name|Description` matches both), and the facet passes when at least one of
 * them has a (non-empty) value satisfying the optional value restriction.
 * Attribute names are compared case-sensitively, like every other IDS string.
 */
function attributeNameRestrictionSql(
  name: IdsValueRestriction,
  value: IdsValueRestriction | undefined,
): SqlPredicate {
  const params: unknown[] = [];
  const clauses = [
    'ea.model_id = e.model_id',
    'ea.entity_id = e.entity_id',
    "(ea.value IS NOT NULL AND ea.value != '')",
  ];
  const n = restrictionToSql('ea.attr_name', name);
  clauses.push(`(${n.sql})`);
  params.push(...n.params);
  if (value) {
    const v = restrictionToSql('ea.value', value);
    clauses.push(`(${v.sql})`);
    params.push(...v.params);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM entity_attributes ea WHERE ${clauses.join(' AND ')})`,
    params,
  };
}

/**
 * EXISTS over `entity_attributes` for a non-Tier-1 attribute. Presence = a row
 * with a non-empty value; the optional value restriction applies to that value.
 * The attr_name is a bound param (case-insensitive) like every other value.
 */
function attributeExistsSql(attrName: string, value: IdsValueRestriction | undefined): SqlPredicate {
  const params: unknown[] = [attrName];
  const clauses = [
    'ea.model_id = e.model_id',
    'ea.entity_id = e.entity_id',
    'lower(ea.attr_name) = lower(?)',
    "(ea.value IS NOT NULL AND ea.value != '')",
  ];
  if (value) {
    const v = restrictionToSql('ea.value', value);
    clauses.push(`(${v.sql})`);
    params.push(...v.params);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM entity_attributes ea WHERE ${clauses.join(' AND ')})`,
    params,
  };
}

/**
 * Property facet → the entity's effective property sets (occurrence sets plus the
 * sets inherited from its type, with occurrence sets overriding same-named type
 * sets — see the `effective_properties` view) must **all** satisfy the
 * requirement.
 *
 * IDS treats propertySet and baseName as restrictions, so one facet can match
 * several sets and several properties. Per property-facet.md and the
 * "..._all_matching_..." test cases, every matching set must contain a matching
 * property, and every matching property must satisfy the requirement. A property
 * with no value (an authored empty string or a LOGICAL unknown is stored NULL)
 * does not satisfy a name-only requirement.
 *
 * A multi-valued property (list, bounded, table, enumerated) is stored as one row
 * per value, and satisfies the requirement when ANY of its values does: the
 * value check is per property (pset + name), not per row. An IDS dataType must
 * equal the stored IFC value type, and a measure value compares in SI.
 */
function propertySql(facet: PropertyFacet): SqlPredicate {
  const ps = restrictionToSql('v.pset_name', facet.propertySet);
  const bn = restrictionToSql('v.property_name', facet.baseName);
  const bnInPset = restrictionToSql('w.property_name', facet.baseName);
  const ok = propertyValueOkSql('w', facet);

  const base = 'v.model_id = e.model_id AND v.entity_id = e.entity_id';
  const matchingPset = `(${base}) AND (${ps.sql})`;

  // At least one property set matches the facet's pset restriction.
  const somePset = `EXISTS (
    SELECT 1 FROM effective_properties v
    WHERE ${matchingPset}
  )`;

  // No matching property set lacks a property matching the baseName.
  const missingProperty = `EXISTS (
    SELECT 1 FROM effective_properties v
    WHERE ${matchingPset}
      AND NOT EXISTS (
        SELECT 1 FROM effective_properties w
        WHERE w.model_id = v.model_id AND w.entity_id = v.entity_id
          AND w.pset_name = v.pset_name AND (${bnInPset.sql})
      )
  )`;

  // No matching property has none of its values satisfying the requirement
  // (one row per value of a multi-valued property: any one may satisfy it).
  const badProperty = `EXISTS (
    SELECT 1 FROM effective_properties v
    WHERE ${matchingPset} AND (${bn.sql})
      AND NOT EXISTS (
        SELECT 1 FROM effective_properties w
        WHERE w.model_id = v.model_id AND w.entity_id = v.entity_id
          AND w.pset_name = v.pset_name AND w.property_name = v.property_name
          AND ${ok.sql}
      )
  )`;

  return {
    sql: `((${somePset}) AND NOT (${missingProperty}) AND NOT (${badProperty}))`,
    params: [...ps.params, ...ps.params, ...bnInPset.params, ...ps.params, ...bn.params, ...ok.params],
  };
}

/**
 * Value predicate for a matching property: the facet's value restriction, or —
 * when the facet only requires the property to exist — that it actually carries
 * a value. An empty string and a LOGICAL unknown both arrive as NULL, so both
 * count as no value (test cases `an_empty_string...` and `a_logical_unknown...`).
 */
function propertyValueOkSql(alias: string, facet: PropertyFacet): SqlPredicate {
  const parts: string[] = [];
  const params: unknown[] = [];
  // An IDS dataType must equal the stored IFC value type; complex and reference
  // properties are never ingested, so this also rejects them. A row without a
  // known type (the attributes of a predefined property set: the checker has no
  // schema types for them) cannot be checked, so it is not rejected for it.
  if (facet.dataType) {
    parts.push(`(${alias}.data_type IS NULL OR upper(${alias}.data_type) = upper(?))`);
    params.push(facet.dataType);
  }
  if (facet.value) {
    // A measure's IDS value is in SI, so compare it against the SI-normalized
    // column rather than the authored text (mm vs m).
    const v = isMeasureDataType(facet.dataType)
      ? measureRestrictionToSql(`${alias}.value_si`, facet.value)
      : restrictionToSql(`${alias}.value`, facet.value, `${alias}.value_si`);
    parts.push(`(${v.sql})`);
    params.push(...v.params);
  } else {
    parts.push(`(${alias}.value IS NOT NULL AND ${alias}.value <> '')`);
  }
  // A comparison against a non-numeric or NULL value yields NULL, which an
  // EXISTS would silently swallow; a property without a matching value must
  // count as *not* satisfying the requirement, so force a two-valued result.
  return { sql: `COALESCE((${parts.join(' AND ')}), false)`, params };
}

function classificationSql(facet: ClassificationFacet): SqlPredicate {
  const parts: string[] = ['cl.model_id = e.model_id', 'cl.entity_id = e.entity_id'];
  const params: unknown[] = [];
  if (facet.system) {
    const s = restrictionToSql('cl.system', facet.system);
    parts.push(`(${s.sql})`);
    params.push(...s.params);
  }
  if (facet.value) {
    const c = restrictionToSql('cl.code', facet.value);
    parts.push(`(${c.sql})`);
    params.push(...c.params);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM classifications cl WHERE ${parts.join(' AND ')})`,
    params,
  };
}

function materialSql(facet: MaterialFacet): SqlPredicate {
  const parts: string[] = ['mat.model_id = e.model_id', 'mat.entity_id = e.entity_id'];
  const params: unknown[] = [];
  if (facet.value) {
    // An IDS material value matches any Material/Layer/Profile/Constituent
    // Name *or* Category (material-facet.md), so test the view's name and
    // category columns.
    const byName = restrictionToSql('mat.name', facet.value);
    const byCategory = restrictionToSql('mat.category', facet.value);
    parts.push(`((${byName.sql}) OR (${byCategory.sql}))`);
    params.push(...byName.params, ...byCategory.params);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM materials mat WHERE ${parts.join(' AND ')})`,
    params,
  };
}

/**
 * PartOf facet → EXISTS over triples where the entity is the *part* (object)
 * and the *whole* (subject) is reached by walking whole → part edges upward.
 * IDS evaluates the facet recursively (UserManual/partof-facet.md), so a whole
 * directly or indirectly above the entity matches; every hop of a path must use
 * the requested relation (or, when none is given, one of the six supported
 * relations) — an unrelated hop in the middle (e.g. containment inside an
 * aggregate walk) does not count.
 *
 * The extractor stores every supported relationship as whole --predicate--> part
 * (subject = whole, object = part): IfcRelAggregates / IfcRelNests /
 * IfcRelAssignsToGroup (RelatingObject|Group → RelatedObjects),
 * IfcRelContainedInSpatialStructure (RelatingStructure → RelatedElements),
 * IfcRelVoidsElement (host → opening), IfcRelFillsElement (opening → filling).
 * The facet subject is therefore always the *object*; probing the subject side
 * would let the whole/container satisfy its own PartOf requirement.
 *
 * Recursion is unrolled to PART_OF_DEPTH self-joins (one EXISTS per depth, ORed)
 * rather than a recursive CTE: DuckDB cannot bind a recursive CTE inside a
 * correlated EXISTS (same constraint as the classification chain in schema.ts).
 */
function partOfSql(facet: PartOfFacet): SqlPredicate {
  const params: unknown[] = [];
  const hops: string[] = [];
  for (let depth = 1; depth <= PART_OF_DEPTH; depth++) {
    const hop = partOfHopSql(facet, depth);
    hops.push(`(${hop.sql})`);
    params.push(...hop.params);
  }
  return { sql: `(${hops.join(' OR ')})`, params };
}

/** The six relationships IDS PartOf traverses when no `relation` is authored. */
const PART_OF_RELATIONS = [
  'IfcRelAggregates',
  'IfcRelAssignsToGroup',
  'IfcRelContainedInSpatialStructure',
  'IfcRelNests',
  'IfcRelVoidsElement',
  'IfcRelFillsElement',
] as const;

/** Whole → part hops walked upward; mirrors CLASSIFICATION_DEPTH in schema.ts. */
const PART_OF_DEPTH = 8;

/** One EXISTS walking `depth` whole→part edges above `e` (the part). */
function partOfHopSql(facet: PartOfFacet, depth: number): SqlPredicate {
  const params: unknown[] = [];
  const where: string[] = ['t0.model_id = e.model_id', 't0.object = e.entity_id'];
  const joins: string[] = [];
  for (let i = 0; i < depth; i++) {
    const t = `t${i}`;
    if (i > 0) {
      const prev = `t${i - 1}`;
      joins.push(`JOIN triples ${t} ON ${t}.model_id = ${prev}.model_id AND ${t}.object = ${prev}.subject`);
    }
    if (facet.relation) {
      // IDS parser uppercases `relation` (e.g. 'IFCRELAGGREGATES'), but the
      // extractor stores triple predicates mixed-case ('IfcRelAggregates').
      // Compare case-insensitively so an explicit relation actually matches.
      where.push(`lower(${t}.predicate) = lower(?)`);
      params.push(facet.relation);
    } else {
      // No relation: only the six supported relationships, never the generic
      // `references` / IfcRelDefines* fallbacks the extractor also emits.
      where.push(`${t}.predicate IN (${PART_OF_RELATIONS.map(() => '?').join(', ')})`);
      params.push(...PART_OF_RELATIONS);
    }
  }

  let join = '';
  if (facet.entity) {
    const last = `t${depth - 1}`;
    join = ` JOIN entities w ON w.model_id = ${last}.model_id AND w.entity_id = ${last}.subject`;
    const ep = restrictionToSql('w.ifc_type', facet.entity.name);
    where.push(`(${ep.sql})`);
    params.push(...ep.params);
    if (facet.entity.predefinedType) {
      const pt = partOfPredefinedTypeSql('w', facet.entity.predefinedType);
      where.push(`(${pt.sql})`);
      params.push(...pt.params);
    }
  }

  return {
    sql: `EXISTS (SELECT 1 FROM triples t0 ${joins.join(' ')}${join} WHERE ${where.join(' AND ')})`,
    params,
  };
}

/**
 * The whole's predefined type, resolved the IDS way: the IFC enum is matched
 * directly, and when that enum is USERDEFINED the authored value lives in the
 * entity's ObjectType instead (UserManual/entity-facet.md). Without the
 * fallback the nested `predefinedType` would reject the USERDEFINED pass cases;
 * ignoring the field entirely would let the failing cases through.
 */
function partOfPredefinedTypeSql(alias: string, restr: IdsValueRestriction): SqlPredicate {
  const direct = restrictionToSql(`${alias}.predefined_type`, restr);
  const custom = restrictionToSql(`${alias}.object_type`, restr);
  return {
    sql: `((${direct.sql}) OR (upper(${alias}.predefined_type) = 'USERDEFINED' AND (${custom.sql})))`,
    params: [...direct.params, ...custom.params],
  };
}

// ---------------------------------------------------------------------------
// Facet → SQL scalar returning the entity's *actual* value for this facet
// ---------------------------------------------------------------------------

/**
 * A SQL scalar expression (plus bound params) resolving the entity's current
 * value for the facet, so a failure report can say "expected X, **found Y**".
 *
 * Only Attribute and Property facets have a single meaningful scalar value:
 *  - attribute → the Tier-1 column itself
 *  - property  → a correlated subquery pulling the matched property's value
 *                (occurrence pset first, then type-inherited pset)
 *
 * Entity / Classification / Material / PartOf are set-membership assertions with
 * no single scalar; they return `null` here and the report shows only what was
 * expected (the requirement label already carries the classification system,
 * material name, or relation). Returns `null` when there is nothing scalar to
 * surface, so the caller can omit the column entirely.
 */
export function facetToValueSql(facet: IdsFacet): SqlPredicate | null {
  switch (facet.kind) {
    case 'attribute': {
      const attrName = facet.name.kind === 'simpleValue' ? facet.name.value : '';
      const col = ATTR_COL[attrName.toLowerCase()];
      if (col) return { sql: col, params: [] };
      if (!attrName) return null;
      // Non-Tier-1: pull the value from the entity_attributes side table.
      // A SET/LIST attribute is stored as one row per member (see
      // insertEntityAttributes), so join the members back together rather than
      // reporting an arbitrary single one via LIMIT 1.
      return {
        sql: `(
          SELECT string_agg(ea.value, ', ') FROM entity_attributes ea
          WHERE ea.model_id = e.model_id AND ea.entity_id = e.entity_id
            AND lower(ea.attr_name) = lower(?)
        )`,
        params: [attrName],
      };
    }
    case 'property':
      return propertyValueSql(facet);
    default:
      return null;
  }
}

/**
 * Correlated scalar subquery returning the matched property's value string.
 * Mirrors {@link propertySql}'s pset/name matching but selects a value rather
 * than testing existence. Reads the same `effective_properties` source, so an
 * occurrence set already overrides the type's; LIMIT 1 guards against duplicate
 * authored properties.
 */
function propertyValueSql(facet: PropertyFacet): SqlPredicate {
  const ps = restrictionToSql('v.pset_name', facet.propertySet);
  const bn = restrictionToSql('v.property_name', facet.baseName);
  return {
    sql: `(
      SELECT v.value FROM effective_properties v
      WHERE v.model_id = e.model_id AND v.entity_id = e.entity_id
        AND (${ps.sql}) AND (${bn.sql})
      LIMIT 1
    )`,
    params: [...ps.params, ...bn.params],
  };
}
