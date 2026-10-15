// Runs LLM extraction (one call per chunk) through a Connection Manager profile,
// and the optional duplicate finder (one call). Results go into the graph store.

import { ConnectionManagerRequestService } from '../../shared.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { formatChunk } from './parser.js';
import { DUPLICATES_SCHEMA, ENTITY_TYPES, EXTRACTION_SCHEMA, RELATION_TYPES, normalizeKey, parseJsonReply, validateDuplicates, validateExtraction } from './schema.js';
import { buildGraph, formatEntityList, normalizeStore, selectRelevantEntities } from './graph.js';
import { FILE_PREFIX, loadJsonFile, saveJsonFile } from './storage.js';

export const GRAPH_FILE = `${FILE_PREFIX}graph.json`;

const RATE_LIMIT_WAITS_SECONDS = [20, 60];
const TRUNCATED_MESSAGE = 'The reply was cut off by the response token limit before the answer was finished. "Thinking" models use part of the limit for hidden reasoning. Raise "Max response tokens per chunk" (Advanced) or use a non-thinking model';

const EXTRACTION_INSTRUCTIONS = `You extract a knowledge graph from worldbuilding lore for a roleplay setting.
You will receive ONE chunk of a lore document, plus known entities from earlier chunks that may be relevant.

Return a JSON object: { "entities": [...], "relations": [...] }.

ENTITIES: the setting-specific things in this chunk that a roleplayer might need to look up: organizations, roles, ranks, places, creatures, species, phenomena, materials, objects, credentials, procedures, rules, events, and in-world terms.
- Include named things and terms the lore gives a specific in-world meaning (e.g. "Rank Plate", "deep core", "Aberrant Labyrinth", "undead", "manacite").
- Do NOT include everyday words or generic descriptive phrases (e.g. "route", "vacancy", "weight", "contract budget", "dead quiet", "careless extraction") unless the lore treats them as a defined term.
- Prefer fewer, meaningful entities: usually 3 to 10 per chunk.
For each entity:
- "name": the canonical name. If it is in the known entity list, use EXACTLY that name.
- "type": one of ${ENTITY_TYPES.join(', ')}. Use Concept only if nothing else fits.
- "aliases": other specific names this chunk uses for the same thing (e.g. "the heart" for "deep core"). Never use a general word as an alias (not "practitioner" for "breathing-and-mobility practitioner", not "glow" or "smell" for "manacite glow"): aliases are used to merge entities, so a vague alias merges unrelated things. Empty array if none.
- "description": one sentence, in your own words, saying what it is. Empty string if this chunk only mentions it in passing.
- "defined_here": true if this chunk explains what the thing is or is mainly about it (the section or subsection title usually names such a thing); false if it is only mentioned.

RELATIONS connect two entities (use the same names). Each relation must read as a TRUE sentence: "<source> <type> <target>".
Types: part_of, located_in, requires, has_authority_over, limited_by, causes, produces, classified_as, reclassifies_to, contrasts_with, exception_to, related_to (only if nothing else fits).
Direction examples: "deep core located_in dungeon", "manacite saturation causes disorientation", "promotion requires Merit Index", "Aberrant Labyrinth contrasts_with dungeon".
"evidence" is a short paraphrase (under 25 words) of what the chunk says.

The chunk may end with a "✕ Not This" guardrail: a warning about a common mistake. Capture it as relations where natural, usually contrasts_with (A is not B / do not confuse them) or exception_to (X is an exception to rule Y).

Only include what THIS chunk states. Do not invent facts or bring in things from other parts of the world. Reply with the JSON object only.`;

const DUPLICATE_INSTRUCTIONS = `You review an entity list from a worldbuilding knowledge graph and find entries that probably refer to the SAME thing under different names (synonyms, abbreviations, singular/plural, with/without a title or article).
Do not pair things that are merely related (a rank and its plate, a place and its inhabitants) or that are distinct members of the same category (C-Rank vs B-Rank).
Return JSON: { "pairs": [ { "a": "<exact name>", "b": "<exact name>", "reason": "<short reason>" } ] }. Use names exactly as listed. Return an empty array if there are none.`;

/** @type {import('./graph.js').GraphStore|null} */
let cachedStore = null;

