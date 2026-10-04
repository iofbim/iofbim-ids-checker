/**
 * A model's DuckDB rows as one byte buffer, and back: the model cache stores these so a model
 * loads again without re-parsing its IFC (moved here from IFC Graph's arrow-cache, which keeps
 * its own copy for now).
 *
 * Only the materialized tables are captured; classifications / materials / documents are
 * views over them and rebuild by themselves. Each table travels as Parquet (DuckDB-WASM has no
 * Arrow COPY any more), bundled as:
 *   [u32 magic] [u32 table count] then per table: [u32 name length][name][u32 length][Parquet]
 * The magic is bumped whenever a table's columns change, so an old snapshot is refused (the
 * caller re-parses) instead of being inserted into a table it no longer fits.
 */

import { getDb } from './client.js';
import { MATERIALIZED_TABLES } from './schema.js';

/** 'IDC1': entities with empty_attrs (parser 1.03) */
export const SNAPSHOT_MAGIC = 0x49444331;

function u32(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, true);
  return buf;
}

const tmpName = (kind: string, table: string) => `_${kind}_${table}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.parquet`;

/** The model's rows of every materialized table */
export async function serializeModel(modelId: string): Promise<Uint8Array> {
  const db = await getDb();
  const conn = await db.connect();
  const safe = modelId.replace(/'/g, "''");
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [u32(SNAPSHOT_MAGIC), u32(MATERIALIZED_TABLES.length)];
  try {
    for (const table of MATERIALIZED_TABLES) {
      const file = tmpName('snapshot', table);
      try {
        // Registered first: otherwise COPY writes to DuckDB's own FS and the read-back is empty
        await db.registerEmptyFileBuffer(file);
        await conn.query(`COPY (SELECT * FROM ${table} WHERE model_id = '${safe}') TO '${file}' (FORMAT PARQUET)`);
        const bytes = await db.copyFileToBuffer(file);
        if (bytes.length === 0) throw new Error(`snapshot of ${table} came back empty`);
        const name = enc.encode(table);
        chunks.push(u32(name.length), name, u32(bytes.length), bytes);
      } finally {
        await db.dropFile(file).catch(() => { /* never created */ });
      }
    }
  } finally {
    await conn.close();
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Thrown for a snapshot this build cannot read; load the IFC again instead */
export class StaleSnapshotError extends Error {}

/** Puts a snapshot's rows back (replacing any rows the model already has) */
export async function restoreModel(modelId: string, snapshot: Uint8Array): Promise<void> {
  if (snapshot.length < 8) throw new StaleSnapshotError('snapshot too short');
  const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
  if (view.getUint32(0, true) !== SNAPSHOT_MAGIC) throw new StaleSnapshotError('snapshot from another format');

  const db = await getDb();
  const conn = await db.connect();
  const dec = new TextDecoder();
  const safe = modelId.replace(/'/g, "''");
  try {
    for (const t of MATERIALIZED_TABLES) await conn.query(`DELETE FROM ${t} WHERE model_id = '${safe}'`);
    let at = 4;
    const count = view.getUint32(at, true); at += 4;
    for (let i = 0; i < count; i++) {
      const nameLen = view.getUint32(at, true); at += 4;
      const table = dec.decode(snapshot.subarray(at, at + nameLen)); at += nameLen;
      const len = view.getUint32(at, true); at += 4;
      const bytes = snapshot.slice(at, at + len); at += len;
      if (!(MATERIALIZED_TABLES as readonly string[]).includes(table)) throw new StaleSnapshotError(`unknown table ${table}`);
      if (len === 0) continue;
      const file = tmpName('restore', table);
      try {
        await db.registerFileBuffer(file, bytes);
        await conn.query(`INSERT INTO ${table} SELECT * FROM read_parquet('${file}')`);
      } finally {
        await db.dropFile(file).catch(() => { /* never registered */ });
      }
    }
  } finally {
    await conn.close();
  }
}
