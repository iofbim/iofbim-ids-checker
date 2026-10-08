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

import type { IdsDocument, SpecResult, EntityOutcome, Uid } from './types.js';
import { isNotApplicable, specProgress } from './progress.js';

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

type ElementGroup = 'fail' | 'partial' | 'pass';

/** Render order of the element groups — worst first. */
const GROUP_ORDER: readonly ElementGroup[] = ['fail', 'partial', 'pass'];
const GROUP_LABEL: Record<ElementGroup, string> = { fail: 'Fail', partial: 'Partial', pass: 'Pass' };

/** Options for {@link reportToHtml}. */
export interface ReportHtmlOptions {
  /** Omit specifications that are not applicable (no applicable element, cardinality met). */
  hideNotApplicable?: boolean;
}

/** Strict IDS verdict of a whole specification: N/A, or Pass/Fail. */
function specVerdict(res: SpecResult | undefined): 'Pass' | 'Fail' | 'N/A' {
  if (!res || isNotApplicable(res)) return 'N/A';
  return res.cardinalitySatisfied && res.failed.length === 0 ? 'Pass' : 'Fail';
}

/** One requirement-check table row; failed rows are highlighted. */
function checkRow(passed: boolean, requirement: string, expected: string, found: string): string {
  return `<tr${passed ? '' : ' class="failed"'}>
    <td class="mark ${passed ? 'ok' : 'bad'}">${passed ? '✓' : '✗'}</td>
    <td>${esc(requirement)}</td>
    <td>${esc(expected)}</td>
    <td class="found">${esc(found)}</td>
  </tr>`;
}