/**
 * Loads the graph store. Use `fresh` before changing it, so a tab holding an older copy
 * (e.g. a second SillyTavern tab) never saves over newer results.
 * Throws if the file exists but can't be read, so a broken read never overwrites real data.
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<import('./graph.js').GraphStore>}
 */
export async function loadGraphStore({ fresh = false } = {}) {
    if (cachedStore && !fresh) {
        return cachedStore;
    }
    let data;
    try {
        data = await loadJsonFile(GRAPH_FILE); // null when the file doesn't exist yet
    } catch (error) {
        console.error('Lore Graph: could not read the graph file', error);
        throw new Error(`Could not read ${GRAPH_FILE}. Nothing was changed. Reload the page and try again. (${error?.message ?? error})`);
    }
    cachedStore = normalizeStore(data);
    return cachedStore;
}

/**
 * Saves the store, including a snapshot of the full graph for inspection.
 * @param {import('./graph.js').GraphStore} store
 */
export async function saveGraphStore(store) {
    store.graph = { ...buildGraph(store, Object.keys(store.chunkResults)), builtAt: Date.now() };
    await saveJsonFile(GRAPH_FILE, store);
}

/**
 * Returns the profile or throws an error that explains how to fix it.
 * @param {string} profileId
 */
export function getUsableProfile(profileId) {
    if (!profileId) {
        throw new Error('Choose a connection profile for extraction first.');
    }
    let profile;
    try {
        profile = ConnectionManagerRequestService.getProfile(profileId);
    } catch {
        throw new Error('The selected connection profile no longer exists. Choose another one.');
    }
    if (!ConnectionManagerRequestService.isProfileSupported(profile)) {
        throw new Error(`Profile "${profile.name}" uses an API type that can't be used for extraction. Use a Chat Completion or Text Completion profile.`);
    }
    if (!profile.model) {
        throw new Error(`Profile "${profile.name}" has no model saved. In API Connections, select the model, then update the profile in Connection Profiles.`);
    }
    return profile;
}

function buildExtractionMessages(chunk, entityListText) {
    return [
        { role: 'system', content: EXTRACTION_INSTRUCTIONS },
        { role: 'user', content: `KNOWN ENTITIES:\n${entityListText}\n\nLORE CHUNK:\n${formatChunk(chunk)}` },
    ];
}

/**
 * Estimates input tokens for extracting the given chunks. Each call only carries the
 * known entities relevant to its chunk, so the estimate adds a small allowance for the
 * entities that earlier calls in the same run will add.
 * @param {import('./parser.js').LoreChunk[]} chunks
 * @param {import('./graph.js').Entity[]} currentEntities
 * @returns {Promise<number>}
 */
export async function estimateExtractionTokens(chunks, currentEntities) {
    const instructionTokens = await getTokenCountAsync(EXTRACTION_INSTRUCTIONS);
    const perEntityTokens = 12;
    const newEntitiesAllowance = 4 * perEntityTokens;
    let total = 0;
    for (const chunk of chunks) {
        const relevant = selectRelevantEntities(currentEntities, chunk).length;
        total += instructionTokens + chunk.tokens + 40 + relevant * perEntityTokens + newEntitiesAllowance;
    }
    return total;
}

class RateLimitError extends Error { }

function describeError(error) {
    const parts = [];
    let current = error;
    while (current) {
        if (current.message) parts.push(current.message);
        current = current.cause;
    }
    return parts.join(' ← ') || String(error);
}

function looksLikeRateLimit(error) {
    return /\b429\b|rate.?limit|too many requests|quota|usage limit/i.test(describeError(error));
}

/**
 * One request through the Connection Manager.
 * Asks for the raw response so we can see whether the reply was cut off by the token limit.
 * @returns {Promise<{ content: string, truncated: boolean }>}
 */
