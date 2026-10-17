// Shared helpers: parse fixture lore and build a graph with the fake AI's extraction answers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLoreDocument } from '../../parser.js';
import { validateExtraction } from '../../schema.js';
import { buildGraph, createEmptyStore } from '../../graph.js';
import { buildRetrievalIndex, createEmptyMatching } from '../../retrieval.js';
import { pickAnswer } from '../fake-answers.js';
import { formatChunk } from '../../parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, '..', 'fixtures');
/** The user's own lore, if copied into dev/.work/lore (not committed). */
export const PRIVATE_LORE = path.join(here, '..', '.work', 'lore');

export const countTokens = (text) => Math.ceil(String(text).length / 4);

export async function loadDoc(file) {
    const text = fs.readFileSync(file, 'utf8');
    return parseLoreDocument(text, { fileName: path.basename(file), countTokens });
}

export async function loadChunks(files) {
    const chunks = [];
    for (const file of files) chunks.push(...(await loadDoc(file)).chunks);
    return chunks;
}

/** Extraction through the fake AI, then the real graph and retrieval index. */
export function buildIndexWithFakeAi(chunks) {
    const store = createEmptyStore();
    for (const chunk of chunks) {
        const reply = pickAnswer([
            { role: 'system', content: 'You extract a knowledge graph' },
            { role: 'user', content: `KNOWN ENTITIES:\n(none)\n\nLORE CHUNK:\n${formatChunk(chunk)}` },
        ]);
        const result = validateExtraction(reply);
        if (!result.ok) throw new Error(`${chunk.id}: ${result.error}`);
        store.chunkResults[chunk.id] = { hash: chunk.hash, status: 'ok', extractedAt: 0, entities: result.entities, relations: result.relations, notes: [], error: null };
    }
    const graph = buildGraph(store, chunks.map(c => c.id));
    return { store, graph, index: buildRetrievalIndex(graph, chunks, createEmptyMatching()) };
}
