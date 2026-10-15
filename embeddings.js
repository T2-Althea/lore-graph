// Meaning-based search (Milestone 3b). Chunks and entities are embedded by the user's
// local model in LM Studio, through SillyTavern's own vector storage with the "vllm"
// source (an OpenAI-compatible /v1/embeddings endpoint). Requests go from the SillyTavern
// server to LM Studio, never from the browser, so there are no CORS problems.

import { getRequestHeaders } from '../../../../script.js';
import { getStringHash } from '../../../utils.js';
import { FILE_PREFIX, loadJsonFile, saveJsonFile } from './storage.js';

export const CHUNK_COLLECTION = 'lore_graph_chunks';
export const ENTITY_COLLECTION = 'lore_graph_entities';
export const EMBEDDINGS_FILE = `${FILE_PREFIX}embeddings.json`;

/** Qwen3-Embedding is instruction-aware: queries (never documents) get this prefix. */
export const QUERY_INSTRUCTION = 'Instruct: Given a roleplay scene, retrieve worldbuilding lore relevant to what is happening\nQuery: ';

/** Long queries dilute the meaning; keep the newest part of the scanned messages. */
const MAX_QUERY_CHARS = 2000;
const INSERT_BATCH = 20;

export const DEFAULT_EMBEDDING_SETTINGS = {
    embed_enabled: false,
    embed_url: 'http://127.0.0.1:1234',
    embed_model: '',
    embed_top_k: 4,
    embed_threshold: 0.45,
};

/** A hit at least this far above the threshold counts as "strong"; others count half. */
const STRONG_MARGIN = 0.07;

/**
 * @typedef {object} EmbeddingState what's saved in lore-graph_embeddings.json
 * @property {string} model model that produced the stored vectors
 * @property {string} url
 * @property {number} builtAt
 * @property {Record<string, string>} chunks vector hash -> chunk id
 * @property {Record<string, string>} entities vector hash -> entity id
 */

/** @type {EmbeddingState|null} */
let cachedState = null;

/** @returns {Promise<EmbeddingState|null>} */
export async function loadEmbeddingState({ fresh = false } = {}) {
    if (cachedState && !fresh) return cachedState;
    const data = await loadJsonFile(EMBEDDINGS_FILE);
    cachedState = data && typeof data === 'object'
        ? { model: '', url: '', builtAt: 0, chunks: {}, entities: {}, ...data }
        : null;
    return cachedState;
}

function sourceBody(settings) {
    return { source: 'vllm', apiUrl: settings.embed_url, model: settings.embed_model };
}

async function vectorApi(path, settings, payload) {
    const response = await fetch(`/api/vector/${path}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ ...sourceBody(settings), ...payload }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Embedding request failed (${response.status}). Is LM Studio running at ${settings.embed_url} with the model "${settings.embed_model}" loaded? ${text}`.trim());
    }
    return path === 'query' || path === 'list' ? await response.json() : null;
}

/**
 * The text stored for a chunk: "Doc title > Section > Subsection", the TL;DR, then the text.
 * @param {import('./parser.js').LoreChunk} chunk
 */
export function chunkEmbeddingText(chunk) {
    const location = [chunk.docTitle, `${chunk.sectionNumber ?? '?'}. ${chunk.sectionTitle}`, chunk.subsectionTitle].filter(Boolean).join(' > ');
    return [location, chunk.tldr, chunk.text, chunk.guardrail ? `✕ Not This: ${chunk.guardrail}` : ''].filter(Boolean).join('\n');
}

/**
 * The text stored for an entity: name, other names, one-sentence description.
 * @param {import('./graph.js').Entity} entity
 */
export function entityEmbeddingText(entity) {
    const aliases = entity.aliases.length ? ` (also called: ${entity.aliases.join(', ')})` : '';
    return `${entity.name}${aliases}: ${entity.description || entity.type}`;
}

/**
 * Brings one collection in line with the wanted items: embeds new or changed ones,
 * removes ones that no longer exist.
 * @returns {Promise<{ added: number, removed: number, map: Record<string, string> }>}
 */