async function callModel(profileId, messages, { maxTokens, useSchema, schema, signal, timeoutSeconds }) {
    const overridePayload = { temperature: 0.2 };
    if (useSchema) {
        overridePayload.json_schema = schema;
    }
    const profile = ConnectionManagerRequestService.getProfile(profileId);

    // Our own controller: aborted by the user's Stop or by the time limit.
    const controller = new AbortController();
    const onStop = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onStop, { once: true });
    let timedOut = false;
    const timer = timeoutSeconds > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSeconds * 1000) : null;

    let raw;
    try {
        raw = await ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            maxTokens,
            { stream: false, signal: controller.signal, extractData: false, includePreset: true, includeInstruct: true },
            overridePayload,
        );
    } catch (error) {
        if (timedOut && !signal?.aborted) {
            throw new Error(`No answer within ${timeoutSeconds} seconds (the time limit per request). Slow "thinking" models may need a higher limit in Advanced.`);
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onStop);
    }
    const context = SillyTavern.getContext();
    const apiType = context.CONNECT_API_MAP[profile.api]?.selected;
    const content = String(context.extractMessageFromData(raw, apiType) ?? '');
    // @ts-ignore - raw provider response
    const finish = raw?.choices?.[0]?.finish_reason ?? raw?.stop_reason ?? raw?.candidates?.[0]?.finishReason ?? '';
    return { content, truncated: /length|max_tokens/i.test(String(finish)) };
}

/**
 * Calls the model, waiting and retrying on rate limits.
 */
async function callWithRateLimitRetry(profileId, messages, options, onWait) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await callModel(profileId, messages, options);
        } catch (error) {
            if (options.signal?.aborted) throw error;
            if (!looksLikeRateLimit(error)) throw error;
            if (attempt >= RATE_LIMIT_WAITS_SECONDS.length) {
                throw new RateLimitError(`The provider keeps refusing requests (rate or usage limit): ${describeError(error)}`);
            }
            const seconds = RATE_LIMIT_WAITS_SECONDS[attempt];
            onWait?.(seconds);
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, seconds * 1000);
                options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
            });
        }
    }
}

/**
 * One-off JSON request (used by review tools): rate-limit waits, time limit, truncation
 * detection, local check, and one retry with the problem explained.
 * @param {{ id: string }} profile
 * @param {{ role: string, content: string }[]} messages
 * @param {object} schema JSON schema for strict mode
 * @param {object} settings extension settings
 * @param {(data: any) => string|null} check returns an error message, or null if the data is usable
 * @returns {Promise<any>} parsed data
 */
export async function callModelForJson(profile, messages, schema, settings, check) {
    const options = {
        maxTokens: settings.extraction_max_tokens,
        useSchema: settings.extraction_structured_output,
        schema,
        timeoutSeconds: (Number(settings.extraction_timeout_seconds) || 0) * 2,
    };
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const attemptMessages = attempt === 1 ? messages : [...messages, { role: 'user', content: `Your previous answer could not be used: ${lastError}\nReply again with ONLY the JSON object.` }];
        try {
            const { content, truncated } = await callWithRateLimitRetry(profile.id, attemptMessages, options);
            let data = null;
            try { data = parseJsonReply(content); } catch (error) { lastError = error.message; }
            if (data) {
                const problem = check(data);
                if (!problem) return data;
                lastError = problem;
            }
            if (truncated) lastError = `${TRUNCATED_MESSAGE} (limit: ${options.maxTokens} tokens)`;
        } catch (error) {
            if (error instanceof RateLimitError) throw error;
            lastError = describeError(error);
        }
    }
    throw new Error(`The AI request failed: ${lastError}`);
}

function preview(content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return String(text ?? '').slice(0, 600);
}

/**
 * Extracts one chunk: one call, plus one retry if the answer is invalid.
 * @returns {Promise<import('./graph.js').ChunkResult>}
 */
