#!/usr/bin/env node
// Copies the checker's binary assets from node_modules into a host app's public folder:
//   <dest>/duckdb/duckdb-eh.wasm, <dest>/duckdb/duckdb-browser-eh.worker.js, <dest>/web-ifc.wasm
// Usage: ids-checker-copy-assets <dest-dir>   (run from the app, e.g. as "predev"/"prebuild")
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const dest = resolve(process.argv[2] ?? 'public/checker');
const require = createRequire(join(process.cwd(), 'package.json'));
// The package folder: up from its main entry to the package.json naming it (some packages do
// not export "./package.json", so it cannot be resolved directly).
const pkgDir = (name) => {
  for (let dir = dirname(require.resolve(name)); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir;
  }
  throw new Error(`ids-checker: cannot find the ${name} package folder`);
};

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
