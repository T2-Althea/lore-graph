// Finds lore files (Data Bank + manual imports), parses them, and keeps the chunk index.

import { getDataBankAttachmentsForSource } from '../../../chats.js';
import { getStringHash } from '../../../utils.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { PARSER_VERSION, looksLikeLoreDocument, parseLoreDocument } from './parser.js';
import { CHUNK_INDEX_FILE, FILE_PREFIX, deleteFile, loadJsonFile, loadTextFile, saveJsonFile, saveTextFile, toSafeFileName } from './storage.js';

export const INDEX_VERSION = 1;

/** Data Bank scopes, in priority order (an earlier scope wins a Doc ID clash). */
const DATA_BANK_SCOPES = ['global', 'character', 'chat'];
export const SCOPE_IMPORTED = 'imported';

export const SCOPE_LABELS = {
    global: 'Global',
    character: 'Character',
    chat: 'Chat',
    imported: 'Imported',
};

/**
 * @typedef {object} SourceEntry
 * @property {string} url
 * @property {string} name
 * @property {string} scope global | character | chat | imported
 * @property {'ok'|'warning'|'error'|'skipped'} status
 * @property {string} [docId]
 * @property {string} [title]
 * @property {number} [textHash]
 * @property {number} [parserVersion]
 * @property {number} [parsedAt]
 * @property {import('./parser.js').LoreChunk[]} chunks
 * @property {import('./parser.js').ParseWarning[]} warnings
 * @property {string|null} error
 * @property {string|null} [duplicateOf] url of the source that already provides this Doc ID
 */

/**
 * @typedef {object} ChunkIndex
 * @property {number} version
 * @property {Record<string, SourceEntry>} docs keyed by file URL
 */

/** @returns {ChunkIndex} */
function createEmptyIndex() {
    return { version: INDEX_VERSION, docs: {} };
}

/** @returns {Promise<ChunkIndex>} */
export async function loadIndex() {
    try {
        const data = await loadJsonFile(CHUNK_INDEX_FILE);
        if (data && typeof data === 'object' && data.docs) {
            return data;
        }
    } catch (error) {
        console.error('Lore Graph: could not read the chunk index, starting a new one', error);
        toastr.warning('The saved chunk index could not be read. It will be rebuilt.', 'Lore Graph');
    }
    return createEmptyIndex();
}

/** @param {ChunkIndex} index */
export async function saveIndex(index) {
    await saveJsonFile(CHUNK_INDEX_FILE, index);
}

/**
 * Lists the lore sources visible right now: Data Bank files for the current
 * character/chat (disabled ones excluded) plus imported files.
 * @param {ChunkIndex} index
 * @returns {{ url: string, name: string, scope: string }[]}
 */
export function listCurrentSources(index) {
    const sources = [];
    const seen = new Set();
    for (const scope of DATA_BANK_SCOPES) {
        for (const file of getDataBankAttachmentsForSource(scope, false)) {
            if (!seen.has(file.url)) {
                seen.add(file.url);
                sources.push({ url: file.url, name: file.name, scope });
            }
        }
    }
    for (const entry of Object.values(index.docs)) {
        if (entry.scope === SCOPE_IMPORTED && !seen.has(entry.url)) {
            seen.add(entry.url);
            sources.push({ url: entry.url, name: entry.name, scope: SCOPE_IMPORTED });
        }
    }
    return sources;
}

/**
 * Reads, and if needed parses, one source. Unchanged files keep their existing entry.
 * @param {{ url: string, name: string, scope: string }} source
 * @param {SourceEntry|undefined} existing
 * @returns {Promise<{ entry: SourceEntry, changed: boolean }>}
 */
