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
 */
function valueEqualsSql(col: string, v: string): SqlPredicate {
  if (v === 'true' || v === 'false') return { sql: `lower(${col}) = ?`, params: [v] };
  const n = numericLiteral(v);
  if (n === null) return { sql: `${col} = ?`, params: [v] };
  const d = Math.abs(n) * TOLERANCE + TOLERANCE;
  return {
    sql: `(${col} = ? OR TRY_CAST(${col} AS DOUBLE) BETWEEN ? AND ?)`,
    params: [v, n - d, n + d],
  };
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
      return valueEqualsSql(col, restr.value);

    case 'enumeration': {
      if (restr.values.length === 0) return ALWAYS_FALSE;
      const each = restr.values.map((v) => valueEqualsSql(col, v));
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

function entitySql(facet: EntityFacet): SqlPredicate {
  const namePred = restrictionToSql('e.ifc_type', facet.name);
  if (!facet.predefinedType) return namePred;
  const pt = restrictionToSql('e.predefined_type', facet.predefinedType);
  return {
    sql: `(${namePred.sql}) AND (${pt.sql})`,
    params: [...namePred.params, ...pt.params],
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
  if (!attrName) return ALWAYS_FALSE; // non-simpleValue name — nothing to look up
  return attributeExistsSql(attrName, facet.value);
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
 * Property facet → the entity satisfies the property either **directly** (an
 * occurrence pset via IfcRelDefinesByProperties) OR through its **type** (a type
 * pset the occurrence inherits via IfcRelDefinesByType). Type psets are ingested
 * against the *type* entity's id, not propagated to occurrences, so an IDS spec
 * that applies to occurrences (e.g. IFCAIRTERMINAL) but requires a type pset
 * (e.g. Pset_AirTerminalTypeCommon) would otherwise fail every occurrence and
 * only pass the type. Matching against the type's psets as well fixes that.
 *
 * propertySet and baseName are matched (case-insensitive); the optional value
 * restriction applies against `value` (text) / `value_si` (numeric bounds).
 */
function propertySql(facet: PropertyFacet): SqlPredicate {
  // Build the shared pset/property/value filter once, parameterised on the
  // pset alias so it can be reused for the direct and type-inherited EXISTS.
  const filter = (alias: string): SqlPredicate => {
    const parts: string[] = [];
    const params: unknown[] = [];

    const ps = restrictionToSql(`${alias}.pset_name`, facet.propertySet);
    parts.push(`(${ps.sql})`);
    params.push(...ps.params);

    const bn = restrictionToSql(`${alias}.property_name`, facet.baseName);
    parts.push(`(${bn.sql})`);
    params.push(...bn.params);

    if (facet.value) {
      const v = restrictionToSql(`${alias}.value`, facet.value, `${alias}.value_si`);
      parts.push(`(${v.sql})`);
      params.push(...v.params);
    }
    return { sql: parts.join(' AND '), params };
  };

  // Direct: pset attached to the occurrence itself.
  const direct = filter('pp');
  const directExists = `EXISTS (
    SELECT 1 FROM pset_properties pp
    WHERE pp.model_id = e.model_id AND pp.entity_id = e.entity_id AND ${direct.sql}
  )`;

  // Inherited: pset attached to the entity's type. The extractor stores
  // IfcRelDefinesByType as (subject = type, object = occurrence), so the type is
  // the subject of a triple whose object is this entity.
  const typed = filter('tp');
  const typeExists = `EXISTS (
    SELECT 1 FROM triples dt
    JOIN pset_properties tp
      ON tp.model_id = dt.model_id AND tp.entity_id = dt.subject
    WHERE dt.model_id = e.model_id
      AND dt.predicate = 'IfcRelDefinesByType'
      AND dt.object = e.entity_id
      AND ${typed.sql}
  )`;

  return {
    sql: `((${directExists}) OR (${typeExists}))`,
    params: [...direct.params, ...typed.params],
  };
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
    const v = restrictionToSql('mat.name', facet.value);
    parts.push(`(${v.sql})`);
    params.push(...v.params);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM materials mat WHERE ${parts.join(' AND ')})`,
    params,
  };
}

/**
 * PartOf facet → EXISTS over triples where the entity is the *part* (subject)
 * and the *whole* (object) is reached via the given relation predicate. When an
 * optional `entity` sub-facet is present, the whole must also match that type.
 *
 * The extractor stores aggregation/containment as forward edges
 * (whole → parts) for some relations and (part → whole) for others; to be
 * robust we accept the entity on either side of the relation and require the
 * *other* endpoint to satisfy the whole-entity constraint.
 */
function partOfSql(facet: PartOfFacet): SqlPredicate {
  // Two directions: the entity is the subject (whole = object) or the object
  // (whole = subject). Each direction is an EXISTS joined to the whole entity
  // only when a whole-type constraint is present. OR the two together so the
  // relation matches regardless of which endpoint the extractor put the entity.
  const one = partOfDirectionSql(facet, 'subject', 'object');
  const two = partOfDirectionSql(facet, 'object', 'subject');
  return {
    sql: `((${one.sql}) OR (${two.sql}))`,
    params: [...one.params, ...two.params],
  };
}

/** One EXISTS for a single edge direction: `e` is on `self`, whole is on `whole`. */
function partOfDirectionSql(
  facet: PartOfFacet,
  self: 'subject' | 'object',
  whole: 'subject' | 'object',
): SqlPredicate {
  const params: unknown[] = [];
  const clauses: string[] = [`t.model_id = e.model_id`, `t.${self} = e.entity_id`];

  if (facet.relation) {
    // IDS parser uppercases `relation` (e.g. 'IFCRELAGGREGATES'), but the
    // extractor stores triple predicates mixed-case ('IfcRelAggregates').
    // Compare case-insensitively so an explicit relation actually matches.
    clauses.push(`lower(t.predicate) = lower(?)`);
    params.push(facet.relation);
  }

  let join = '';
  if (facet.entity) {
    const ep = restrictionToSql('w.ifc_type', facet.entity.name);
    join = `JOIN entities w ON w.model_id = t.model_id AND w.entity_id = t.${whole}`;
    clauses.push(`(${ep.sql})`);
    params.push(...ep.params);
  }

  return {
    sql: `EXISTS (SELECT 1 FROM triples t ${join} WHERE ${clauses.join(' AND ')})`,
    params,
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
 * Mirrors {@link propertySql}'s pset/name matching but selects the value rather
 * than testing existence; the occurrence pset wins over the inherited type pset
 * (COALESCE order). LIMIT 1 guards against duplicate authored properties.
 */
function propertyValueSql(facet: PropertyFacet): SqlPredicate {
  const params: unknown[] = [];

  const psetName = (alias: string): { sql: string; params: unknown[] } =>
    restrictionToSql(`${alias}.pset_name`, facet.propertySet);
  const propName = (alias: string): { sql: string; params: unknown[] } =>
    restrictionToSql(`${alias}.property_name`, facet.baseName);

  const dPs = psetName('pp');
  const dBn = propName('pp');
  const direct = `(
    SELECT pp.value FROM pset_properties pp
    WHERE pp.model_id = e.model_id AND pp.entity_id = e.entity_id
      AND (${dPs.sql}) AND (${dBn.sql})
    LIMIT 1
  )`;
  params.push(...dPs.params, ...dBn.params);

  const tPs = psetName('tp');
  const tBn = propName('tp');
  const typed = `(
    SELECT tp.value FROM triples dt
    JOIN pset_properties tp
      ON tp.model_id = dt.model_id AND tp.entity_id = dt.subject
    WHERE dt.model_id = e.model_id
      AND dt.predicate = 'IfcRelDefinesByType'
      AND dt.object = e.entity_id
      AND (${tPs.sql}) AND (${tBn.sql})
    LIMIT 1
  )`;
  params.push(...tPs.params, ...tBn.params);

  return { sql: `COALESCE(${direct}, ${typed})`, params };
}