async function extractChunk(chunk, entityListText, profile, settings, signal, onWait) {
    const messages = buildExtractionMessages(chunk, entityListText);
    const options = { maxTokens: settings.extraction_max_tokens, useSchema: settings.extraction_structured_output, schema: EXTRACTION_SCHEMA, signal, timeoutSeconds: settings.extraction_timeout_seconds };
    const base = { hash: chunk.hash, extractedAt: Date.now(), profileName: profile.name, model: profile.model };

    let lastError = '';
    let lastPreview = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const attemptMessages = attempt === 1 ? messages : [
            ...messages,
            { role: 'user', content: `Your previous answer could not be used: ${lastError}\nReply again with ONLY the JSON object, exactly in the required format.` },
        ];
        let content;
        let truncated;
        try {
            ({ content, truncated } = await callWithRateLimitRetry(profile.id, attemptMessages, options, onWait));
        } catch (error) {
            if (error instanceof RateLimitError || signal?.aborted) throw error;
            lastError = `Request failed: ${describeError(error)}`;
            lastPreview = '';
            console.warn(`Lore Graph: ${chunk.id} attempt ${attempt}: ${lastError}`, error);
            continue;
        }

        if (truncated && !content.trim()) {
            // Retrying with the same limit would fail the same way.
            lastError = `${TRUNCATED_MESSAGE} (limit: ${options.maxTokens} tokens)`;
            lastPreview = '';
            console.warn(`Lore Graph: ${chunk.id}: ${lastError}`);
            break;
        }

        const checked = validateExtraction(content);
        if (!checked.ok && truncated) {
            checked.error = `${TRUNCATED_MESSAGE} (limit: ${options.maxTokens} tokens)`;
        }
        if (checked.ok) {
            if (checked.notes.length) {
                console.info(`Lore Graph: ${chunk.id}: ${checked.notes.length} note(s)`, checked.notes);
            }
            return { ...base, status: 'ok', entities: checked.entities, relations: checked.relations, notes: checked.notes, error: null };
        }
        lastError = checked.error;
        lastPreview = preview(content);
        console.warn(`Lore Graph: ${chunk.id} attempt ${attempt} was invalid: ${lastError}`, lastPreview);
    }

    console.error(`Lore Graph: extraction failed for ${chunk.id}: ${lastError}`);
    return { ...base, status: 'failed', entities: [], relations: [], notes: [], error: lastError, rawPreview: lastPreview };
}

/**
 * Extracts the given chunks, several at a time if configured, saving after each one.
 * Chunks running at the same moment don't see each other's new entities; the merge
 * pass and the duplicate finder catch most of that overlap.
 * @param {object} args
 * @param {import('./parser.js').LoreChunk[]} args.chunks chunks to extract
 * @param {string[]} args.contextChunkIds chunk ids whose existing results form the known-entity list
 * @param {string} args.profileId
 * @param {object} args.settings extension settings
 * @param {AbortSignal} args.signal
 * @param {(progress: { done: number, total: number, running: string[], failed: number, waiting?: number }) => void} args.onProgress
 * @returns {Promise<{ done: number, failed: number, stopped: boolean, stopReason: string|null }>}
 */
export async function runExtraction({ chunks, contextChunkIds, profileId, settings, signal, onProgress }) {
    const profile = getUsableProfile(profileId);
    const store = await loadGraphStore({ fresh: true });
    // Old results of chunks being redone in this run are stale; don't feed them back as "known".
    const runIds = new Set(chunks.map(c => c.id));
    const includedIds = new Set(contextChunkIds.filter(id => !runIds.has(id)));
    const total = chunks.length;
    const queue = [...chunks];
    const running = new Set();
    const firstResults = [];
    let done = 0;
    let failed = 0;
    let stopReason = null;
    let fatalError = null;

    // Stops every worker: on the user's Stop, a rate-limit pause, or an unexpected error.
    const stopAll = new AbortController();
    if (signal.aborted) stopAll.abort();
    signal.addEventListener('abort', () => stopAll.abort(), { once: true });

    // Saves run one after another so an older snapshot never lands after a newer one.
    let saveChain = Promise.resolve();
    const save = () => (saveChain = saveChain.then(() => saveGraphStore(store)));

    const report = (waiting) => onProgress({ done, total, running: [...running], failed, waiting });

    async function worker() {
        while (queue.length && !stopAll.signal.aborted) {
            const chunk = queue.shift();
            running.add(chunk.id);
            report();

            // Known entities: only the ones relevant to this chunk, so the prompt stays small.
            const known = buildGraph(store, [...includedIds]).entities;
            const entityListText = formatEntityList(selectRelevantEntities(known, chunk));

            let result;
            try {
                result = await extractChunk(chunk, entityListText, profile, settings, stopAll.signal, (seconds) => report(seconds));
            } catch (error) {
                running.delete(chunk.id);
                if (stopAll.signal.aborted) return;
                if (error instanceof RateLimitError) {
                    stopReason ??= error.message;
                } else {
                    fatalError ??= error;
                }
                stopAll.abort();
                return;
            }
            running.delete(chunk.id);

            // Keep finished work even if another worker paused the run meanwhile.
            store.chunkResults[chunk.id] = result;
            includedIds.add(chunk.id);
            if (result.status === 'failed') failed++;
            done++;
            if (firstResults.length < 2) firstResults.push(result);
            await save();
            report();

            // If the very first results both fail at the request level, the profile, model or
            // JSON mode is probably the problem; stop instead of burning through every chunk.
            if (done === 2 && firstResults.every(r => r.status === 'failed' && r.error?.startsWith('Request failed'))) {
                const hint = settings.extraction_structured_output
                    ? ' If your provider or model does not support strict JSON mode, turn off "Use strict JSON mode" and try again.'
                    : '';
                stopReason ??= `The first two requests failed: ${firstResults[1].error}.${hint}`;
                stopAll.abort();
                return;
            }
        }
    }

    const workerCount = Math.max(1, Math.min(Number(settings.extraction_concurrency) || 1, total));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await saveChain;

    if (fatalError) throw fatalError;
    if (stopReason) return { done, failed, stopped: true, stopReason };
    if (signal.aborted) return { done, failed, stopped: true, stopReason: null };
    report();
    return { done, failed, stopped: false, stopReason: null };
}

