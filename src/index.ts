// @iofbim/ids-checker — check IFC models against buildingSMART IDS in the browser.
// High-level API (load / check / unload) plus the modules apps build their own pipeline on.
export { configureChecker, type CheckerAssets } from './config.js';
export { loadIfcModel, unloadIfcModel, checkIds, type LoadedIfcModel, type LoadOptions } from './check.js';
export { parseIds } from './ids/parse-ids.js';
export { evaluateDocument, evaluateSpec } from './ids/evaluate-ids.js';
export { buildReportRows, reportToCsv, reportToHtml, type ReportRow } from './ids/ids-report.js';
export type * from './ids/types.js';
