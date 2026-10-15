// Picks the lore chunks relevant to the current scene. Pure JavaScript with no
// SillyTavern imports, so it can be tested in Node. No LLM calls happen here.
// Steps follow CLAUDE.md "Retrieval": match names → seed → expand through edges →
// score chunks → fill the token budget → build the injected block, recording why.

import { formatChunk } from './parser.js';
import { matchForm } from './schema.js';

export const DEFAULT_RETRIEVAL_SETTINGS = {
    messages: 4,          // earlier messages scanned, in addition to the newest one
    hops: 2,              // relationship steps followed from matched entities
    budget: 1500,         // max tokens for the injected lore
    recencyDecay: 0.8,    // each older message counts this much less
    hopFactor: 0.5,       // score multiplier per relationship step
    directBonus: 1.25,    // chunks that mention a matched entity directly
    wordBonus: 1.0,       // up to this much extra for chunks sharing distinctive words with the messages
    minRelativeScore: 0.08, // drop chunks scoring under this share of the best chunk
    minAliasLength: 4,    // shorter names are ignored unless marked safe
};

/** How strongly each relationship type carries relevance from one entity to the next. */
export const EDGE_TYPE_WEIGHTS = {
    contrasts_with: 1.0,
    exception_to: 1.0,
    requires: 0.9,
    limited_by: 0.9,
    causes: 0.9,
    reclassifies_to: 0.9,
    part_of: 0.8,
    located_in: 0.8,
    has_authority_over: 0.8,
    produces: 0.8,
    classified_as: 0.8,
    related_to: 0.5,
};

/** How much a chunk that only mentions an entity counts, compared with one that defines it. */
const MENTION_WEIGHT = 0.4;

export const MATCH_MODES = {
    always: 'Always',
    context: 'Needs context',
    never: 'Never',
};

/**
 * @typedef {object} MatchingSettings what's saved in lore-graph_matching.json
 * @property {Record<string, 'always'|'context'|'never'>} modes keyed by an entity's name/alias match form
 * @property {string[]} safeAliases match forms of short names the user marked safe to match
 * @property {string[]} checkedNames match forms already reviewed by the everyday-word check
 */

/** @returns {MatchingSettings} */
export function createEmptyMatching() {
    return { modes: {}, safeAliases: [], checkedNames: [] };
}

/**
 * Matching modes are set per name: "the heart" can be an everyday phrase while
 * "deep core", a name of the same entity, still always counts.
 * @param {string} name
 * @param {MatchingSettings} matching
 * @returns {'always'|'context'|'never'}
 */
export function getNameMode(name, matching) {
    return matching.modes[matchForm(name)] ?? 'always';
}

/**
 * Each of an entity's names with its mode.
 * @param {import('./graph.js').Entity} entity
 * @param {MatchingSettings} matching
 * @returns {{ name: string, mode: 'always'|'context'|'never' }[]}
 */
export function getNameModes(entity, matching) {
    const seen = new Set();
    return [entity.name, ...entity.aliases]
        .filter(name => { const form = matchForm(name); if (!form || seen.has(form)) return false; seen.add(form); return true; })
        .map(name => ({ name, mode: getNameMode(name, matching) }));
}

/**
 * A one-word summary for an entity: its names' mode if they all agree, otherwise "mixed".
 * @param {import('./graph.js').Entity} entity
 * @param {MatchingSettings} matching
 * @returns {'always'|'context'|'never'|'mixed'}
 */
export function getMatchMode(entity, matching) {
    const modes = new Set(getNameModes(entity, matching).map(x => x.mode));
    return modes.size === 1 ? [...modes][0] : 'mixed';
}

const MODE_STRENGTH = { always: 2, context: 1, never: 0 };

/**
 * Prepares lookup structures for retrieval. Build once per graph/matching change.
 * @param {{ entities: import('./graph.js').Entity[], edges: import('./graph.js').Edge[] }} graph
 * @param {import('./parser.js').LoreChunk[]} chunks active chunks
 * @param {MatchingSettings} matching
 * @param {{ minAliasLength?: number }} [options]
 */
