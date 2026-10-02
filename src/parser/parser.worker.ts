/**
 * Web Worker for large IFC file parsing via web-ifc WASM.
 *
 * Protocol (main thread → worker):
 *   { type: 'parse', buffer: ArrayBuffer, filename: string, bimUseProfile?: BimUseProfileId, wasmPath?: string }
 *
 * Protocol (worker → main thread):
 *   { type: 'progress', percent: number, entitiesParsed: number }
 *   { type: 'done', entities: [id, entity][], triples: Triple[], schema: string, filename: string }
 *   { type: 'error', message: string }
 */

import { IfcLoader } from './ifc-loader.js';
import { extractFromRecords } from './extractor.js';
import type { BimUseProfileId } from './bim-use-filter.js';
import type { Triple } from './types.js';

interface ParseMessage {
  type: 'parse';
  buffer: ArrayBuffer;
  filename: string;
  bimUseProfile?: BimUseProfileId;
  wasmPath?: string;
}

self.onmessage = async (ev: MessageEvent<ParseMessage>) => {
  if (ev.data.type !== 'parse') return;

  const { buffer, filename, bimUseProfile = 'learning', wasmPath } = ev.data;

  try {
    const loader = new IfcLoader();
    await loader.init(wasmPath);

    const { records, schema, bboxes, geomStats } = await loader.load(
      new Uint8Array(buffer),
      (percent, parsed) => {
        self.postMessage({ type: 'progress', percent: Math.floor(percent * 0.9), entitiesParsed: parsed });
      },
    );
    loader.dispose();

    self.postMessage({ type: 'progress', percent: 90, entitiesParsed: records.length });

    const { entities, triples } = extractFromRecords(records, schema, filename, bimUseProfile, bboxes, geomStats);

    self.postMessage({ type: 'progress', percent: 100, entitiesParsed: entities.size });

    const entityEntries = [...entities.entries()];
    const triplesArr: Triple[] = triples;
    self.postMessage({ type: 'done', entities: entityEntries, triples: triplesArr, schema, filename });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};
