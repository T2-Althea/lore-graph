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
    meaningSeedScore: 0.6, // start score of the best meaning-search hit (name matches start at 1.0)
    weakMeaningFactor: 0.5, // chunk meaning hits that pass the threshold but not the stricter "strong" check
    entityMeaningFactor: 0.5, // entity meaning hits (short descriptions match more loosely than chunks)
    definitionPull: 0.35,  // share of a top chunk's score given to sections defining specific terms it uses
    definitionPullTop: 2,  // how many top chunks pull in definitions
    definitionPullMinHub: 0.5, // skip terms found in more than 4 chunks (hub factor below 0.5)
    minRelativeScore: 0.08, // drop chunks scoring under this share of the best chunk
    aloneMax: 2,          // with no lore name in the scene, meaning search sends at most this many sections
    triggerScore: 1.0,    // a section's own trigger phrase counts like a direct name match
    inPlayFactor: 0.8,    // start score of an everyday name allowed because its topic is in play
    stickyScore: 0.3,     // score for a section sent with the previous reply (halves each reply further back)
    // recent: { topics: Map<entity name (lowercase), messages ago>, sticky: { id, repliesAgo }[] }
    //   what fired and what was sent for recent replies; only set for real replies, not tests
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
    capital: 'Capital letter only',
    capital_strict: 'Capital letter, strict',
    context: 'Needs context',
    never: 'Never',
};

/**
 * @typedef {object} MatchingSettings what's saved in lore-graph_matching.json
 * @property {Record<string, 'always'|'capital'|'capital_strict'|'context'|'never'>} modes keyed by an entity's name/alias match form
 * @property {string[]} safeAliases match forms of short names the user marked safe to match
 * @property {string[]} checkedNames match forms already reviewed by the everyday-word check
 * @property {string[]} pinnedChunks chunk ids always sent (within the budget, before anything else)
 * @property {string[]} blockedChunks chunk ids never sent
 * @property {string[]} namedOnlyChunks chunk ids never sent by meaning search (only through names)
 * @property {Record<string, string[]>} chunkTriggers chunk id -> trigger phrases ("sea monster", "ocean + creature")
 * @property {Record<string, string[]>} [chunkStopPhrases] chunk id -> stop phrases: held back when the chat says one,
 *   unless the chat names something the section is about
 */

/** @returns {MatchingSettings} */
export function createEmptyMatching() {
    return { modes: {}, safeAliases: [], checkedNames: [], pinnedChunks: [], blockedChunks: [], namedOnlyChunks: [], chunkTriggers: {}, chunkStopPhrases: {} };
}

// ---- Ordinary English words (lib/common-words.txt) ----
// A one-word name that is an ordinary English word ("Calling", "Tree", "the Sea") needs a lore
// term nearby unless the user chose otherwise; invented words ("Venari") and names of several
// words ("World Tree") count on their own. A mode the user set always wins.

/** @type {Set<string>|null} match forms of ordinary words, or null when the rule is off */
let ordinaryWords = null;
/** Increases whenever the rule changes, so cached retrieval indexes are rebuilt. */
export let ordinaryRevision = 0;

/**
 * Turns the ordinary-word rule on (with the word list) or off (null).
 * @param {Iterable<string>|null} words
 */
export function setOrdinaryWords(words) {
    ordinaryWords = words ? new Set([...words].map(w => matchForm(w)).filter(Boolean)) : null;
    ordinaryRevision++;
}

/** Whether the rule makes this name need context (one word, found in the word list). */
export function isOrdinaryWordName(name) {
    if (!ordinaryWords) return false;
    const form = matchForm(name);
    return !!form && !form.includes(' ') && ordinaryWords.has(form);
}

/**
 * Matching modes are set per name: "the heart" can be an everyday phrase while
 * "deep core", a name of the same entity, still always counts. Names with no mode set
 * follow the ordinary-word rule.
 * @param {string} name
 * @param {MatchingSettings} matching
 * @returns {'always'|'capital'|'capital_strict'|'context'|'never'}
 */
