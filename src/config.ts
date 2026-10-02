/**
 * Where the host app serves the checker's binary assets. Both apps copy them from
 * node_modules into their public folder (see `scripts/copy-assets.mjs`):
 *
 *   <base>/duckdb/duckdb-eh.wasm, <base>/duckdb/duckdb-browser-eh.worker.js   (DuckDB-WASM)
 *   <base>/web-ifc.wasm                                                       (web-ifc)
 *
 * Call `configureChecker` once at startup, before the first parse or query.
 */
export interface CheckerAssets {
  /** Absolute or page-relative URL of the folder holding DuckDB's wasm + worker. */
  duckdbBaseUrl?: string;
  /** Folder URL where `web-ifc.wasm` lives (passed to web-ifc's SetWasmPath). */
  webIfcWasmPath?: string;
}

let assets: CheckerAssets = {};

export function configureChecker(next: CheckerAssets): void {
  assets = { ...assets, ...next };
}

export function duckdbBaseUrl(): string {
  return assets.duckdbBaseUrl ?? new URL('duckdb', document.baseURI).toString();
}

export function webIfcWasmPath(): string | undefined {
  return assets.webIfcWasmPath;
}
