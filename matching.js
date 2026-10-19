// How entity names are allowed to match chat text (Always / Capital letter only / Needs context / Never),
// short names marked safe, and the optional everyday-word check (one LLM call).
// Saved in its own file so it never races with extraction saving the graph file.

import { matchForm } from './schema.js';
import { createEmptyMatching } from './retrieval.js';
import { FILE_PREFIX, loadJsonFile, saveJsonFile } from './storage.js';
import { callModelForJson, getUsableProfile } from './extraction.js';

export const MATCHING_FILE = `${FILE_PREFIX}matching.json`;

/** @type {import('./retrieval.js').MatchingSettings|null} */
let cached = null;
/** Increases on every change, so callers can tell when to rebuild their caches. */
export let matchingRevision = 0;

function normalize(data) {
    const matching = createEmptyMatching();
    if (data && typeof data === 'object') {
        if (data.modes && typeof data.modes === 'object') matching.modes = data.modes;
        if (Array.isArray(data.safeAliases)) matching.safeAliases = data.safeAliases;
        if (Array.isArray(data.checkedNames)) matching.checkedNames = data.checkedNames;
    }
    return matching;
}

/**
 * @param {{ fresh?: boolean }} [options] fresh re-reads the file (use before changing it)
 * @returns {Promise<import('./retrieval.js').MatchingSettings>}
 */
export async function loadMatching({ fresh = false } = {}) {
    if (cached && !fresh) return cached;
    try {
        cached = normalize(await loadJsonFile(MATCHING_FILE));
    } catch (error) {
        console.error('Lore Graph: could not read matching settings', error);
        throw new Error(`Could not read ${MATCHING_FILE}. Nothing was changed. Reload the page and try again.`);
    }
    matchingRevision++;
    return cached;
}

/**
 * Applies a change to the latest saved matching settings and saves them.
 * @param {(matching: import('./retrieval.js').MatchingSettings) => void} change
 */
async function updateMatching(change) {
    const matching = await loadMatching({ fresh: true });
    change(matching);
    await saveJsonFile(MATCHING_FILE, matching);
    matchingRevision++;
}

/**
 * Sets how all of an entity's names may match (the graph browser's per-entity choice).
 * @param {import('./graph.js').Entity} entity
 * @param {'always'|'capital'|'capital_strict'|'context'|'never'} mode
 */
export async function setEntityMatchMode(entity, mode) {
    await setNameMatchModes([entity.name, ...entity.aliases], mode);
}

/**
 * Sets how the given names may match.
 * @param {string[]} names
 * @param {'always'|'capital'|'capital_strict'|'context'|'never'} mode
 */
export async function setNameMatchModes(names, mode) {
    await updateMatching(matching => {
        for (const name of names) {
            const form = matchForm(name);
            if (!form) continue;
            if (mode === 'always') delete matching.modes[form];
            else matching.modes[form] = mode;
        }
    });
}

/**
 * Marks a short name (under the minimum length) as safe to match, or not.
 * @param {string} name
 * @param {boolean} safe
 */
export async function setAliasSafe(name, safe) {
    const form = matchForm(name);
    await updateMatching(matching => {
        matching.safeAliases = matching.safeAliases.filter(x => x !== form);
        if (safe) matching.safeAliases.push(form);
    });
}

const EVERYDAY_SCHEMA = {
    name: 'lore_graph_everyday_words',
    description: 'Entity names that are also ordinary words in conversation',
    strict: true,
    value: {
        type: 'object',
        properties: {
            everyday: { type: 'array', items: { type: 'string' } },
            capitalised: { type: 'array', items: { type: 'string' } },
        },
        required: ['everyday', 'capitalised'],
        additionalProperties: false,
    },
};

const EVERYDAY_INSTRUCTIONS = `You help a roleplay tool decide which lore terms can be matched in chat safely.
You get a list of names from the setting's lore. Return the names that are ALSO ordinary words or phrases a character could easily say in a roleplay WITHOUT meaning the specific lore concept.
Examples of everyday names: "seal" (a seal on a letter), "smell", "weight", "strength", "failure", "renewal", "focus", "form", "character", "branch".
NOT everyday: names that mean the same thing whenever they are said in a story set in this world, such as creatures, peoples, materials, places, schools of magic, technologies and specific institutions ("wraith", "dragon", "elves", "ironglass", "Hollow Court", "Warden's Seal").
Some everyday names are ALSO a specific place, power or thing in this setting when written with a capital letter, the way "the sea" is any sea but "the Sea" can be one named place, or "the abyss" is a deep hole but "the Abyss" a realm. List those in "capitalised" as well (they also stay in "everyday"). Only do this when the capitalised form plausibly names one specific lore thing.
Return JSON: { "everyday": ["<exact name from the list>", ...], "capitalised": ["<exact name>", ...] }. Use names exactly as given. Return empty arrays if none.`;

