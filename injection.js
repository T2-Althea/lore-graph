// Runs retrieval before each generation and puts the lore block into the prompt with
// setExtensionPrompt, the same way the bundled Vectors extension does.

import { setExtensionPrompt, substituteParamsExtended } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { buildGraph } from './graph.js';
import { loadGraphStore } from './extraction.js';
import { loadMatching, matchingRevision } from './matching.js';
import { buildRetrievalIndex, retrieve } from './retrieval.js';
import { DEFAULT_EMBEDDING_SETTINGS, buildQueryText, semanticSearch } from './embeddings.js';

/** Prompt key; extension prompts are ordered by key, after Vectors' "3_vectors" / "4_vectors_data_bank". */
export const PROMPT_KEY = '5_lore_graph';

export const DEFAULT_INJECTION_SETTINGS = {
    retrieval_messages: 4,
    retrieval_hops: 2,
    retrieval_budget: 1500,
    inject_position: 0, // extension_prompt_types.IN_PROMPT (after main prompt)
    inject_depth: 4,
    inject_role: 0,     // extension_prompt_roles.SYSTEM
    inject_scan: false, // let World Info scan the injected lore
    inject_template: 'Relevant world lore for this scene, from the setting\'s codices:\n{{text}}',
    ...DEFAULT_EMBEDDING_SETTINGS,
};

let cache = { key: '', index: null };

/**
 * The retrieval index for the current chat's chunks, rebuilt only when something changed.
 * @param {import('./parser.js').LoreChunk[]} chunks
 */
async function getRetrievalIndex(chunks) {
    const store = await loadGraphStore();
    const matching = await loadMatching();
    const key = [store.graph?.builtAt ?? 0, Object.keys(store.chunkResults).length, matchingRevision, chunks.length, chunks[0]?.id ?? '', chunks.at(-1)?.id ?? ''].join('|');
    if (cache.key !== key || cache.store !== store) {
        const graph = buildGraph(store, chunks.map(c => c.id));
        cache = { key, store, index: buildRetrievalIndex(graph, chunks, matching) };
    }
    return cache.index;
}

/** Forget the cached index (after extraction, rescans or matching changes). */
export function invalidateRetrievalCache() {
    cache = { key: '', index: null };
}

/**
 * Runs retrieval for some message texts (oldest first) and builds the final prompt text.
 * @param {import('./parser.js').LoreChunk[]} chunks active chunks
 * @param {string[]} messages
 * @param {object} settings extension settings
 */
export async function runRetrieval(chunks, messages, settings) {
    const index = await getRetrievalIndex(chunks);
    const scannedMessages = messages.slice(-(settings.retrieval_messages + 1));

    // Meaning search is optional; if LM Studio is down the reply goes ahead with names only.
    let meaning = null;
    let meaningError = null;
    if (settings.embed_enabled) {
        try {
            const queryText = buildQueryText(scannedMessages);
            if (queryText) meaning = await semanticSearch(queryText, settings);
        } catch (error) {
            meaningError = String(error?.message ?? error);
            console.warn('Lore Graph: meaning search unavailable, using names only', error);
        }
    }

    const report = await retrieve(index, messages, {
        messages: settings.retrieval_messages,
        hops: settings.retrieval_hops,
        budget: settings.retrieval_budget,
    }, (text) => getTokenCountAsync(text), meaning);
    const promptText = report.text ? substituteParamsExtended(settings.inject_template || '{{text}}', { text: report.text }) : '';
    return { ...report, promptText, scannedMessages, meaningEnabled: !!settings.embed_enabled, meaningError, meaningHits: meaning };
}

export function clearInjection(settings) {
    setExtensionPrompt(PROMPT_KEY, '', settings.inject_position, settings.inject_depth, settings.inject_scan, settings.inject_role);
}

/**
 * The generation interceptor body. Never throws: a lore problem must not block a reply.
 * @param {object[]} chat the messages about to be sent (system messages already removed)
 * @param {string} type generation type
 * @param {object} settings extension settings
 * @param {() => import('./parser.js').LoreChunk[]} getChunks
 * @returns {Promise<object|null>} the retrieval report, or null if nothing ran
 */
export async function interceptGeneration(chat, type, settings, getChunks) {
    if (type === 'quiet') {
        return null; // background prompts (summaries etc.), same as Vectors
    }
    clearInjection(settings);
    if (!settings.enabled) {
        return null;
    }
    const chunks = getChunks();
    if (!chunks.length || !Array.isArray(chat)) {
        return null;
    }
    const messages = chat
        .filter(m => m && !m.is_system && typeof m.mes === 'string')
        .map(m => m.mes)
        .slice(-(settings.retrieval_messages + 1));
    const report = await runRetrieval(chunks, messages, settings);
    if (report.promptText) {
        setExtensionPrompt(PROMPT_KEY, report.promptText, settings.inject_position, settings.inject_depth, settings.inject_scan, settings.inject_role);
    }
    return { ...report, type, at: Date.now() };
}