/**
 * One LLM call that suggests duplicate entities. Suggestions are saved as pending for review.
 * @param {import('./graph.js').Entity[]} entities
 * @param {string} profileId
 * @param {object} settings
 * @returns {Promise<number>} number of new suggestions
 */
export async function findDuplicates(entities, profileId, settings) {
    const profile = getUsableProfile(profileId);
    const list = entities
        .map(e => `- ${e.name} [${e.type}]${e.aliases.length ? ` (also: ${e.aliases.join(', ')})` : ''}${e.description ? `: ${e.description}` : ''}`)
        .join('\n');
    const messages = [
        { role: 'system', content: DUPLICATE_INSTRUCTIONS },
        { role: 'user', content: `ENTITY LIST:\n${list}` },
    ];
    // The duplicate finder reads the whole entity list, so it gets twice the per-request time limit.
    const options = { maxTokens: settings.extraction_max_tokens, useSchema: settings.extraction_structured_output, schema: DUPLICATES_SCHEMA, timeoutSeconds: (Number(settings.extraction_timeout_seconds) || 0) * 2 };

    let checked = null;
    let lastError = '';
    for (let attempt = 1; attempt <= 2 && !checked?.ok; attempt++) {
        try {
            const { content, truncated } = await callWithRateLimitRetry(profile.id, messages, options);
            checked = validateDuplicates(content);
            if (!checked.ok) lastError = truncated ? `${TRUNCATED_MESSAGE} (limit: ${options.maxTokens} tokens)` : checked.error;
        } catch (error) {
            if (error instanceof RateLimitError) throw error;
            lastError = describeError(error);
            checked = null;
        }
    }
    if (!checked?.ok) {
        throw new Error(`The duplicate finder failed: ${lastError}`);
    }

    // Re-read after the (slow) call so suggestions are added to the latest saved data.
    const store = await loadGraphStore({ fresh: true });
    const byKey = new Map(entities.flatMap(e => [e.name, ...e.aliases].map(n => [normalizeKey(n), e.id])));
    const seen = new Set([...store.decisions.merges, ...store.decisions.rejected, ...store.decisions.pending.map(p => [normalizeKey(p.a), normalizeKey(p.b)])]
        .map(([a, b]) => [a, b].sort().join('|')));
    let added = 0;
    for (const pair of checked.pairs) {
        const a = byKey.get(normalizeKey(pair.a));
        const b = byKey.get(normalizeKey(pair.b));
        if (!a || !b || a === b) continue;
        const key = [a, b].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const nameA = entities.find(e => e.id === a).name;
        const nameB = entities.find(e => e.id === b).name;
        store.decisions.pending.push({ a: nameA, b: nameB, reason: pair.reason });
        added++;
    }
    await saveGraphStore(store);
    return added;
}

/**
 * Applies the user's decision on a duplicate suggestion.
 * @param {number} index position in decisions.pending
 * @param {boolean} approve
 */
export async function decideDuplicate(index, approve) {
    const store = await loadGraphStore({ fresh: true });
    const [pair] = store.decisions.pending.splice(index, 1);
    if (!pair) return;
    const keys = /** @type {[string, string]} */ ([normalizeKey(pair.a), normalizeKey(pair.b)]);
    (approve ? store.decisions.merges : store.decisions.rejected).push(keys);
    await saveGraphStore(store);
}
