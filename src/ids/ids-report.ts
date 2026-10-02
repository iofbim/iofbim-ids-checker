/**
 * IDS failure report generation (P5).
 *
 * Turns the ephemeral validation results into a **detailed, per-item report**:
 * every specification → every applicable entity that failed → every failed
 * requirement (label, what was expected, and the actual value found). Two
 * renderings share the same flattened row model:
 *   - CSV  — one row per (spec, entity, failed requirement); spreadsheet-ready.
 *   - HTML — a standalone printable document grouped spec → entity → failures.
 *
 * Pure string builders (no DOM/store) so they are unit-testable; the panel
 * wires the download.
 */

import type { IdsDocument, SpecResult, EntityOutcome } from './types.js';

/** One flattened failure line — the unit of the CSV report. */
export interface ReportRow {
  specName: string;
  modelId: string;
  entityId: string;
  ifcType: string;
  entityName: string;
  requirement: string;
  expected: string;
  found: string;
}

/**
 * Optional display names for model ids (e.g. model id → file name). Ids without a name are shown
 * as they are.
 */
export type ModelNames = Readonly<Record<string, string>>;

function splitUid(uid: string): { modelId: string; entityId: string } {
  const sep = uid.lastIndexOf(':');
  if (sep < 0) return { modelId: '', entityId: uid };
  return { modelId: uid.slice(0, sep), entityId: uid.slice(sep + 1) };
}

/** Human string for a `found` value: null → "(missing)", undefined → "". */
function foundText(found: string | null | undefined): string {
  if (found === undefined) return '';
  if (found === null || found === '') return '(missing)';
  return found;
}

/**
 * Flatten every failed requirement across all specs into report rows. Only
 * entities that failed at least one requirement contribute rows.
 */