export function buildRetrievalIndex(graph, chunks, matching, { minAliasLength = DEFAULT_RETRIEVAL_SETTINGS.minAliasLength } = {}) {
    const chunkIds = new Set(chunks.map(c => c.id));
    const entities = graph.entities.filter(e => e.sourceChunks.some(id => chunkIds.has(id)));
    const byId = new Map(entities.map(e => [e.id, e]));
    const safe = new Set(matching.safeAliases);

    /** @type {Map<string, { edge: import('./graph.js').Edge, other: string }[]>} */
    const adjacency = new Map();
    for (const edge of graph.edges) {
        if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
        if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
        if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
        adjacency.get(edge.source).push({ edge, other: edge.target });
        adjacency.get(edge.target).push({ edge, other: edge.source });
    }

    /** @type {{ form: string, name: string, entityId: string, mode: 'always'|'context'|'never' }[]} */
    const names = [];
    /** @type {{ name: string, entityId: string }[]} */
    const tooShort = [];
    for (const entity of entities) {
        const seen = new Set();
        for (const name of [entity.name, ...entity.aliases]) {
            const form = matchForm(name);
            if (!form || seen.has(form)) continue;
            seen.add(form);
            if (form.replace(/\s/g, '').length < minAliasLength && !safe.has(form)) {
                tooShort.push({ name, entityId: entity.id });
                continue;
            }
            names.push({ form, name, entityId: entity.id, mode: matching.modes[form] ?? 'always' });
        }
    }

    // How rare each word is across the active chunks, for the shared-words boost.
    const chunkWords = new Map(chunks.map(c => [c.id, contentWords([c.sectionTitle, c.subsectionTitle ?? '', c.text, c.guardrail].join(' '))]));
    const documentFrequency = new Map();
    for (const words of chunkWords.values()) {
        for (const word of words) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
    const idf = (word) => Math.log((chunks.length + 1) / ((documentFrequency.get(word) ?? 0) + 1));

    // Hub entities appear in many chunks ("Guild", "manacite"); they spread less relevance.
    const hub = new Map(entities.map(e => [e.id, 1 / Math.max(1, Math.log2(e.sourceChunks.filter(id => chunkIds.has(id)).length))]));

    return { entities, byId, adjacency, names, tooShort, hub, chunkWords, idf, chunkById: new Map(chunks.map(c => [c.id, c])) };
}

// Common words that carry no topic. Short words (under 4 letters) are skipped anyway.
const STOPWORDS = new Set(('that this with from have they them their there then than what when where which while were will would '
    + 'could should about into over just like your yours mine ours been being some more most much many very only also even '
    + 'back down after before again still here each other such does done doing make made take took want going come came '
    + 'know knew think thought look looked said says tell told give gave around through really maybe because think '
    + 'yeah okay sure well right good great nice something nothing anything everything someone everyone').split(' '));

/**
 * The distinct topic words of a text (lowercased, singular, no stopwords, at least 4 letters).
 * @param {string} text
 * @returns {Set<string>}
 */
function contentWords(text) {
    return new Set(matchForm(text).split(' ').filter(w => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)));
}

/**
 * @typedef {object} RetrievalReport everything needed to explain an injection
 * @property {{ entityId: string, name: string, via: string, message: number, score: number, mode: string }[]} seeds
 * @property {{ entityId: string, name: string, via: string, reason: string }[]} ignored
 * @property {{ entityId: string, name: string, score: number, path: string[] }[]} reached entities found through relationships
 * @property {{ id: string, score: number, direct: boolean, reasons: { entityId: string, name: string, amount: number, defined: boolean }[], status: 'full'|'tldr'|'cut'|'below threshold', tokens: number }[]} chunks
 * @property {string} text the lore block (without the template)
 * @property {number} tokens
 */

