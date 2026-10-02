/**
 * IDS specification evaluation over DuckDB (P5, ADR-007 single SQL engine).
 *
 * For one specification, per model:
 *   1. Applicability = AND of every applicability facet predicate → the
 *      in-scope entity set.
 *   2. For each applicable entity, evaluate each requirement facet as a boolean
 *      SQL column, then classify pass/fail per cardinality:
 *        required   → predicate must be TRUE
 *        prohibited → predicate must be FALSE
 *        optional   → ignored for pass/fail (informational)
 *
 * All facet values are bound params (facet-sql.ts). The whole spec runs as one
 * SELECT per model returning (entity_id, ifc_type, name, req0, req1, …) so a
 * single round-trip classifies every applicable entity.
 */

import { getDb, awaitIngest } from '../db/client.js';
import { facetToSql, facetToValueSql } from './facet-sql.js';
import type { IdsSpecification, SpecResult, EntityOutcome, FailureReason, Uid } from './types.js';

const uid = (modelId: string, entityId: number): Uid => `${modelId}:${entityId}`;

/**
 * Validate one specification against the given models. Entities with no
 * applicable match in any model produce an empty (but valid) result.
 */
export async function evaluateSpec(
  spec: IdsSpecification,
  modelIds: string[],
): Promise<SpecResult> {
  const t0 = performance.now();
  const db = await getDb();
  await Promise.all(modelIds.map((m) => awaitIngest(m)));

  const applicable: Uid[] = [];
  const passed: Uid[] = [];
  const failed: Uid[] = [];
  const outcomes: Record<Uid, EntityOutcome> = {};

  // Precompute requirement labels once (model-independent).
  const reqLabels = spec.requirements.map((r) => requirementLabel(r.facet, r.cardinality));

  for (const modelId of modelIds) {
    const conn = await db.connect();
    try {
      const { sql, params } = buildSpecSql(spec, modelId);
      const stmt = await conn.prepare(sql);
      try {
        const res = await stmt.query(...params);
        for (const raw of res.toArray()) {
          const row = raw as Record<string, unknown>;
          const eid = Number(row['entity_id']);
          const u = uid(modelId, eid);
          applicable.push(u);

          const failures: FailureReason[] = [];
          spec.requirements.forEach((req, i) => {
            const ok = Boolean(row[`req${i}`]);
            const satisfied = req.cardinality === 'prohibited' ? !ok : req.cardinality === 'optional' ? true : ok;
            if (!satisfied) {
              // `val${i}` is only present when the facet has a scalar value.
              const hasVal = `val${i}` in row;
              const rawVal = row[`val${i}`];
              failures.push({
                requirement: reqLabels[i] ?? `requirement ${i}`,
                expected: expectationText(req.cardinality),
                found: hasVal ? (rawVal == null ? null : String(rawVal)) : undefined,
              });
            }
          });

          outcomes[u] = {
            uid: u,
            ifcType: String(row['ifc_type'] ?? ''),
            name: row['name'] == null ? null : String(row['name']),
            failures,
          };
          if (failures.length === 0) passed.push(u);
          else failed.push(u);
        }
      } finally {
        await stmt.close();
      }
    } catch (err) {
      console.error(`[ids] spec "${spec.name}" failed for model ${modelId}:`, err);
    } finally {
      await conn.close();
    }
  }

  const card = specCardinalityVerdict(spec.cardinality, applicable.length);

  return {
    specId: spec.id,
    applicable,
    passed,
    failed,
    outcomes,
    cardinalitySatisfied: card.satisfied,
    cardinalityReason: card.reason,
    durationMs: performance.now() - t0,
  };
}

/**
 * Evaluate the specification's own cardinality against the applicable count.
 *   required   → ≥1 applicable entity, else FAIL
 *   prohibited → 0 applicable entities, else FAIL
 *   optional   → always satisfied (zero applicable is a vacuous pass)
 */
function specCardinalityVerdict(
  cardinality: string,
  applicableCount: number,
): { satisfied: boolean; reason?: string } {
  switch (cardinality) {
    case 'prohibited':
      return applicableCount === 0
        ? { satisfied: true }
        : { satisfied: false, reason: `Prohibited, but ${applicableCount} applicable entit${applicableCount === 1 ? 'y' : 'ies'} found.` };
    case 'optional':
      return { satisfied: true };
    default: // required
      return applicableCount > 0
        ? { satisfied: true }
        : { satisfied: false, reason: 'Required, but no applicable entity found in the model.' };
  }
}