const EVERYDAY_BATCH_SIZE = 60;

/**
 * Asks the AI which names are everyday words, in small batches (big single requests were
 * very slow). Only names not checked before are sent. Returns suggestions for the user to
 * review; nothing is saved here. Batches that fail are left unchecked so they're retried next time.
 * @param {import('./graph.js').Entity[]} entities
 * @param {string} profileId
 * @param {object} settings extension settings
 * @param {(done: number, total: number) => void} [onProgress] counts names
 * @returns {Promise<{ suggestions: { entity: import('./graph.js').Entity, name: string, capitalised: boolean }[], checkedForms: string[], failedBatches: number, error: string|null }>}
 */
export async function findEverydayWords(entities, profileId, settings, onProgress) {
    const profile = getUsableProfile(profileId);
    const matching = await loadMatching({ fresh: true });
    const checked = new Set(matching.checkedNames);

    /** @type {Map<string, { entity: import('./graph.js').Entity, name: string }>} */
    const byForm = new Map();
    for (const entity of entities) {
        for (const name of [entity.name, ...entity.aliases]) {
            const form = matchForm(name);
            if (form && !checked.has(form) && !byForm.has(form)) byForm.set(form, { entity, name });
        }
    }
    if (!byForm.size) {
        return { suggestions: [], checkedForms: [], failedBatches: 0, error: null };
    }

    const forms = [...byForm.keys()];
    const batches = [];
    for (let i = 0; i < forms.length; i += EVERYDAY_BATCH_SIZE) batches.push(forms.slice(i, i + EVERYDAY_BATCH_SIZE));

    const suggestions = [];
    const seenForms = new Set();
    const checkedForms = [];
    let failedBatches = 0;
    let lastError = null;
    let doneNames = 0;
    onProgress?.(0, forms.length);

    const queue = [...batches];
    async function worker() {
        while (queue.length) {
            const batch = queue.shift();
            const list = batch.map(form => `- ${byForm.get(form).name}`).join('\n');
            try {
                const reply = await callModelForJson(profile, [
                    { role: 'system', content: EVERYDAY_INSTRUCTIONS },
                    { role: 'user', content: `NAMES:\n${list}` },
                ], EVERYDAY_SCHEMA, settings, (data) => Array.isArray(data?.everyday) ? null : 'The reply has no "everyday" array.');
                const capitalisedForms = new Set((Array.isArray(reply.capitalised) ? reply.capitalised : []).map(name => matchForm(String(name))));
                for (const name of reply.everyday) {
                    const form = matchForm(String(name));
                    const hit = batch.includes(form) ? byForm.get(form) : null;
                    if (hit && !seenForms.has(form)) {
                        seenForms.add(form);
                        suggestions.push({ ...hit, capitalised: capitalisedForms.has(form) });
                    }
                }
                checkedForms.push(...batch);
            } catch (error) {
                console.warn('Lore Graph: an everyday-word batch failed', error);
                failedBatches++;
                lastError = String(error?.message ?? error);
            }
            doneNames += batch.length;
            onProgress?.(doneNames, forms.length);
        }
    }
    const workers = Math.max(1, Math.min(Number(settings.extraction_concurrency) || 1, batches.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    if (!checkedForms.length) {
        throw new Error(`The everyday-word check failed: ${lastError}`);
    }
    suggestions.sort((a, b) => a.name.localeCompare(b.name));
    return { suggestions, checkedForms, failedBatches, error: lastError };
}

/**
 * Saves the user's review of the everyday-word suggestions. Only the reviewed names change;
 * the entity's other names keep counting as before.
 * @param {{ name: string, mode: 'context'|'capital'|'capital_strict' }[]} changes
 * @param {string[]} checkedForms every name that was sent, so it isn't sent again next time
 */
export async function applyEverydayReview(changes, checkedForms) {
    await updateMatching(matching => {
        for (const { name, mode } of changes) {
            const form = matchForm(name);
            if (!form) continue;
            // An earlier choice of Never stays; everything else takes the reviewed mode.
            if (matching.modes[form] !== 'never') matching.modes[form] = mode;
        }
        matching.checkedNames = [...new Set([...matching.checkedNames, ...checkedForms])];
    });
}
