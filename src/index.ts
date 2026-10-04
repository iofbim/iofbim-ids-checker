// @iofbim/ids-checker — check IFC models against buildingSMART IDS in the browser.
// High-level API (load / check / unload) plus the modules apps build their own pipeline on.
export { configureChecker, type CheckerAssets } from './config.js';
export { loadIfcModel, unloadIfcModel, checkIds, restoreCachedModel, type LoadedIfcModel, type LoadOptions } from './check.js';
export { listCachedModels, deleteCachedModel, clearModelCache, type CachedModelInfo } from './model-cache.js';
export { parseIds } from './ids/parse-ids.js';
export { xsdToJs, xsdToRe2, hasClassSubtraction } from './ids/xsd-regex.js';
export { evaluateDocument, evaluateSpec } from './ids/evaluate-ids.js';
export { buildReportRows, reportToCsv, reportToHtml, type ModelNames, type ReportRow } from './ids/ids-report.js';
export type * from './ids/types.js';