export function buildReportRows(
  doc: IdsDocument,
  results: Record<string, SpecResult>,
  modelNames: ModelNames = {},
): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const spec of doc.specifications) {
    const res = results[spec.id];
    if (!res) continue;

    // Spec-level cardinality failure (e.g. required but zero applicable) is a
    // failure of the whole specification with no single entity — emit one row so
    // it isn't silently absent from the report.
    if (!res.cardinalitySatisfied) {
      rows.push({
        specName: spec.name,
        modelId: '',
        entityId: '',
        ifcType: '',
        entityName: '',
        requirement: 'Specification cardinality',
        expected: spec.cardinality,
        found: res.cardinalityReason ?? 'not satisfied',
      });
    }

    for (const uid of res.failed) {
      const o: EntityOutcome | undefined = res.outcomes[uid];
      if (!o) continue;
      const { modelId: id, entityId } = splitUid(uid);
      const modelId = modelNames[id] ?? id;
      for (const f of o.failures) {
        rows.push({
          specName: spec.name,
          modelId,
          entityId,
          ifcType: o.ifcType,
          entityName: o.name ?? '',
          requirement: f.requirement,
          expected: f.expected,
          found: foundText(f.found),
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const CSV_HEADERS = [
  'Specification',
  'Model',
  'Entity ID',
  'IFC Type',
  'Entity Name',
  'Failed Requirement',
  'Expected',
  'Found',
] as const;

export function reportToCsv(doc: IdsDocument, results: Record<string, SpecResult>, modelNames: ModelNames = {}): string {
  const rows = buildReportRows(doc, results, modelNames);
  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [r.specName, r.modelId, r.entityId, r.ifcType, r.entityName, r.requirement, r.expected, r.found]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/** Standalone, printable HTML report grouped spec → failed entity → failures. */
export function reportToHtml(doc: IdsDocument, results: Record<string, SpecResult>, modelNames: ModelNames = {}): string {
  const generated = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const specBlocks = doc.specifications
    .map((spec) => {
      const res = results[spec.id];
      const applicable = res?.applicable.length ?? 0;
      const passed = res?.passed.length ?? 0;
      const failed = res?.failed.length ?? 0;

      // Spec-level cardinality failure (e.g. required but zero applicable) —
      // report it as a failure of the whole spec, not "not applicable".
      const cardFailed = res && !res.cardinalitySatisfied;

      if (!res || (applicable === 0 && !cardFailed)) {
        return `<section class="spec"><h2>${esc(spec.name)}</h2>
          <p class="na">Not applicable to the loaded models.</p></section>`;
      }

      if (applicable === 0 && cardFailed) {
        return `<section class="spec">
          <h2>${esc(spec.name)}</h2>
          ${spec.description ? `<p class="desc">${esc(spec.description)}</p>` : ''}
          <p class="summary"><span class="bad">Specification failed</span></p>
          <div class="item">
            <div class="item-head"><span class="item-name">Specification cardinality not satisfied</span></div>
            <table class="fails">
              <thead><tr><th>Failed requirement</th><th>Expected</th><th>Found</th></tr></thead>
              <tbody><tr>
                <td>Specification cardinality</td>
                <td>${esc(spec.cardinality)}</td>
                <td class="found">${esc(res.cardinalityReason ?? 'not satisfied')}</td>
              </tr></tbody>
            </table>
          </div>
        </section>`;
      }

      const items = res.failed
        .map((uid) => {
          const o = res.outcomes[uid];
          if (!o) return '';
          const { modelId: id, entityId } = splitUid(uid);
          const modelId = modelNames[id] ?? id;
          const failRows = o.failures
            .map(
              (f) => `<tr>
                <td>${esc(f.requirement)}</td>
                <td>${esc(f.expected)}</td>
                <td class="found">${esc(foundText(f.found))}</td>
              </tr>`,
            )
            .join('');
          const label = o.name || o.ifcType || entityId;
          return `<div class="item">
            <div class="item-head">
              <span class="item-name">${esc(label)}</span>
              <span class="item-meta">${esc(o.ifcType)} · #${esc(entityId)}${
                modelId ? ` · ${esc(modelId)}` : ''
              }</span>
            </div>
            <table class="fails">
              <thead><tr><th>Failed requirement</th><th>Expected</th><th>Found</th></tr></thead>
              <tbody>${failRows}</tbody>
            </table>
          </div>`;
        })
        .join('');

      return `<section class="spec">
        <h2>${esc(spec.name)}</h2>
        ${spec.description ? `<p class="desc">${esc(spec.description)}</p>` : ''}
        <p class="summary">
          <span class="ok">${passed} passed</span> ·
          <span class="bad">${failed} failed</span> ·
          <span class="tot">${applicable} applicable</span>
        </p>
        ${cardFailed ? `<p class="bad">⚠ ${esc(res.cardinalityReason ?? 'Specification cardinality not satisfied')}</p>` : ''}
        ${failed === 0 ? '<p class="allpass">All applicable entities passed.</p>' : items}
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>IDS Report — ${esc(doc.title)}</title>
<style>
  body { font: 13px/1.5 system-ui, sans-serif; color: #1c1a18; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .meta { color: #666; font-size: 12px; margin: 0 0 20px; }
  .spec { border-top: 1px solid #ddd; padding-top: 14px; margin-top: 14px; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .desc { color: #555; margin: 0 0 6px; }
  .summary { margin: 0 0 10px; font-size: 12px; }
  .ok { color: #16a34a; } .bad { color: #dc2626; } .tot { color: #888; }
  .na, .allpass { color: #888; font-style: italic; }
  .item { margin: 0 0 12px; padding-left: 10px; border-left: 3px solid #dc2626; }
  .item-head { display: flex; gap: 8px; align-items: baseline; }
  .item-name { font-weight: 600; }
  .item-meta { color: #888; font-size: 11px; }
  table.fails { border-collapse: collapse; margin: 4px 0 0; width: 100%; max-width: 720px; }
  table.fails th, table.fails td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #eee; font-size: 12px; }
  table.fails th { color: #666; font-weight: 500; }
  td.found { color: #b45309; }
  @media print { .item { break-inside: avoid; } }
</style></head>
<body>
  <h1>IDS Validation Report</h1>
  <p class="meta">${esc(doc.title)} · generated ${esc(generated)}</p>
  ${specBlocks}
</body></html>`;
}
