/**
 * DuckDB-WASM singleton.
 *
 * Uses the single-threaded EH bundle (served by the app, see configureChecker) so the app
 * works fully offline without COOP/COEP headers.
 *
 * Pattern: one AsyncDuckDB instance, one long-lived connection for schema/ingest,
 * short-lived connections for individual queries (opened and closed per query batch).
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import { initSchema, MATERIALIZED_TABLES } from './schema.js';
import { duckdbBaseUrl } from '../config.js';

// ---------------------------------------------------------------------------
// Bundle config — EH (single-threaded) from /public/duckdb/
// ---------------------------------------------------------------------------

function makeBundle(): duckdb.DuckDBBundles {
  // The app tells the checker where it serves DuckDB's files (configureChecker),
  // e.g. `${import.meta.env.BASE_URL}duckdb` in a Vite app or `${basePath}/checker/duckdb`
  // in Next.js. Without it: `duckdb/` next to the current page.
  const base = duckdbBaseUrl().replace(/\/$/, '');
  return {
    mvp: {
      mainModule:  `${base}/duckdb-eh.wasm`,
      mainWorker:  `${base}/duckdb-browser-eh.worker.js`,
    },
    eh: {
      mainModule:  `${base}/duckdb-eh.wasm`,
      mainWorker:  `${base}/duckdb-browser-eh.worker.js`,
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton promise — initialised once, reused everywhere
// ---------------------------------------------------------------------------

let _dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!_dbPromise) {
    _dbPromise = initDb();
  }
  return _dbPromise;
}

async function initDb(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(makeBundle());
  const workerUrl = bundle.mainWorker!;
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  await initSchema(conn);
  await conn.close();
  return db;
}

// ---------------------------------------------------------------------------
// Ingest-progress tracking: callers can await pending ingests per modelId
// ---------------------------------------------------------------------------

const _ingestPromises = new Map<string, Promise<void>>();

export function setIngestPromise(modelId: string, p: Promise<void>): void {
  _ingestPromises.set(modelId, p.finally(() => _ingestPromises.delete(modelId)));
}

/** Await any pending ingest for modelId before running a query. */
export async function awaitIngest(modelId: string): Promise<void> {
  const p = _ingestPromises.get(modelId);
  if (p) await p;
}

/** Await all pending ingests across all models. */
export async function awaitAllIngests(): Promise<void> {
  await Promise.all([..._ingestPromises.values()]);
}

// ---------------------------------------------------------------------------
// Drop all rows for a model (call when a model is unloaded)
// ---------------------------------------------------------------------------

export async function dropModel(modelId: string): Promise<void> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    // Views (classifications/materials/documents) empty automatically when their
    // base rows go — only delete the materialized tables (ADR-016.1).
    for (const t of MATERIALIZED_TABLES) {
      await conn.query(`DELETE FROM ${t} WHERE model_id = '${modelId.replace(/'/g, "''")}'`);
    }
  } finally {
    await conn.close();
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    _dbPromise?.then(db => db.terminate()).catch(() => {});
  });
}
