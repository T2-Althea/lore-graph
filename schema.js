// Graph vocabulary, the JSON schema sent to the model, and checking of its answers.
// Pure JavaScript with no SillyTavern imports, so it can be tested in Node.

export const ENTITY_TYPES = [
    'Organization', 'Role', 'Rank', 'Place', 'Creature', 'Species', 'Phenomenon',
    'Material', 'Object', 'Credential', 'Procedure', 'Rule', 'Event', 'Concept',
];
export const FALLBACK_ENTITY_TYPE = 'Concept';

export const RELATION_TYPES = [
    'part_of', 'located_in', 'requires', 'has_authority_over', 'limited_by', 'causes',
    'produces', 'classified_as', 'reclassifies_to', 'contrasts_with', 'exception_to', 'related_to',
];
export const FALLBACK_RELATION_TYPE = 'related_to';

const MAX_DESCRIPTION_LENGTH = 300;
const MAX_EVIDENCE_LENGTH = 250;

/** JSON schema for one chunk's extraction. Written to be valid in "strict" mode. */
export const EXTRACTION_SCHEMA = {
    name: 'lore_graph_extraction',
    description: 'Entities and relationships found in one lore chunk',
    strict: true,
    value: {
        type: 'object',
        properties: {
            entities: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        type: { type: 'string', enum: ENTITY_TYPES },
                        aliases: { type: 'array', items: { type: 'string' } },
                        description: { type: 'string' },
                        defined_here: { type: 'boolean' },
                    },
                    required: ['name', 'type', 'aliases', 'description', 'defined_here'],
                    additionalProperties: false,
                },
            },
            relations: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        source: { type: 'string' },
                        target: { type: 'string' },
                        type: { type: 'string', enum: RELATION_TYPES },
                        evidence: { type: 'string' },
                    },
                    required: ['source', 'target', 'type', 'evidence'],
                    additionalProperties: false,
                },
            },
        },
        required: ['entities', 'relations'],
        additionalProperties: false,
    },
};

/** JSON schema for the duplicate finder. */
export const DUPLICATES_SCHEMA = {
    name: 'lore_graph_duplicates',
    description: 'Pairs of entity names that probably refer to the same thing',
    strict: true,
    value: {
        type: 'object',
        properties: {
            pairs: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        a: { type: 'string' },
                        b: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['a', 'b', 'reason'],
                    additionalProperties: false,
                },
            },
        },
        required: ['pairs'],
        additionalProperties: false,
    },
};

// Words ending in "s" that are not plurals, so "species" isn't turned into "specie".
const NOT_PLURAL = new Set(['species', 'series', 'news', 'chaos', 'ethos', 'pathos', 'kudos', 'means', 'mathematics', 'physics', 'ethics', 'alchemics', 'ruins']);

function singularize(word) {
    if (word.length <= 3 || NOT_PLURAL.has(word)) return word;
    if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
    if (/(ss|us|is)$/.test(word)) return word;
    if (/(sses|xes|ches|shes|zes)$/.test(word)) return word.slice(0, -2);
    if (word.endsWith('s')) return word.slice(0, -1);
    return word;
}

/**
 * Key used to decide whether two names are the same entity:
 * case-insensitive, leading "the/a/an" removed, punctuation ignored, last word singular.
 * @param {string} name
 * @returns {string}
 */
export function normalizeKey(name) {
    const words = String(name ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[’‘`]/g, '\'')
        .replace(/'s\b/g, '')
        .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
        .replace(/-/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    while (words.length > 1 && ['the', 'a', 'an'].includes(words[0])) {
        words.shift();
    }
    if (words.length) {
        words[words.length - 1] = singularize(words[words.length - 1]);
    }
    return words.join(' ');
}

/**
 * Looser form used to spot names inside running text: like normalizeKey, but every
 * word is made singular ("rank plates" and "Rank Plate" both become "rank plate").
 * @param {string} text
 * @returns {string}
 */
export function matchForm(text) {
    return normalizeKey(text).split(' ').filter(Boolean).map(singularize).join(' ');
}

function cleanString(value, maxLength = Infinity) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + '…' : text;
}

/**
 * Turns a model reply into an object. Accepts an already-parsed object, plain JSON,
 * or JSON wrapped in ``` fences / surrounded by stray text.
 * @param {any} reply
 * @returns {any} parsed value
 * @throws {Error} if no JSON object can be found
 */
export function parseJsonReply(reply) {
    if (reply && typeof reply === 'object') {
        return reply;
    }
    let text = String(reply ?? '').trim();
    if (!text) {
        throw new Error('The reply was empty.');
    }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        text = fenced[1].trim();
    }
    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(text.slice(start, end + 1));
            } catch { /* fall through */ }
        }
        throw new Error('The reply was not valid JSON.');
    }
}

/**
 * @typedef {object} ExtractedEntity
 * @property {string} name
 * @property {string|null} type null when the entity was only added because a relation pointed at it
 * @property {string[]} aliases
 * @property {string} description
 * @property {boolean} defined_here
 */

/**
 * @typedef {object} ExtractedRelation
 * @property {string} source
 * @property {string} target
 * @property {string} type
 * @property {string} evidence
 */

