/**
 * Loaded models kept in the browser (IndexedDB), so a model is checked again without parsing
 * its IFC: a snapshot of its database rows plus what the model list shows. Nothing leaves the
 * device. Entries from another parser or snapshot format are skipped (and removed), so a
 * changed parser never reads stale rows.
 */

import { PARSER_VERSION } from './parser/types.js';
import { SNAPSHOT_MAGIC } from './db/snapshot.js';

const DB_NAME = 'iofbim-ids-checker';
const STORE = 'models';
/** What an entry must have been written by to be read back */
const FORMAT = `${PARSER_VERSION}/${SNAPSHOT_MAGIC.toString(16)}`;

/** A model saved in this browser */
export interface CachedModelInfo {
  modelId: string;
  filename: string;
  schema: string;
  entityCount: number;
  /** Size of the stored snapshot */
  bytes: number;
  /** ISO time it was saved */
  savedAt: string;
}

interface Entry extends CachedModelInfo {
  format: string;
  snapshot: Uint8Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'modelId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the model cache'));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('model cache request failed'));
      tx.onabort = () => reject(tx.error ?? new Error('model cache request aborted'));
    });
  } finally {
    db.close();
  }
}

const info = ({ modelId, filename, schema, entityCount, bytes, savedAt }: Entry): CachedModelInfo => ({ modelId, filename, schema, entityCount, bytes, savedAt });

/** The models saved in this browser, newest first (entries of another format are removed) */
export async function listCachedModels(): Promise<CachedModelInfo[]> {
  const all = await run<Entry[]>('readonly', (s) => s.getAll() as IDBRequest<Entry[]>);
  const stale = all.filter((e) => e.format !== FORMAT);
  for (const e of stale) await deleteCachedModel(e.modelId);
  return all.filter((e) => e.format === FORMAT).map(info).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** A saved model's snapshot, or null when there is none of this format */
export async function readCachedModel(modelId: string): Promise<{ info: CachedModelInfo; snapshot: Uint8Array } | null> {
  const e = await run<Entry | undefined>('readonly', (s) => s.get(modelId) as IDBRequest<Entry | undefined>);
  return e && e.format === FORMAT ? { info: info(e), snapshot: e.snapshot } : null;
}

export async function writeCachedModel(model: Omit<CachedModelInfo, 'bytes' | 'savedAt'>, snapshot: Uint8Array): Promise<void> {
  const entry: Entry = { ...model, bytes: snapshot.byteLength, savedAt: new Date().toISOString(), format: FORMAT, snapshot };
  await run('readwrite', (s) => s.put(entry));
}

/** Removes one saved model */
export async function deleteCachedModel(modelId: string): Promise<void> {
  await run('readwrite', (s) => s.delete(modelId));
}

/** Removes every saved model */
export async function clearModelCache(): Promise<void> {
  await run('readwrite', (s) => s.clear());
}