/** One element: head plus a row per requirement check (every check, not just failures). */
function elementBlock(uid: Uid, o: EntityOutcome, status: ElementGroup, modelNames: ModelNames): string {
  const { modelId: id, entityId } = splitUid(uid);
  const modelId = modelNames[id] ?? id;
  const label = o.name || o.ifcType || entityId;
  const rows =
    o.checks.length > 0
      ? o.checks.map((c) => checkRow(c.passed, c.requirement, c.expected, foundText(c.found))).join('')
      : o.failures.map((f) => checkRow(false, f.requirement, f.expected, foundText(f.found))).join('');
  return `<div class="item item-${status}">
    <div class="item-head">
      <span class="item-name">${esc(label)}</span>
      <span class="item-meta">${esc(o.ifcType)} · #${esc(entityId)}${modelId ? ` · ${esc(modelId)}` : ''}</span>
    </div>
    <table class="fails">
      <thead><tr><th class="mark">✓/✗</th><th>Requirement</th><th>Expected</th><th>Found</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/** A collapsible `<details>` group of elements; empty groups render nothing. */
function groupBlock(key: ElementGroup, uids: Uid[], res: SpecResult, modelNames: ModelNames): string {
  if (uids.length === 0) return '';
  const items = uids
    .map((uid) => {
      const o = res.outcomes[uid];
      return o ? elementBlock(uid, o, key, modelNames) : '';
    })
    .join('');
  const open = key === 'pass' ? '' : ' open';
  return `<details class="group group-${key}"${open}>
    <summary>${GROUP_LABEL[key]} (${uids.length})</summary>
    ${items}
  </details>`;
}

/** Plain div progress bar — inline width, print-friendly, no JS. */
function progressBar(percent: number | null): string {
  return `<div class="bar"><span class="bar-fill" style="width: ${percent ?? 0}%"></span></div>`;
}

function progressText(passed: number, total: number, percent: number | null): string {
  return `${passed}/${total} (${percent === null ? '—' : `${percent}%`})`;
}

/** Standalone, printable HTML report grouped spec → element status → requirement checks. */
export function reportToHtml(
  doc: IdsDocument,
  results: Record<string, SpecResult>,
  modelNames: ModelNames = {},
  options: ReportHtmlOptions = {},
): string {
  const generated = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const hideNotApplicable = options.hideNotApplicable ?? false;

  // Specifications rendered in this report (N/A ones dropped when asked).
  const visible = doc.specifications.filter(
    (spec) => !hideNotApplicable || !isNotApplicable(results[spec.id]),
  );
  const hiddenCount = hideNotApplicable ? doc.specifications.length - visible.length : 0;

  const summaryRows = visible
    .map((spec) => {
      const res = results[spec.id];
      const prog = res
        ? specProgress(res)
        : { pass: [], partial: [], fail: [], checksPassed: 0, checksTotal: 0, percent: null };
      const verdict = specVerdict(res);
      const cls = verdict === 'Pass' ? 'ok' : verdict === 'Fail' ? 'bad' : 'na';
      return `<tr>
        <td>${esc(spec.name)}</td>
        <td class="${cls}">${verdict}</td>
        <td>${prog.pass.length}</td>
        <td>${prog.partial.length}</td>
        <td>${prog.fail.length}</td>
        <td>${progressText(prog.checksPassed, prog.checksTotal, prog.percent)}</td>
      </tr>`;
    })
    .join('');

  const specBlocks = visible
    .map((spec) => {
      const res = results[spec.id];
      const applicable = res?.applicable.length ?? 0;

      // Spec-level cardinality failure (e.g. required but zero applicable) —
      // report it as a failure of the whole spec, not "not applicable".
      const cardFailed = res !== undefined && !res.cardinalitySatisfied;

      if (!res || (applicable === 0 && !cardFailed)) {
        return `<section class="spec"><h2>${esc(spec.name)}</h2>
          <p class="na">Not applicable to the loaded models.</p></section>`;
      }

      if (applicable === 0 && cardFailed) {
        return `<section class="spec">
          <h2>${esc(spec.name)}</h2>
          ${spec.description ? `<p class="desc">${esc(spec.description)}</p>` : ''}
          <p class="summary"><span class="bad">Specification failed</span></p>
          <div class="item item-fail">
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

      const prog = specProgress(res);
      const groups = GROUP_ORDER.map((key) => groupBlock(key, prog[key], res, modelNames)).join('');

      return `<section class="spec">
        <h2>${esc(spec.name)}</h2>
        ${spec.description ? `<p class="desc">${esc(spec.description)}</p>` : ''}
        <p class="summary">
          <span class="ok">${prog.pass.length} pass</span> ·
          <span class="warn">${prog.partial.length} partial</span> ·
          <span class="bad">${prog.fail.length} fail</span> ·
          <span class="tot">${applicable} applicable</span> ·
          <span class="tot">${progressText(prog.checksPassed, prog.checksTotal, prog.percent)} checks</span>
        </p>
        ${progressBar(prog.percent)}
        ${cardFailed ? `<p class="bad">⚠ ${esc(res.cardinalityReason ?? 'Specification cardinality not satisfied')}</p>` : ''}
        ${groups}
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
  .hidden-note { color: #666; font-size: 12px; margin: -14px 0 20px; }
  .spec { border-top: 1px solid #ddd; padding-top: 14px; margin-top: 14px; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .desc { color: #555; margin: 0 0 6px; }
  .summary { margin: 0 0 6px; font-size: 12px; }
  .ok { color: #16a34a; } .bad { color: #dc2626; } .warn { color: #d97706; } .tot { color: #888; }
  .na, .allpass { color: #888; font-style: italic; }
  table.summary-table { border-collapse: collapse; margin: 0 0 20px; width: 100%; max-width: 860px; }
  table.summary-table th, table.summary-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; font-size: 12px; }
  table.summary-table th { color: #666; font-weight: 500; }
  .bar { background: #eee; border-radius: 3px; height: 6px; margin: 0 0 10px; max-width: 720px; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .bar-fill { background: #16a34a; border-radius: 3px; display: block; height: 6px; }
  details.group { margin: 0 0 10px; }
  details.group > summary { cursor: pointer; font-size: 12px; font-weight: 600; }
  .group-fail > summary { color: #dc2626; }
  .group-partial > summary { color: #d97706; }
  .group-pass > summary { color: #16a34a; }
  .item { margin: 8px 0 12px; padding-left: 10px; border-left: 3px solid #ccc; }
  .item-fail { border-left-color: #dc2626; }
  .item-partial { border-left-color: #d97706; }
  .item-pass { border-left-color: #16a34a; }
  .item-head { display: flex; gap: 8px; align-items: baseline; }
  .item-name { font-weight: 600; }
  .item-meta { color: #888; font-size: 11px; }
  table.fails { border-collapse: collapse; margin: 4px 0 0; width: 100%; max-width: 720px; }
  table.fails th, table.fails td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #eee; font-size: 12px; }
  table.fails th { color: #666; font-weight: 500; }
  table.fails th.mark, table.fails td.mark { text-align: center; width: 1.5em; }
  tr.failed td { background: #fef2f2; }
  td.found { color: #b45309; }
  @media print { .item { break-inside: avoid; } }
</style></head>
<body>
  <h1>IDS Validation Report</h1>
  <p class="meta">${esc(doc.title)} · generated ${esc(generated)}</p>
  ${hiddenCount > 0 ? `<p class="hidden-note">${hiddenCount} not-applicable specification${hiddenCount === 1 ? '' : 's'} hidden</p>` : ''}
  <table class="summary-table">
    <thead><tr><th>Specification</th><th>Status</th><th>Pass</th><th>Partial</th><th>Fail</th><th>Progress</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>
  ${specBlocks}
</body></html>`;
}
