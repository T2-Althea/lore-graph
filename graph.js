// Builds the knowledge graph from the per-chunk extraction results (the "merge pass").
// Pure JavaScript with no SillyTavern imports, so it can be tested in Node.
// No LLM calls happen here: the graph can always be rebuilt from saved results.

import { FALLBACK_ENTITY_TYPE, matchForm, normalizeKey } from './schema.js';

export const GRAPH_VERSION = 1;

/**
 * @typedef {object} ChunkResult
 * @property {string} hash chunk content hash at extraction time
 * @property {'ok'|'failed'} status
 * @property {number} extractedAt
 * @property {string} [profileName]
 * @property {string} [model]
 * @property {import('./schema.js').ExtractedEntity[]} entities
 * @property {import('./schema.js').ExtractedRelation[]} relations
 * @property {string[]} notes
 * @property {string|null} error
 * @property {string} [rawPreview] start of the last raw reply, kept for failures
 */

/**
 * @typedef {object} GraphStore what's saved in lore-graph_graph.json
 * @property {number} version
 * @property {Record<string, ChunkResult>} chunkResults keyed by chunk id
 * @property {{ merges: [string, string][], rejected: [string, string][], pending: { a: string, b: string, reason: string }[] }} decisions
 *   merges/rejected hold normalized keys; pending holds duplicate-finder suggestions awaiting review
 * @property {{ entities: Entity[], edges: Edge[], builtAt: number }} [graph] snapshot of the full graph
 */

/**
 * @typedef {object} Entity
 * @property {string} id normalized key of the canonical name
 * @property {string} name canonical name
 * @property {string} type
 * @property {string[]} aliases
 * @property {string} description
 * @property {string[]} sourceChunks chunks that mention it
 * @property {string[]} definedIn chunks that define it
 * @property {boolean} placeholder referenced but not defined anywhere
 */

/**
 * @typedef {object} Edge
 * @property {string} id
 * @property {string} source entity id
 * @property {string} target entity id
 * @property {string} type
 * @property {string} evidence
 * @property {string} chunkId first chunk that supports it
 * @property {string[]} chunkIds all chunks that support it
 * @property {number} weight number of supporting chunks
 */

/** @returns {GraphStore} */
export function createEmptyStore() {
    return { version: GRAPH_VERSION, chunkResults: {}, decisions: { merges: [], rejected: [], pending: [] } };
}

/**
 * Makes sure an object loaded from disk has every field.
 * @param {any} data
 * @returns {GraphStore}
 */
export function normalizeStore(data) {
    const store = createEmptyStore();
    if (data && typeof data === 'object') {
        store.chunkResults = data.chunkResults && typeof data.chunkResults === 'object' ? data.chunkResults : {};
        store.decisions.merges = Array.isArray(data.decisions?.merges) ? data.decisions.merges : [];
        store.decisions.rejected = Array.isArray(data.decisions?.rejected) ? data.decisions.rejected : [];
        store.decisions.pending = Array.isArray(data.decisions?.pending) ? data.decisions.pending : [];
        if (data.graph) store.graph = data.graph;
    }
    return store;
}

class UnionFind {
    constructor() { this.parent = new Map(); }
    find(x) {
        if (!this.parent.has(x)) this.parent.set(x, x);
        let root = x;
        while (this.parent.get(root) !== root) root = this.parent.get(root);
        while (this.parent.get(x) !== root) { const next = this.parent.get(x); this.parent.set(x, root); x = next; }
        return root;
    }
    union(a, b) {
        const ra = this.find(a), rb = this.find(b);
        if (ra !== rb) this.parent.set(rb, ra);
    }
}

function mostCommon(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = null, bestCount = 0;
    for (const [v, c] of counts) {
        if (c > bestCount) { best = v; bestCount = c; } // ties keep the first seen
    }
    return best;
}