async function syncCollection(collectionId, wanted, settings, onProgress) {
    /** @type {Map<number, { id: string, text: string }>} */
    const byHash = new Map();
    for (const item of wanted) {
        byHash.set(getStringHash(item.text), item);
    }
    const existing = new Set((await vectorApi('list', settings, { collectionId })).map(Number));
    const toAdd = [...byHash].filter(([hash]) => !existing.has(hash));
    const toRemove = [...existing].filter(hash => !byHash.has(hash));

    for (let i = 0; i < toAdd.length; i += INSERT_BATCH) {
        const batch = toAdd.slice(i, i + INSERT_BATCH);
        await vectorApi('insert', settings, {
            collectionId,
            items: batch.map(([hash, item], j) => ({ hash, text: item.text, index: i + j })),
        });
        onProgress?.(Math.min(i + INSERT_BATCH, toAdd.length), toAdd.length);
    }
    if (toRemove.length) {
        await vectorApi('delete', settings, { collectionId, hashes: toRemove });
    }
    return {
        added: toAdd.length,
        removed: toRemove.length,
        map: Object.fromEntries([...byHash].map(([hash, item]) => [String(hash), item.id])),
    };
}

/**
 * Builds or updates the meaning index for the current chunks and entities.
 * Only new or changed texts are embedded; the vectors themselves are stored by
 * SillyTavern under data/<user>/vectors/vllm/<collection>/<model>/.
 * @param {import('./parser.js').LoreChunk[]} chunks
 * @param {import('./graph.js').Entity[]} entities
 * @param {object} settings extension settings
 * @param {(stage: string, done: number, total: number) => void} [onProgress]
 */
export async function syncEmbeddingIndex(chunks, entities, settings, onProgress) {
    if (!settings.embed_model) {
        throw new Error('Enter the embedding model name first (as LM Studio shows it).');
    }
    const chunkResult = await syncCollection(CHUNK_COLLECTION,
        chunks.map(c => ({ id: c.id, text: chunkEmbeddingText(c) })), settings,
        (done, total) => onProgress?.('chunks', done, total));
    const entityResult = await syncCollection(ENTITY_COLLECTION,
        entities.map(e => ({ id: e.id, text: entityEmbeddingText(e) })), settings,
        (done, total) => onProgress?.('entities', done, total));

    // The collections now hold exactly the current items, so the mapping does too.
    // (Switching to a chat with other Data Bank files needs another "Build / update index".)
    const state = {
        model: settings.embed_model,
        url: settings.embed_url,
        builtAt: Date.now(),
        chunks: chunkResult.map,
        entities: entityResult.map,
    };
    await saveJsonFile(EMBEDDINGS_FILE, state);
    cachedState = state;
    return { chunks: chunkResult, entities: entityResult };
}

/**
 * The query text: the scanned messages, newest last, trimmed to the newest part.
 * @param {string[]} messages
 */
export function buildQueryText(messages) {
    const joined = messages.join('\n').trim();
    return joined.length > MAX_QUERY_CHARS ? joined.slice(-MAX_QUERY_CHARS) : joined;
}

/**
 * Searches both collections by meaning.
 * @param {string} queryText
 * @param {object} settings extension settings
 * @param {{ topK?: number, threshold?: number }} [overrides]
 * @returns {Promise<{ chunks: { id: string, rank: number, weak: boolean }[], entities: { id: string, rank: number, weak: boolean }[] }>} best first
 */
export async function semanticSearch(queryText, settings, overrides = {}) {
    const state = await loadEmbeddingState();
    if (!state) {
        throw new Error('The meaning index hasn\'t been built yet. Click "Build / update index".');
    }
    if (state.model !== settings.embed_model) {
        throw new Error(`The meaning index was built with "${state.model}" but the selected model is "${settings.embed_model}". Rebuild the index.`);
    }
    const searchText = QUERY_INSTRUCTION + queryText;
    const topK = overrides.topK ?? settings.embed_top_k;
    const threshold = overrides.threshold ?? settings.embed_threshold;

    // SillyTavern returns matches in order but without their similarity numbers, so a second,
    // stricter query tells "strong" hits apart from ones that only just cleared the threshold.
    const toIds = (result, map) => (result?.metadata ?? [])
        .map(m => map[String(m.hash)])
        .filter(Boolean)
        .filter((id, i, all) => all.indexOf(id) === i);
    const query = (collectionId, minScore) => vectorApi('query', settings, { collectionId, searchText, topK, threshold: minScore });

    const [chunkHits, entityHits, strongChunks] = await Promise.all([
        query(CHUNK_COLLECTION, threshold),
        query(ENTITY_COLLECTION, threshold),
        query(CHUNK_COLLECTION, threshold + STRONG_MARGIN),
    ]);
    const strong = new Set(toIds(strongChunks, state.chunks));
    return {
        chunks: toIds(chunkHits, state.chunks).map((id, rank) => ({ id, rank, weak: !strong.has(id) })),
        entities: toIds(entityHits, state.entities).map((id, rank) => ({ id, rank, weak: false })),
    };
}