/**
 * Finds relevant chunks for the given messages.
 * @param {ReturnType<typeof buildRetrievalIndex>} index
 * @param {string[]} messages oldest first; the last one is the newest
 * @param {object} settings DEFAULT_RETRIEVAL_SETTINGS overrides
 * @param {(text: string) => number|Promise<number>} countTokens
 * @returns {Promise<RetrievalReport>}
 */
export async function retrieve(index, messages, settings, countTokens) {
    const s = { ...DEFAULT_RETRIEVAL_SETTINGS, ...settings };
    const scanned = messages.slice(-(s.messages + 1));

    // ---- 1-3. Match names in the scanned messages; newer messages weigh more ----
    // Per entity, keep its strongest matching name (Always over Needs context over Never), then the newest.
    /** @type {Map<string, { entityId: string, via: string, message: number, weight: number, mode: string }>} */
    const hits = new Map();
    scanned.forEach((text, i) => {
        const age = scanned.length - 1 - i; // 0 = newest
        const weight = Math.pow(s.recencyDecay, age);
        const haystack = ` ${matchForm(text)} `;
        for (const { form, name, entityId, mode } of index.names) {
            if (!haystack.includes(` ${form} `)) continue;
            const previous = hits.get(entityId);
            const better = !previous
                || MODE_STRENGTH[mode] > MODE_STRENGTH[previous.mode]
                || (MODE_STRENGTH[mode] === MODE_STRENGTH[previous.mode] && weight > previous.weight);
            if (better) {
                hits.set(entityId, { entityId, via: name, message: age, weight, mode });
            }
        }
    });

    const seeds = [];
    const ignored = [];
    const strongIds = [...hits.values()].filter(hit => hit.mode === 'always').map(hit => hit.entityId);
    for (const hit of hits.values()) {
        const entity = index.byId.get(hit.entityId);
        const mode = hit.mode;
        if (mode === 'never') {
            ignored.push({ entityId: hit.entityId, name: entity.name, via: hit.via, reason: 'set to Never match' });
            continue;
        }
        if (mode === 'context' && !strongIds.length) {
            // Everyday words ("plate", "smell") only count alongside a clearly lore-specific term.
            // Two everyday words can't vouch for each other: they often appear together in ordinary talk.
            ignored.push({ entityId: hit.entityId, name: entity.name, via: hit.via, reason: 'everyday word with no lore-specific term nearby' });
            continue;
        }
        seeds.push({ entityId: hit.entityId, name: entity.name, via: hit.via, message: hit.message, score: hit.weight, mode });
    }

    /** @type {Map<string, { score: number, path: string[] }>} */
    const scores = new Map(seeds.map(seed => [seed.entityId, { score: seed.score, path: [seed.entityId] }]));

    // ---- 4. Expand through relationships ----
    let frontier = new Map(scores);
    for (let hop = 1; hop <= s.hops && frontier.size; hop++) {
        const next = new Map();
        for (const [id, { score, path }] of frontier) {
            for (const { edge, other } of index.adjacency.get(id) ?? []) {
                if (path.includes(other)) continue;
                const strength = Math.min(1.5, 1 + 0.25 * (edge.weight - 1)); // relations found in several chunks count a bit more
                const value = score * s.hopFactor * (EDGE_TYPE_WEIGHTS[edge.type] ?? 0.5) * strength * index.hub.get(id);
                if (value > (next.get(other)?.score ?? 0)) {
                    next.set(other, { score: value, path: [...path, `${edge.type}:${edge.source === id ? '→' : '←'}`, other] });
                }
            }
        }
        frontier = new Map();
        for (const [id, value] of next) {
            if (value.score > (scores.get(id)?.score ?? 0)) {
                scores.set(id, value);
                frontier.set(id, value);
            }
        }
    }

    // ---- 5. Score chunks by the entities they mention ----
    const seedIds = new Set(seeds.map(seed => seed.entityId));
    /** @type {Map<string, { score: number, direct: boolean, reasons: any[] }>} */
    const chunkScores = new Map();
    for (const [id, { score }] of scores) {
        const entity = index.byId.get(id);
        for (const chunkId of entity.sourceChunks) {
            if (!index.chunkById.has(chunkId)) continue;
            const defined = entity.definedIn.includes(chunkId);
            const amount = score * (defined ? 1 : MENTION_WEIGHT) * index.hub.get(id);
            const entry = chunkScores.get(chunkId) ?? { score: 0, direct: false, reasons: [] };
            entry.score += amount;
            entry.direct ||= seedIds.has(id);
            entry.reasons.push({ entityId: id, name: entity.name, amount, defined });
            chunkScores.set(chunkId, entry);
        }
    }
    // Shared distinctive words: reorders chunks the graph already found (never adds new ones),
    // e.g. "abandoned manor" lifts Aberrant Labyrinths above other chunks that mention dragons.
    /** @type {Map<string, number>} word -> weight (newer messages weigh more) */
    const messageWords = new Map();
    scanned.forEach((text, i) => {
        const weight = Math.pow(s.recencyDecay, scanned.length - 1 - i);
        for (const word of contentWords(text)) messageWords.set(word, Math.max(weight, messageWords.get(word) ?? 0));
    });
    const totalWordWeight = [...messageWords].reduce((sum, [word, weight]) => sum + weight * index.idf(word), 0);

    for (const [chunkId, entry] of chunkScores) {
        if (entry.direct) entry.score *= s.directBonus;
        const words = index.chunkWords.get(chunkId);
        const shared = [...messageWords].filter(([word]) => words.has(word));
        entry.sharedWords = shared.map(([word]) => word);
        if (shared.length && totalWordWeight > 0) {
            const overlap = shared.reduce((sum, [word, weight]) => sum + weight * index.idf(word), 0) / totalWordWeight;
            entry.score *= 1 + s.wordBonus * Math.min(1, overlap);
        }
        entry.reasons.sort((a, b) => b.amount - a.amount);
    }

    // ---- 6. Fill the token budget ----
    const ranked = [...chunkScores].sort((a, b) => b[1].score - a[1].score);
    const best = ranked[0]?.[1].score ?? 0;
    const sectionsWithTldr = new Set();
    const parts = [];
    let used = 0;
    const chunks = [];

    for (const [id, entry] of ranked) {
        const chunk = index.chunkById.get(id);
        const row = { id, score: entry.score, direct: entry.direct, reasons: entry.reasons, sharedWords: entry.sharedWords ?? [], status: 'cut', tokens: 0 };
        chunks.push(row);
        if (entry.score < best * s.minRelativeScore) {
            row.status = 'below threshold';
            continue;
        }
        // The section TL;DR is written once per section in the block.
        const sectionKey = `${chunk.docId}|${chunk.sectionNumber}`;
        const withoutRepeat = sectionsWithTldr.has(sectionKey) ? { ...chunk, tldr: '' } : chunk;

        const full = formatChunk(withoutRepeat);
        const fullTokens = await countTokens(full);
        if (used + fullTokens <= s.budget) {
            parts.push(full);
            used += fullTokens;
            row.status = 'full';
            row.tokens = fullTokens;
            sectionsWithTldr.add(sectionKey);
            continue;
        }
        // Tight budget: the TL;DR and guardrail only (the guardrail is never dropped).
        const short = formatChunk(chunk, { tldrOnly: true });
        const shortTokens = await countTokens(short);
        if (used + shortTokens <= s.budget) {
            parts.push(short);
            used += shortTokens;
            row.status = 'tldr';
            row.tokens = shortTokens;
            sectionsWithTldr.add(sectionKey);
        }
    }

    const reached = [...scores]
        .filter(([id]) => !seedIds.has(id))
        .map(([id, { score, path }]) => ({
            entityId: id,
            name: index.byId.get(id).name,
            score,
            path: path.map(step => index.byId.get(step)?.name ?? step),
        }))
        .sort((a, b) => b.score - a.score);

    return { seeds, ignored, reached, chunks, text: parts.join('\n\n'), tokens: used };
}