/**
 * Chooses the display name for a merged entity. A name that matches the title of a chunk
 * defining it wins ("Rank Plate" from "COS-006 §7 The Rank Plate" beats a more frequent
 * "plate"); otherwise the most frequent name, preferring the more specific (longer) one on ties.
 * @param {{ chunkId: string, entity: { name: string, aliases?: string[] } }[]} pool preferred mentions (defining ones if any)
 * @param {{ chunkId: string, entity: { name: string, aliases?: string[] } }[]} group all mentions
 * @returns {string}
 */
function pickCanonicalName(pool, group) {
    const candidates = new Map();
    for (const m of group) {
        for (const name of [m.entity.name, ...(m.entity.aliases ?? [])]) {
            if (!candidates.has(name)) candidates.set(name, { name, count: 0, titled: false });
        }
    }
    for (const m of pool) candidates.get(m.entity.name).count++;

    // The title part of a chunk id is everything after "§<number> ".
    // Must match a whole title: "A-Rank, Regional Crisis Operative" must not crown "Regional Crisis Operative".
    const titles = new Set(pool.map(m => matchForm(m.chunkId.replace(/^.*?§\S+\s+/, ''))));
    for (const candidate of candidates.values()) {
        const form = matchForm(candidate.name);
        candidate.titled = !!form && form.includes(' ') && titles.has(form);
    }

    return [...candidates.values()].sort((a, b) =>
        Number(b.titled) - Number(a.titled)
        || b.count - a.count
        || b.name.length - a.name.length,
    )[0].name;
}

/**
 * Builds the graph from extraction results.
 * @param {GraphStore} store
 * @param {string[]} chunkIds which chunks to include, in document order (e.g. the active ones)
 * @returns {{ entities: Entity[], edges: Edge[] }}
 */
export function buildGraph(store, chunkIds) {
    const uf = new UnionFind();
    /** @type {{ chunkId: string, entity: import('./schema.js').ExtractedEntity, key: string }[]} */
    const mentions = [];
    /** @type {{ chunkId: string, relation: import('./schema.js').ExtractedRelation }[]} */
    const relations = [];

    for (const chunkId of chunkIds) {
        const result = store.chunkResults[chunkId];
        if (!result || result.status !== 'ok') continue;
        for (const entity of result.entities) {
            const key = normalizeKey(entity.name);
            if (!key) continue;
            uf.find(key);
            for (const alias of entity.aliases) {
                const aliasKey = normalizeKey(alias);
                if (aliasKey) uf.union(key, aliasKey);
            }
            mentions.push({ chunkId, entity, key });
        }
        for (const relation of result.relations) {
            relations.push({ chunkId, relation });
        }
    }

    for (const [a, b] of store.decisions.merges) {
        // Only apply approved merges whose names still exist.
        if (uf.parent.has(a) && uf.parent.has(b)) uf.union(a, b);
    }

    // Group mentions by their merged root.
    /** @type {Map<string, typeof mentions>} */
    const groups = new Map();
    for (const m of mentions) {
        const root = uf.find(m.key);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(m);
    }

    /** @type {Map<string, string>} root -> entity id */
    const rootToId = new Map();
    /** @type {Entity[]} */
    const entities = [];

    for (const [root, group] of groups) {
        const defining = group.filter(m => m.entity.defined_here);
        const pool = defining.length ? defining : group;
        const name = pickCanonicalName(pool, group);
        const typed = (defining.length ? defining : group).filter(m => m.entity.type);
        const type = mostCommon(typed.map(m => m.entity.type)) ?? mostCommon(group.filter(m => m.entity.type).map(m => m.entity.type)) ?? FALLBACK_ENTITY_TYPE;
        const description = pool.find(m => m.entity.description)?.entity.description ?? group.find(m => m.entity.description)?.entity.description ?? '';

        const id = normalizeKey(name);
        const aliasMap = new Map();
        for (const m of group) {
            for (const candidate of [m.entity.name, ...m.entity.aliases]) {
                if (normalizeKey(candidate) !== id && !aliasMap.has(candidate.toLowerCase())) {
                    aliasMap.set(candidate.toLowerCase(), candidate);
                }
            }
        }

        const sourceChunks = [...new Set(group.map(m => m.chunkId))];
        const definedIn = [...new Set(defining.map(m => m.chunkId))];
        rootToId.set(root, id);
        entities.push({
            id,
            name,
            type,
            aliases: [...aliasMap.values()],
            description,
            sourceChunks,
            definedIn,
            placeholder: definedIn.length === 0,
        });
    }

    /** @type {Map<string, Edge>} */
    const edgeMap = new Map();
    for (const { chunkId, relation } of relations) {
        const sourceKey = normalizeKey(relation.source);
        const targetKey = normalizeKey(relation.target);
        if (!uf.parent.has(sourceKey) || !uf.parent.has(targetKey)) continue;
        const source = rootToId.get(uf.find(sourceKey));
        const target = rootToId.get(uf.find(targetKey));
        if (!source || !target || source === target) continue;

        const edgeId = `${source}|${relation.type}|${target}`;
        const existing = edgeMap.get(edgeId);
        if (existing) {
            if (!existing.chunkIds.includes(chunkId)) {
                existing.chunkIds.push(chunkId);
                existing.weight = existing.chunkIds.length;
            }
        } else {
            edgeMap.set(edgeId, { id: edgeId, source, target, type: relation.type, evidence: relation.evidence, chunkId, chunkIds: [chunkId], weight: 1 });
        }
    }

    entities.sort((a, b) => a.name.localeCompare(b.name));
    return { entities, edges: [...edgeMap.values()] };
}