async function processSource(source, existing) {
    const base = { url: source.url, name: source.name, scope: source.scope, chunks: [], warnings: [], error: null, duplicateOf: null };

    let text;
    try {
        text = await loadTextFile(source.url);
    } catch (error) {
        console.error(`Lore Graph: could not read ${source.name}`, error);
        text = null;
    }
    if (text === null) {
        // Keep previously parsed chunks if we have them; just report the problem.
        const entry = { ...(existing ?? base), ...source, status: 'error', error: `Could not read the file "${source.name}".` };
        return { entry, changed: true };
    }

    const textHash = getStringHash(text);
    if (existing && existing.textHash === textHash && existing.parserVersion === PARSER_VERSION && existing.status !== 'error') {
        const changed = existing.name !== source.name || existing.scope !== source.scope;
        return { entry: { ...existing, name: source.name, scope: source.scope }, changed };
    }

    if (!looksLikeLoreDocument(text)) {
        return {
            entry: { ...base, status: 'skipped', textHash, parserVersion: PARSER_VERSION, parsedAt: Date.now(), error: 'Not a lore file (no "Doc ID:" line near the top).' },
            changed: true,
        };
    }

    const parsed = await parseLoreDocument(text, {
        fileName: source.name,
        countTokens: (str) => getTokenCountAsync(str),
        hash: (str) => getStringHash(str),
    });

    for (const warning of parsed.warnings) {
        console.warn(`Lore Graph: ${source.name}${warning.line ? ` line ${warning.line}` : ''}: ${warning.message}`);
    }
    if (parsed.error) {
        console.error(`Lore Graph: ${parsed.error}`);
    }

    /** @type {SourceEntry} */
    const entry = {
        ...base,
        status: parsed.error ? 'error' : (parsed.warnings.length ? 'warning' : 'ok'),
        docId: parsed.docId,
        title: parsed.title,
        textHash,
        parserVersion: PARSER_VERSION,
        parsedAt: Date.now(),
        chunks: parsed.chunks,
        warnings: parsed.warnings,
        error: parsed.error,
    };
    return { entry, changed: true };
}

/**
 * Marks sources whose Doc ID is already provided by an earlier active source.
 * @param {ChunkIndex} index
 * @param {string[]} activeUrls in priority order
 */
function markDuplicates(index, activeUrls) {
    const owners = new Map();
    for (const url of activeUrls) {
        const entry = index.docs[url];
        if (!entry || !entry.docId || entry.status === 'skipped' || entry.error) {
            continue;
        }
        const owner = owners.get(entry.docId);
        if (owner) {
            entry.duplicateOf = owner;
        } else {
            entry.duplicateOf = null;
            owners.set(entry.docId, url);
        }
    }
}

/**
 * Scans all current sources, parsing new or changed ones.
 * @param {ChunkIndex} index modified in place
 * @returns {Promise<{ activeUrls: string[], changed: boolean }>}
 */
export async function scanSources(index) {
    const sources = listCurrentSources(index);
    let changed = false;

    for (const source of sources) {
        const result = await processSource(source, index.docs[source.url]);
        index.docs[source.url] = result.entry;
        changed = changed || result.changed;
    }

    const activeUrls = sources.map(x => x.url);
    const before = JSON.stringify(Object.values(index.docs).map(x => x.duplicateOf ?? null));
    markDuplicates(index, activeUrls);
    changed = changed || before !== JSON.stringify(Object.values(index.docs).map(x => x.duplicateOf ?? null));

    return { activeUrls, changed };
}

/**
 * Chunks that are usable right now: active sources, not skipped, not duplicates.
 * @param {ChunkIndex} index
 * @param {string[]} activeUrls
 * @returns {import('./parser.js').LoreChunk[]}
 */
export function getActiveChunks(index, activeUrls) {
    return activeUrls
        .map(url => index.docs[url])
        .filter(entry => entry && !entry.duplicateOf && entry.status !== 'skipped')
        .flatMap(entry => entry.chunks);
}

/**
 * Saves a copy of a user-picked file into the extension's own storage.
 * @param {File} file
 * @param {ChunkIndex} index modified in place
 * @returns {Promise<string>} URL of the stored copy
 */
export async function importFile(file, index) {
    const text = await file.text();
    if (!looksLikeLoreDocument(text)) {
        throw new Error(`"${file.name}" doesn't look like a lore file (no "Doc ID:" line near the top).`);
    }
    const baseName = toSafeFileName(file.name.replace(/\.[^.]+$/, ''));
    const fileName = `${FILE_PREFIX}import_${baseName}_${Date.now()}.txt`;
    const url = await saveTextFile(fileName, text);
    index.docs[url] = { url, name: file.name, scope: SCOPE_IMPORTED, status: 'ok', chunks: [], warnings: [], error: null };
    return url;
}

/**
 * Deletes an imported file's stored copy and forgets it.
 * @param {string} url
 * @param {ChunkIndex} index modified in place
 */
export async function removeImport(url, index) {
    const entry = index.docs[url];
    if (entry?.scope !== SCOPE_IMPORTED) {
        return;
    }
    await deleteFile(url);
    delete index.docs[url];
}