/**
 * Checks and tidies one chunk's extraction.
 * Structural problems make it invalid (the caller retries); small problems are fixed and noted.
 * @param {any} reply raw model reply (string or object)
 * @returns {{ ok: true, entities: ExtractedEntity[], relations: ExtractedRelation[], notes: string[] } | { ok: false, error: string }}
 */
export function validateExtraction(reply) {
    let data;
    try {
        data = parseJsonReply(reply);
    } catch (error) {
        return { ok: false, error: error.message };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'The reply must be a JSON object with "entities" and "relations".' };
    }
    if (!Array.isArray(data.entities)) {
        return { ok: false, error: 'The reply has no "entities" array.' };
    }
    if (!Array.isArray(data.relations)) {
        data.relations = [];
    }

    const notes = [];
    /** @type {Map<string, ExtractedEntity>} */
    const byKey = new Map();
    let badEntities = 0;

    for (const raw of data.entities) {
        const name = cleanString(raw?.name, 120);
        const key = normalizeKey(name);
        if (!key) {
            badEntities++;
            continue;
        }
        let type = cleanString(raw?.type);
        const matchedType = ENTITY_TYPES.find(t => t.toLowerCase() === type.toLowerCase());
        if (!matchedType) {
            notes.push(`Entity "${name}": unknown type "${type || '(none)'}", using ${FALLBACK_ENTITY_TYPE}.`);
            type = FALLBACK_ENTITY_TYPE;
        } else {
            type = matchedType;
        }
        const aliases = Array.isArray(raw?.aliases) ? raw.aliases.map(a => cleanString(a, 120)).filter(Boolean) : [];
        const entity = {
            name,
            type,
            aliases: [...new Map(aliases.filter(a => normalizeKey(a) && normalizeKey(a) !== key).map(a => [a.toLowerCase(), a])).values()],
            description: cleanString(raw?.description, MAX_DESCRIPTION_LENGTH),
            defined_here: raw?.defined_here === true || raw?.defined_here === 'true',
        };

        const existing = byKey.get(key);
        if (existing) {
            // The model listed the same thing twice in one chunk; combine them.
            existing.aliases = [...new Set([...existing.aliases, ...entity.aliases])];
            existing.defined_here = existing.defined_here || entity.defined_here;
            existing.description = existing.description || entity.description;
        } else {
            byKey.set(key, entity);
        }
    }

    if (data.entities.length && badEntities > data.entities.length / 2) {
        return { ok: false, error: 'Most entities were missing a "name".' };
    }
    if (badEntities) {
        notes.push(`${badEntities} entity entries had no name and were ignored.`);
    }

    // Aliases also count as names for matching relation endpoints within this chunk.
    const aliasToKey = new Map();
    for (const [key, entity] of byKey) {
        for (const alias of entity.aliases) {
            aliasToKey.set(normalizeKey(alias), key);
        }
    }

    /** @type {ExtractedRelation[]} */
    const relations = [];
    let badRelations = 0;
    for (const raw of data.relations) {
        const source = cleanString(raw?.source, 120);
        const target = cleanString(raw?.target, 120);
        if (!normalizeKey(source) || !normalizeKey(target)) {
            badRelations++;
            continue;
        }
        if (normalizeKey(source) === normalizeKey(target)) {
            notes.push(`Relation from "${source}" to itself was ignored.`);
            continue;
        }
        let type = cleanString(raw?.type).toLowerCase().replace(/[\s-]+/g, '_');
        if (!RELATION_TYPES.includes(type)) {
            notes.push(`Relation "${source}" → "${target}": unknown type "${type || '(none)'}", using ${FALLBACK_RELATION_TYPE}.`);
            type = FALLBACK_RELATION_TYPE;
        }
        for (const endpoint of [source, target]) {
            const key = normalizeKey(endpoint);
            if (!byKey.has(key) && !aliasToKey.has(key)) {
                byKey.set(key, { name: endpoint, type: null, aliases: [], description: '', defined_here: false });
                notes.push(`"${endpoint}" was used in a relation but not listed as an entity; added as a mention.`);
            }
        }
        relations.push({ source, target, type, evidence: cleanString(raw?.evidence, MAX_EVIDENCE_LENGTH) });
    }
    if (badRelations) {
        notes.push(`${badRelations} relation entries were missing a source or target and were ignored.`);
    }

    return { ok: true, entities: [...byKey.values()], relations, notes };
}

/**
 * Checks the duplicate finder's reply.
 * @param {any} reply
 * @returns {{ ok: true, pairs: { a: string, b: string, reason: string }[] } | { ok: false, error: string }}
 */
export function validateDuplicates(reply) {
    let data;
    try {
        data = parseJsonReply(reply);
    } catch (error) {
        return { ok: false, error: error.message };
    }
    if (!data || !Array.isArray(data.pairs)) {
        return { ok: false, error: 'The reply has no "pairs" array.' };
    }
    const pairs = data.pairs
        .map(p => ({ a: cleanString(p?.a, 120), b: cleanString(p?.b, 120), reason: cleanString(p?.reason, MAX_EVIDENCE_LENGTH) }))
        .filter(p => p.a && p.b && normalizeKey(p.a) !== normalizeKey(p.b));
    return { ok: true, pairs };
}