/**
 * Status of each chunk relative to the saved results.
 * @param {GraphStore} store
 * @param {import('./parser.js').LoreChunk[]} chunks
 * @returns {{ done: string[], changed: string[], failed: string[], missing: string[] }} chunk ids
 */
export function getChunkStatus(store, chunks) {
    const status = { done: [], changed: [], failed: [], missing: [] };
    for (const chunk of chunks) {
        const result = store.chunkResults[chunk.id];
        if (!result) status.missing.push(chunk.id);
        else if (result.status === 'failed') status.failed.push(chunk.id);
        else if (result.hash !== chunk.hash) status.changed.push(chunk.id);
        else status.done.push(chunk.id);
    }
    return status;
}

/**
 * Picks the known entities worth showing the model for one chunk: those whose name or
 * alias appears in the chunk, plus those already found elsewhere in the same section.
 * Keeps the prompt small no matter how big the whole graph gets.
 * @param {Entity[]} entities
 * @param {import('./parser.js').LoreChunk} chunk
 * @param {number} [limit]
 * @returns {Entity[]}
 */
export function selectRelevantEntities(entities, chunk, limit = 150) {
    const text = ` ${matchForm([chunk.sectionTitle, chunk.subsectionTitle ?? '', chunk.tldr, chunk.text, chunk.guardrail].join(' '))} `;
    const sectionPrefix = `${chunk.docId} §${chunk.sectionNumber ?? '?'} `;
    const mentioned = [];
    const sameSection = [];
    for (const entity of entities) {
        const names = [entity.name, ...entity.aliases].map(matchForm).filter(Boolean);
        if (names.some(name => text.includes(` ${name} `))) {
            mentioned.push(entity);
        } else if (entity.sourceChunks.some(id => id !== chunk.id && id.startsWith(sectionPrefix))) {
            sameSection.push(entity);
        }
    }
    return [...mentioned, ...sameSection].slice(0, limit);
}

/**
 * The entity list given to the model so it reuses existing names.
 * @param {Entity[]} entities
 * @returns {string}
 */
export function formatEntityList(entities) {
    if (!entities.length) {
        return '(none yet)';
    }
    return entities
        .map(e => `- ${e.name} [${e.type}]${e.aliases.length ? ` (also: ${e.aliases.join(', ')})` : ''}`)
        .join('\n');
}