/** Run every specification in a document; returns results keyed by specId. */
export async function evaluateDocument(
  specs: IdsSpecification[],
  modelIds: string[],
): Promise<Record<string, SpecResult>> {
  const out: Record<string, SpecResult> = {};
  for (const spec of specs) {
    out[spec.id] = await evaluateSpec(spec, modelIds);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL assembly
// ---------------------------------------------------------------------------

/**
 * Build the single per-model SELECT: applicable entities as rows, one boolean
 * column per requirement. Applicability facets are ANDed into the WHERE clause;
 * requirement predicates become SELECT-list boolean expressions.
 */
function buildSpecSql(spec: IdsSpecification, modelId: string): { sql: string; params: unknown[] } {
  // DuckDB binds `?` left-to-right across the whole SQL *text*. The SELECT list
  // (requirement predicates) is emitted BEFORE the WHERE clause, so requirement
  // params must come first, then the WHERE's model_id, then applicability params.
  // Each requirement contributes its pass/fail boolean column, and — when the
  // facet resolves to a scalar — a `val${i}` column with the entity's actual
  // value. Both are emitted in the SELECT list, so their params come first (in
  // text order: req${i} then its val${i}) before the WHERE clause's params.
  const reqCols: string[] = [];
  const reqParams: unknown[] = [];
  spec.requirements.forEach((req, i) => {
    const p = facetToSql(req.facet);
    // CASE WHEN … THEN true ELSE false so the boolean is materialized per row.
    reqCols.push(`CASE WHEN (${p.sql}) THEN true ELSE false END AS req${i}`);
    reqParams.push(...p.params);

    const v = facetToValueSql(req.facet);
    if (v) {
      reqCols.push(`(${v.sql}) AS val${i}`);
      reqParams.push(...v.params);
    }
  });

  const applParts: string[] = [];
  const applParams: unknown[] = [];
  for (const facet of spec.applicability) {
    const p = facetToSql(facet);
    applParts.push(`(${p.sql})`);
    applParams.push(...p.params);
  }
  const applWhere = applParts.length > 0 ? applParts.join(' AND ') : '1=1';

  const selectList = ['e.entity_id', 'e.ifc_type', 'e.name', ...reqCols].join(', ');

  const sql = `
    SELECT ${selectList}
    FROM entities e
    WHERE e.model_id = ?
      AND (${applWhere})
  `;

  // Text order: SELECT-list params, then model_id, then applicability params.
  return { sql, params: [...reqParams, modelId, ...applParams] };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function requirementLabel(facet: import('./types.js').IdsFacet, cardinality: string): string {
  const prefix = cardinality === 'prohibited' ? 'No ' : '';
  switch (facet.kind) {
    case 'entity':
      return `${prefix}Entity ${rLabel(facet.name)}`;
    case 'attribute':
      return `${prefix}Attribute ${rLabel(facet.name)}`;
    case 'property':
      return `${prefix}Property ${rLabel(facet.propertySet)}.${rLabel(facet.baseName)}`;
    case 'classification':
      return `${prefix}Classification ${facet.system ? rLabel(facet.system) : ''}`.trim();
    case 'material':
      return `${prefix}Material ${facet.value ? rLabel(facet.value) : ''}`.trim();
    case 'partOf':
      return `${prefix}Part of ${facet.relation || 'relation'}`;
  }
}

function rLabel(r: import('./types.js').IdsValueRestriction | undefined): string {
  if (!r) return 'any';
  switch (r.kind) {
    case 'simpleValue': return r.value;
    case 'enumeration': return r.values.join('|');
    case 'pattern':     return `/${r.pattern}/`;
    case 'bounds':      return `[${r.min ?? ''}..${r.max ?? ''}]`;
  }
}

function expectationText(cardinality: string): string {
  switch (cardinality) {
    case 'prohibited': return 'must NOT be present';
    case 'optional':   return 'optional';
    default:           return 'required';
  }
}
