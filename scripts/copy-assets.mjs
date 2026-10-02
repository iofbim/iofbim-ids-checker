#!/usr/bin/env node
// Copies the checker's binary assets from node_modules into a host app's public folder:
//   <dest>/duckdb/duckdb-eh.wasm, <dest>/duckdb/duckdb-browser-eh.worker.js, <dest>/web-ifc.wasm
// Usage: ids-checker-copy-assets <dest-dir>   (run from the app, e.g. as "predev"/"prebuild")
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const dest = resolve(process.argv[2] ?? 'public/checker');
const require = createRequire(join(process.cwd(), 'package.json'));
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

const files = [
  [join(pkgDir('@duckdb/duckdb-wasm'), 'dist/duckdb-eh.wasm'), join(dest, 'duckdb/duckdb-eh.wasm')],
  [join(pkgDir('@duckdb/duckdb-wasm'), 'dist/duckdb-browser-eh.worker.js'), join(dest, 'duckdb/duckdb-browser-eh.worker.js')],
  [join(pkgDir('web-ifc'), 'web-ifc.wasm'), join(dest, 'web-ifc.wasm')],
];
for (const [from, to] of files) {
  if (!existsSync(from)) throw new Error(`ids-checker: missing ${from} — is the dependency installed?`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log(`ids-checker: assets copied to ${dest}`);
