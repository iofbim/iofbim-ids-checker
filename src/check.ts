/**
 * High-level checking API for host apps that only need "load IFC, run IDS, read results"
 * (e.g. the IDS authoring tool). Apps with their own pipeline (IFC Graph) use the
 * parser / db / ids modules directly.
 *
 *   configureChecker({ duckdbBaseUrl, webIfcWasmPath });
 *   const model = await loadIfcModel(file, { onProgress });     // parsed, or read from the cache
 *   const { document, results } = await checkIds(idsXml, [model.modelId]);
 *   await unloadIfcModel(model.modelId);
 *
 * Loaded models are saved in the browser (model-cache.ts) unless `cache: false`; a saved model
 * comes back with restoreCachedModel(modelId) — no file, no parse.
 */

import { webIfcWasmPath } from './config.js';
import { restoreModel, serializeModel, StaleSnapshotError } from './db/snapshot.js';
import { deleteCachedModel, readCachedModel, writeCachedModel, type CachedModelInfo } from './model-cache.js';
import { awaitIngest, dropModel } from './db/client.js';
import { ingestModel } from './db/ingest.js';
import { evaluateDocument } from './ids/evaluate-ids.js';
import { parseIds } from './ids/parse-ids.js';
import type { IdsDocument, SpecResult } from './ids/types.js';
import type { IfcEntity, ParsedModel, Triple } from './parser/types.js';

/** A model loaded into the checker's database. */
export interface LoadedIfcModel {
  modelId: string;
  filename: string;
  /** IFC schema from the file header, e.g. "IFC4X3_ADD2". */
  schema: string;
  entityCount: number;
}

export interface LoadOptions {
  /** 0–100 while parsing and loading. */
  onProgress?: (percent: number) => void;
  /** Read the model from the browser cache when it is there, and save it after parsing (default true) */
  cache?: boolean;
}

/** SHA-256 hex of the file bytes: the same file always gets the same model id. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type WorkerReply =
  | { type: 'progress'; percent: number }
  | { type: 'done'; entities: [number, IfcEntity][]; triples: Triple[]; schema: string; filename: string }
  | { type: 'error'; message: string };

/** Parses an IFC file in a Web Worker (web-ifc + extractor), off the main thread. */
function parseInWorker(buffer: ArrayBuffer, filename: string, onProgress?: (percent: number) => void): Promise<Omit<ParsedModel, 'modelId' | 'accentColor' | 'sha256'>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parser/parser.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const data = event.data;
      if (data.type === 'progress') onProgress?.(Math.min(90, data.percent));
      else if (data.type === 'done') {
        worker.terminate();
        resolve({ entities: new Map(data.entities), triples: data.triples, schema: data.schema, filename: data.filename });
      } else {
        worker.terminate();
        reject(new Error(data.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'IFC parser worker failed'));
    };
    const wasmPath = webIfcWasmPath();
    // The buffer is transferred (detached) to the worker.
    worker.postMessage({ type: 'parse', buffer, filename, ...(wasmPath !== undefined && { wasmPath }) }, [buffer]);
  });
}

/** Parses an IFC file and loads it into the checker's database (replacing a model with the same content). */
export async function loadIfcModel(file: Blob & { name?: string }, options: LoadOptions = {}): Promise<LoadedIfcModel> {
  const useCache = options.cache !== false;
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  const filename = file.name || 'model.ifc';

  // The same content was loaded before: put its rows back instead of parsing
  if (useCache) {
    const restored = await restoreCachedModel(sha256).catch(() => null);
    if (restored) {
      options.onProgress?.(100);
      return { ...restored, filename };
    }
  }

  const parsed = await parseInWorker(buffer, filename, options.onProgress);
  const model: ParsedModel = { ...parsed, modelId: sha256, sha256, accentColor: '' };
  ingestModel(model);
  await awaitIngest(model.modelId);
  const loaded = { modelId: model.modelId, filename, schema: model.schema, entityCount: model.entities.size };
  // Saving is a convenience: a full or unavailable store must not fail the load
  if (useCache) await serializeModel(model.modelId).then((snap) => writeCachedModel(loaded, snap)).catch(() => undefined);
  options.onProgress?.(100);
  return loaded;
}

/**
 * Loads a model saved in this browser into the checker's database; null when it is not saved
 * (or was saved by another format, which is then removed).
 */
export async function restoreCachedModel(modelId: string): Promise<LoadedIfcModel | null> {
  const cached = await readCachedModel(modelId);
  if (!cached) return null;
  try {
    await restoreModel(modelId, cached.snapshot);
  } catch (err) {
    if (err instanceof StaleSnapshotError) { await deleteCachedModel(modelId); return null; }
    throw err;
  }
  const { filename, schema, entityCount }: CachedModelInfo = cached.info;
  return { modelId, filename, schema, entityCount };
}

/** Removes a model's rows from the checker's database. */
export async function unloadIfcModel(modelId: string): Promise<void> {
  await dropModel(modelId);
}

/** Parses an IDS document and checks every specification against the given models. */
export async function checkIds(idsXml: string, modelIds: string[], fallbackTitle = 'IDS'): Promise<{ document: IdsDocument; results: Record<string, SpecResult> }> {
  const document = parseIds(idsXml, fallbackTitle);
  for (const modelId of modelIds) await awaitIngest(modelId);
  const results = await evaluateDocument(document.specifications, modelIds);
  return { document, results };
}