export function getNameMode(name, matching) {
    return matching.modes[matchForm(name)] ?? (isOrdinaryWordName(name) ? 'context' : 'always');
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

const MODE_STRENGTH = { always: 2, capital: 2, capital_strict: 2, context: 1, never: 0 };

// ---- "Capital letter only": "the Abyss" is the lore place, "the abyss" is just a deep hole ----
// "Capital letter, strict" also treats a capital at a sentence start ("Abyss take you!") as an
// ordinary word: it needs a lore term nearby, and meaning search doesn't see it either.

/** Whether a name mode is one of the two capital-letter modes. */
export const isCapitalMode = (mode) => mode === 'capital' || mode === 'capital_strict';

/** Words before a match that make a capital letter meaningless: the start of a sentence, a line or a quote. */
function atSentenceStart(text, index) {
    const before = text.slice(0, index);
    const trimmed = before.replace(/[\s"'“‘«*_~([]+$/u, '');
    return !trimmed || /[.!?…:;]$/.test(trimmed) || before.slice(trimmed.length).includes('\n');
}

/**
 * Every place a name appears in a text, with how it is written.
 * The name's leading article is ignored ("the Abyss" is looked for as "Abyss").
 * @param {string} text
 * @param {string} name
 * @returns {{ capitalised: boolean, sentenceStart: boolean }[]}
 */
export function nameUses(text, name) {
    const re = nameRegex(name);
    if (!re) return [];
    const uses = [];
    for (const m of String(text).matchAll(re)) {
        const first = m[0][0];
        uses.push({ capitalised: first !== first.toLowerCase(), sentenceStart: atSentenceStart(text, m.index) });
    }
    return uses;
}

/** A whole-word, case-insensitive pattern for a name (leading article ignored, simple plurals allowed). */
function nameRegex(name) {
    const words = String(name).trim().replace(/^(the|a|an)\s+/i, '').split(/[\s-]+/).filter(Boolean);
    if (!words.length) return null;
    const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = words.map(escape).join('[\\s-]+') + "(?:'?s|es)?";
    return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * Removes lowercase uses of "Capital letter only" names from a text, so meaning search isn't
 * steered by them either ("stared into the abyss" shouldn't find the Abyss by meaning).
 * Capitalised uses stay, including at a sentence start (except in the strict mode).
 * @param {{ names: { name: string, mode: string }[] }} index
 * @param {string} text
 */
export function hideLowercaseCapitalNames(index, text) {
    let out = String(text);
    for (const { name, mode } of index.names) {
        if (!isCapitalMode(mode)) continue;
        const re = nameRegex(name);
        if (!re) continue;
        out = out.replace(re, (match, offset, whole) => {
            const capitalised = match[0] !== match[0].toLowerCase();
            const keep = capitalised && (mode === 'capital' || !atSentenceStart(whole, offset));
            return keep ? match : '';
        });
    }
    return out;
}

/** True when the text writes the name with a capital letter somewhere other than a sentence start. */
export function hasCapitalisedUse(text, name) {
    return nameUses(text, name).some(u => u.capitalised && !u.sentenceStart);
}

/**
 * How the lore itself writes a name (sentence starts don't count either way).
 * @param {string[]} texts lore texts
 * @param {string} name
 * @returns {{ capitalised: number, lowercase: number }}
 */
export function countNameCasing(texts, name) {
    let capitalised = 0;
    let lowercase = 0;
    for (const text of texts) {
        for (const use of nameUses(text, name)) {
            if (use.sentenceStart) continue;
            if (use.capitalised) capitalised++;
            else lowercase++;
        }
    }
    return { capitalised, lowercase };
}

/** The lore treats a name as a proper name: written with a capital letter (almost) every time. */
export function looksCapitalisedInLore({ capitalised, lowercase }) {
    return capitalised >= 2 && lowercase <= capitalised * 0.15;
}

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
            // Short names are skipped unless marked safe; requiring a capital letter makes them specific enough.
            if (form.replace(/\s/g, '').length < minAliasLength && !safe.has(form) && !isCapitalMode(matching.modes[form])) {
                tooShort.push({ name, entityId: entity.id });
                // Still matchable while its own topic is in play ("the Sea" after Primordial Sea fired).
                if (getNameMode(name, matching) !== 'never') names.push({ form: articledForm(name, form), name, entityId: entity.id, mode: 'context', shortOnly: true });
                continue;
            }
            // "the made", "the cold": a one-word name keeps its article when matching, so it
            // doesn't fire on every "made" or "cold". Modes stay keyed by the plain form.
            names.push({ form: articledForm(name, form), name, entityId: entity.id, mode: getNameMode(name, matching) });
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

    /** @type {Map<string, import('./graph.js').Entity[]>} chunk id -> entities it mentions or defines */
    const entitiesByChunk = new Map();
    for (const entity of entities) {
        for (const chunkId of entity.sourceChunks) {
            if (!entitiesByChunk.has(chunkId)) entitiesByChunk.set(chunkId, []);
            entitiesByChunk.get(chunkId).push(entity);
        }
    }

    // Sections the user pinned (always sent, in document order) or blocked (never sent).
    const pinnedSet = new Set(matching.pinnedChunks ?? []);
    const pinned = chunks.filter(c => pinnedSet.has(c.id)).map(c => c.id);
    const blocked = new Set((matching.blockedChunks ?? []).filter(id => chunkIds.has(id) && !pinnedSet.has(id)));
    // Sections only sent through names or trigger phrases, never by meaning search.
    const namedOnly = new Set((matching.namedOnlyChunks ?? []).filter(id => chunkIds.has(id)));
    // Trigger phrases the user set on sections; "ocean + creature" needs both in one message.
    const triggers = [];
    for (const [chunkId, phrases] of Object.entries(matching.chunkTriggers ?? {})) {
        if (!chunkIds.has(chunkId) || blocked.has(chunkId)) continue;
        for (const phrase of phrases) {
            const parts = String(phrase).split('+').map(p => matchFormKeepingArticle(p.trim())).filter(Boolean);
            if (parts.length) triggers.push({ chunkId, phrase, parts });
        }
    }
    // Stop phrases: the opposite of triggers ("elf" on a Venari section).
    const stops = [];
    for (const [chunkId, phrases] of Object.entries(matching.chunkStopPhrases ?? {})) {
        if (!chunkIds.has(chunkId)) continue;
        for (const phrase of phrases) {
            const parts = String(phrase).split('+').map(p => matchFormKeepingArticle(p.trim())).filter(Boolean);
            if (parts.length) stops.push({ chunkId, phrase, parts });
        }
    }

    return { entities, byId, adjacency, names, tooShort, hub, chunkWords, entitiesByChunk, idf, pinned, blocked, namedOnly, triggers, stops, chunkById: new Map(chunks.map(c => [c.id, c])) };
}

/** matchForm, but a leading "the"/"a"/"an" is kept (matchForm drops it). */
function matchFormKeepingArticle(text) {
    return matchForm(`zzq ${text}`).replace(/^zzq ?/, '');
}

/** The form to match a name by: one-word names keep their article ("the made" stays "the made"). */
function articledForm(name, form) {
    if (form.includes(' ')) return form;
    const withArticle = matchFormKeepingArticle(name);
    return /^(the|a|an) /.test(withArticle) ? withArticle : form;
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
 * Whether two entities belong together closely enough for one to vouch for the other: the same
 * thing, from the same document, linked directly, or linked through one small (non-hub) term.
 * Links through big hubs don't count: almost everything is a few steps from "Valcarra".
 * @param {ReturnType<typeof buildRetrievalIndex>} index
 * @param {string} a
 * @param {string} b
 */
export function isRelatedEntity(index, a, b) {
    if (a === b) return true;
    const docsOf = (id) => new Set((index.byId.get(id)?.sourceChunks ?? []).map(c => index.chunkById.get(c)?.docId).filter(Boolean));
    const docsA = docsOf(a);
    for (const doc of docsOf(b)) if (docsA.has(doc)) return true;
    for (const { other } of index.adjacency.get(a) ?? []) {
        if (other === b) return true;
        if ((index.hub.get(other) ?? 0) < 0.5) continue; // a hub (found in more than 4 sections)
        for (const { other: far } of index.adjacency.get(other) ?? []) if (far === b) return true;
    }
    return false;
}

/**
 * @typedef {object} RetrievalReport everything needed to explain an injection
 * @property {{ entityId: string, name: string, via: string, message: number, score: number, mode: string }[]} seeds
 * @property {{ entityId: string, name: string, via: string, reason: string }[]} ignored
 * @property {{ entityId: string, name: string, score: number, path: string[] }[]} reached entities found through relationships
 * @property {{ id: string, score: number, direct: boolean, reasons: { entityId: string, name: string, amount: number, defined: boolean }[], status: 'full'|'tldr'|'cut'|'below threshold'|'blocked'|'stopped', tokens: number }[]} chunks
 * @property {string} text the lore block (without the template)
 * @property {number} tokens
 */

/**
 * Finds relevant chunks for the given messages.
 * @param {ReturnType<typeof buildRetrievalIndex>} index
 * @param {string[]} messages oldest first; the last one is the newest
 * @param {object} settings DEFAULT_RETRIEVAL_SETTINGS overrides
 * @param {(text: string) => number|Promise<number>} countTokens
 * @param {{ chunks: { id: string, rank: number }[], entities: { id: string, rank: number }[] }|null} [meaning]
 *   meaning-search hits (best first), or null when meaning search is off or failed
 * @returns {Promise<RetrievalReport>}
 */
export async function retrieve(index, messages, settings, countTokens, meaning = null) {
    const s = { ...DEFAULT_RETRIEVAL_SETTINGS, ...settings };
    const scanned = messages.slice(-(s.messages + 1));

    // ---- 1-3. Match names in the scanned messages; newer messages weigh more ----
    // Per entity, keep its strongest matching name (Always over Needs context over Never), then the newest.
    /** @type {Map<string, { entityId: string, via: string, message: number, weight: number, mode: string }>} */
    const hits = new Map();
    scanned.forEach((text, i) => {
        const age = scanned.length - 1 - i; // 0 = newest
        const weight = Math.pow(s.recencyDecay, age);
        const haystack = ` ${matchFormKeepingArticle(text)} `;
        for (const { form, name, entityId, mode: nameMode, shortOnly } of index.names) {
            if (!haystack.includes(` ${form} `)) continue;
            if (shortOnly && !s.recent?.topics?.has(index.byId.get(entityId)?.name.toLowerCase())) continue;
            // Capital letter only: with a capital it counts like Always, in lowercase like Needs context.
            const capitalised = isCapitalMode(nameMode) ? hasCapitalisedUse(text, name) : null;
            const mode = isCapitalMode(nameMode) ? (capitalised ? 'always' : 'context') : nameMode;
            const previous = hits.get(entityId);
            const better = !previous
                || MODE_STRENGTH[mode] > MODE_STRENGTH[previous.mode]
                || (MODE_STRENGTH[mode] === MODE_STRENGTH[previous.mode] && weight > previous.weight);
            if (better) {
                hits.set(entityId, { entityId, via: name, message: age, weight, mode, capitalised });
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
        if (mode === 'context' && !strongIds.some(id => isRelatedEntity(index, id, hit.entityId))) {
            // Topic in play: "the sea" counts if Primordial Sea itself fired for a recent reply.
            const inPlay = s.recent?.topics?.get(entity.name.toLowerCase());
            if (inPlay !== undefined) {
                seeds.push({ entityId: hit.entityId, name: entity.name, via: hit.via, message: hit.message, score: hit.weight * s.inPlayFactor, mode, capitalised: hit.capitalised, inPlay });
                continue;
            }
            // Everyday words ("plate", "smell") only count alongside a clearly lore-specific term
            // that belongs with them ("customs" next to an unrelated forest is just customs).
            // Two everyday words can't vouch for each other: they often appear together in ordinary talk.
            const reason = hit.capitalised === false
                ? 'written without a capital letter (set to Capital letter only), and no related lore-specific term nearby'
                : 'everyday word with no related lore-specific term nearby';
            ignored.push({ entityId: hit.entityId, name: entity.name, via: hit.via, reason, capitalised: hit.capitalised });
            continue;
        }
        seeds.push({ entityId: hit.entityId, name: entity.name, via: hit.via, message: hit.message, score: hit.weight, mode, capitalised: hit.capitalised });
    }

    // ---- 3a. Trigger phrases the user set on sections (newer messages weigh more) ----
    /** @type {Map<string, { phrase: string, weight: number, message: number }>} */
    const triggerHits = new Map();
    /** @type {Map<string, { phrase: string, weight: number, message: number }>} chunk id -> stop phrase found */
    const stopHits = new Map();
    scanned.forEach((text, i) => {
        const age = scanned.length - 1 - i;
        const weight = Math.pow(s.recencyDecay, age);
        const haystack = ` ${matchFormKeepingArticle(text)} `;
        for (const [list, found] of [[index.triggers, triggerHits], [index.stops, stopHits]]) {
            for (const { chunkId, phrase, parts } of list ?? []) {
                if (!parts.every(part => haystack.includes(` ${part} `))) continue;
                if (weight > (found.get(chunkId)?.weight ?? 0)) found.set(chunkId, { phrase, weight, message: age });
            }
        }
    });

    /** @type {Map<string, { score: number, path: string[] }>} */
    const scores = new Map(seeds.map(seed => [seed.entityId, { score: seed.score, path: [seed.entityId] }]));

    // ---- 3b. Meaning seeds (embeddings): weaker than name matches, never vouch for everyday words ----
    let meaningSkipped = null;
    const meaningSeeds = [];
    /** @type {Map<string, number>} chunk id -> direct score from a meaning hit */
    const meaningChunks = new Map();
    /** @type {Map<string, string>} entity id -> the meaning-matched chunk it was seeded from */
    const meaningOrigin = new Map();
    const addMeaningSeed = (entityId, score, via, fromChunk = null) => {
        const entity = index.byId.get(entityId);
        if (!entity || score <= (scores.get(entityId)?.score ?? 0)) return;
        scores.set(entityId, { score, path: [entityId] });
        meaningSeeds.push({ entityId, name: entity.name, via, score });
        if (fromChunk) meaningOrigin.set(entityId, fromChunk);
        else meaningOrigin.delete(entityId);
    };
    // 1st 1.0, 2nd 0.85, 3rd 0.7…; hits that only just cleared the threshold count half.
    const hitFactor = (rank, weak) => Math.max(0.5, 1 - 0.15 * rank) * (weak ? s.weakMeaningFactor : 1);
    // With no lore name in the scene, meaning search alone is easily fooled: ordinary talk about
    // things the lore also covers ("The sea was calm", "an old oak tree") comes as close in meaning
    // as real lore questions. So it may only send its few closest sections (above a stricter bar),
    // as they are, without spreading through the graph. Everyday names that didn't count don't
    // change this: with hundreds of them, almost any sentence contains one.
    // Sections set to "Only when named" never come from meaning search.
    if (meaning && index.namedOnly?.size) {
        meaning = { ...meaning, chunks: (meaning.chunks ?? []).filter(c => !index.namedOnly.has(c.id)) };
    }
    let meaningAlone = null;
    if (meaning && !seeds.length && !triggerHits.size) {
        const close = (meaning.chunks ?? []).filter(c => c.alone && index.chunkById.has(c.id)).slice(0, s.aloneMax);
        if (close.length) {
            meaningAlone = `No lore names in the scene, so meaning search sent only its ${close.length} closest section(s) and didn't follow links from them.`;
            meaning = { chunks: close, entities: [] };
        } else {
            if ((meaning.chunks?.length ?? 0) || (meaning.entities?.length ?? 0)) {
                meaningSkipped = 'No lore names in the scene, and nothing was close enough in meaning to send on its own.';
            }
            meaning = null;
        }
    }
    // Entity descriptions are one short sentence, so their matches are looser than chunk matches;
    // they only count alongside a lore name.
    for (const { id, rank } of meaningAlone ? [] : (meaning?.entities ?? [])) {
        addMeaningSeed(id, s.meaningSeedScore * hitFactor(rank, false) * s.entityMeaningFactor, `entity match #${rank + 1}`);
    }
    for (const { id, rank, weak } of meaning?.chunks ?? []) {
        const chunk = index.chunkById.get(id);
        if (!chunk) continue;
        const score = s.meaningSeedScore * hitFactor(rank, meaningAlone ? false : weak);
        meaningChunks.set(id, score);
        if (meaningAlone) continue;
        // The entities a matched chunk defines carry its meaning into the graph, more weakly.
        for (const entity of index.entities) {
            if (entity.definedIn.includes(id)) addMeaningSeed(entity.id, score * 0.5, `defined in ${id} (chunk match #${rank + 1}${weak ? ', weak' : ''})`, id);
        }
    }

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
    for (const [chunkId, score] of meaningChunks) {
        chunkScores.set(chunkId, { score, direct: true, meaning: true, reasons: [{ entityId: '', name: 'meaning match', amount: score, defined: true }] });
    }
    for (const [chunkId, { phrase, weight }] of triggerHits) {
        const entry = chunkScores.get(chunkId) ?? { score: 0, direct: true, reasons: [] };
        const amount = weight * s.triggerScore;
        entry.score += amount;
        entry.direct = true;
        entry.named = true;
        entry.reasons.unshift({ entityId: '', name: `trigger phrase "${phrase}"`, amount, defined: true });
        chunkScores.set(chunkId, entry);
    }
    for (const [id, { score, path }] of scores) {
        const entity = index.byId.get(id);
        // Terms seeded from a meaning-matched section carry its meaning outward; they don't add
        // to that same section again (one that defines many terms would outrank real name matches).
        const origin = path.length === 1 ? meaningOrigin.get(id) : undefined;
        for (const chunkId of entity.sourceChunks) {
            if (!index.chunkById.has(chunkId) || chunkId === origin) continue;
            const defined = entity.definedIn.includes(chunkId);
            const amount = score * (defined ? 1 : MENTION_WEIGHT) * index.hub.get(id);
            const entry = chunkScores.get(chunkId) ?? { score: 0, direct: false, reasons: [] };
            entry.score += amount;
            entry.direct ||= seedIds.has(id);
            entry.named ||= seedIds.has(id); // the chat itself names something in it (not meaning)
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

    // ---- 5a. Sticky lore: sections sent with the last replies stay a little longer ----
    // Small scores, so they only make it in when the current scene names little or nothing else
    // (minRelativeScore drops them next to strong matches). Sections that were only there
    // because they were sticky don't count, so nothing stays forever.
    for (const { id, repliesAgo } of s.recent?.sticky ?? []) {
        if (!index.chunkById.has(id) || (index.blocked ?? new Set()).has(id)) continue;
        const amount = s.stickyScore * Math.pow(0.5, Math.max(0, repliesAgo - 1));
        let entry = chunkScores.get(id);
        if (!entry) {
            entry = { score: 0, direct: false, reasons: [], sharedWords: [], stickyOnly: true };
            chunkScores.set(id, entry);
        }
        entry.score += amount;
        entry.reasons.push({ entityId: '', name: `sticky: sent ${repliesAgo} repl${repliesAgo === 1 ? 'y' : 'ies'} ago`, amount, defined: true });
    }

    // ---- 5b. Definitions the top chunks rely on ----
    // When a top chunk uses a specific term that another section defines, that section is likely
    // needed too ("file a field exception report" in Dungeon §16 → Guild §5 defines it).
    // Hub terms ("Guild", "dungeon") are skipped so this can't flood the budget.
    if (s.definitionPull > 0 && !meaningAlone) {
        const top = [...chunkScores].filter(([, entry]) => !entry.stickyOnly).sort((a, b) => b[1].score - a[1].score).slice(0, s.definitionPullTop);
        /** @type {Map<string, { amount: number, name: string, from: string }>} */
        const pulls = new Map();
        for (const [chunkId, entry] of top) {
            for (const entity of index.entitiesByChunk.get(chunkId) ?? []) {
                if (entity.definedIn.includes(chunkId) || index.hub.get(entity.id) < s.definitionPullMinHub) continue;
                // One definition per term: a passing mention of "forest Venari" shouldn't bring in
                // every section that describes them. The one already scoring best wins (else the first).
                const candidates = entity.definedIn.filter(id => id !== chunkId && index.chunkById.has(id));
                if (!candidates.length) continue;
                const definingChunk = candidates.reduce((best, id) => ((chunkScores.get(id)?.score ?? 0) > (chunkScores.get(best)?.score ?? 0) ? id : best));
                const amount = entry.score * s.definitionPull * index.hub.get(entity.id);
                if (amount > (pulls.get(definingChunk)?.amount ?? 0)) pulls.set(definingChunk, { amount, name: entity.name, from: chunkId });
            }
        }
        for (const [chunkId, { amount, name, from }] of pulls) {
            const entry = chunkScores.get(chunkId) ?? { score: 0, direct: false, reasons: [], sharedWords: [] };
            entry.score += amount;
            entry.reasons.unshift({ entityId: '', name: `defines "${name}", used in ${from}`, amount, defined: true });
            chunkScores.set(chunkId, entry);
        }
    }

    // ---- 6. Fill the token budget ----
    // Pinned sections go first, whatever the scene; blocked ones are never sent.
    const pinnedIds = new Set(index.pinned ?? []);
    const blockedIds = index.blocked ?? new Set();
    // Stop phrases hold a section back unless the chat names something in it (or its trigger fired).
    const stoppedIds = new Set([...stopHits.keys()].filter(id => chunkScores.has(id) && !chunkScores.get(id).named && !pinnedIds.has(id)));
    const ranked = [...chunkScores].filter(([id]) => !pinnedIds.has(id) && !blockedIds.has(id) && !stoppedIds.has(id)).sort((a, b) => b[1].score - a[1].score);
    const best = ranked[0]?.[1].score ?? 0;
    const sectionsWithTldr = new Set();
    const parts = [];
    let used = 0;
    const chunks = [];

    for (const id of index.pinned ?? []) {
        const chunk = index.chunkById.get(id);
        const entry = chunkScores.get(id);
        const row = { id, score: entry?.score ?? 0, direct: entry?.direct ?? false, pinned: true, reasons: [{ entityId: '', name: 'pinned (always sent)', amount: 0, defined: true }, ...(entry?.reasons ?? [])], sharedWords: entry?.sharedWords ?? [], status: 'cut', tokens: 0 };
        chunks.push(row);
        const sectionKey = `${chunk.docId}|${chunk.sectionNumber}`;
        const full = formatChunk(sectionsWithTldr.has(sectionKey) ? { ...chunk, tldr: '' } : chunk);
        const fullTokens = await countTokens(full);
        const short = formatChunk(chunk, { tldrOnly: true });
        const shortTokens = fullTokens + used <= s.budget ? 0 : await countTokens(short);
        if (used + fullTokens <= s.budget) {
            parts.push(full);
            used += fullTokens;
            Object.assign(row, { status: 'full', tokens: fullTokens });
        } else if (used + shortTokens <= s.budget) {
            parts.push(short);
            used += shortTokens;
            Object.assign(row, { status: 'tldr', tokens: shortTokens });
        } else {
            continue;
        }
        sectionsWithTldr.add(sectionKey);
    }
    for (const [id, entry] of chunkScores) {
        if (blockedIds.has(id)) {
            chunks.push({ id, score: entry.score, direct: entry.direct, reasons: entry.reasons, sharedWords: entry.sharedWords ?? [], status: 'blocked', tokens: 0 });
        } else if (stoppedIds.has(id)) {
            const { phrase, message } = stopHits.get(id);
            chunks.push({ id, score: entry.score, direct: entry.direct, reasons: entry.reasons, sharedWords: entry.sharedWords ?? [], status: 'stopped', stopPhrase: phrase, stopMessage: message, tokens: 0 });
        }
    }

    for (const [id, entry] of ranked) {
        const chunk = index.chunkById.get(id);
        const row = { id, score: entry.score, direct: entry.direct, sticky: !!entry.stickyOnly, reasons: entry.reasons, sharedWords: entry.sharedWords ?? [], status: 'cut', tokens: 0 };
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

    const meaningSeedIds = new Set(meaningSeeds.map(seed => seed.entityId));
    const reached = [...scores]
        .filter(([id]) => !seedIds.has(id) && !meaningSeedIds.has(id))
        .map(([id, { score, path }]) => ({
            entityId: id,
            name: index.byId.get(id).name,
            score,
            path: path.map(step => index.byId.get(step)?.name ?? step),
        }))
        .sort((a, b) => b.score - a.score);

    const triggered = [...triggerHits].map(([id, hit]) => ({ id, phrase: hit.phrase, message: hit.message }));
    return { seeds, triggered, meaningSeeds, meaningChunks: [...meaningChunks.keys()], meaningSkipped, meaningAlone, ignored, reached, chunks, text: parts.join('\n\n'), tokens: used };
}
