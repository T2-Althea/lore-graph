// Graph snapshots: saved copies of the extraction results and name settings, so a bad
// re-extraction or an experiment can always be undone. Also export/import of the same
// format as a file, and clearing the graph.
//
// A snapshot holds chunkResults + decisions (the graph itself is rebuilt from them) and the
// matching settings (name modes, safe names, pinned/blocked sections). Meaning-search vectors
// aren't included: they're rebuilt from the lore text for free.

import { normalizeStore } from './graph.js';
import { loadGraphStore, saveGraphStore } from './extraction.js';
import { loadMatching, replaceMatching } from './matching.js';
import { FILE_PREFIX, deleteFile, getFileUrl, loadJsonFile, saveJsonFile } from './storage.js';

export const SNAPSHOT_LIST_FILE = `${FILE_PREFIX}snapshots.json`;
const SNAPSHOT_KIND = 'lore-graph-snapshot';
const SNAPSHOT_VERSION = 1;
/** Automatic snapshots (before restores, clears and full re-extractions) kept; older ones are deleted. */
const AUTO_KEEP = 5;

/**
 * @typedef {object} SnapshotInfo
 * @property {string} id
 * @property {string} name
 * @property {number} createdAt
 * @property {boolean} auto made automatically before a risky action
 * @property {string} file file name in the user's files folder
 * @property {{ sections: number, failed: number, documents: number, entities: number, names: number }} stats
 */

/** The document part of a chunk id ("COS-006 §7 The Rank Plate" -> "COS-006"). */
const docOf = (chunkId) => String(chunkId).split(' §')[0];

/** Counts shown in the snapshot list. */
export function describeSnapshotData(chunkResults, matching, entities = null) {
    const results = Object.entries(chunkResults ?? {});
    return {
        sections: results.length,
        failed: results.filter(([, r]) => r?.status === 'failed').length,
        documents: new Set(results.map(([id]) => docOf(id))).size,
        entities: entities ?? new Set(results.flatMap(([, r]) => (r?.entities ?? []).map(e => String(e.name).toLowerCase()))).size,
        names: Object.keys(matching?.modes ?? {}).length,
    };
}

/** @returns {Promise<SnapshotInfo[]>} newest first */
export async function listSnapshots() {
    const data = await loadJsonFile(SNAPSHOT_LIST_FILE);
    const list = Array.isArray(data?.snapshots) ? data.snapshots : [];
    return list.filter(s => s && s.id && s.file).sort((a, b) => b.createdAt - a.createdAt);
}

async function saveList(list) {
    await saveJsonFile(SNAPSHOT_LIST_FILE, { snapshots: list });
}

/**
 * Checks that some parsed JSON is a snapshot this version can read. Throws a plain-language error.
 * @param {any} data
 */
export function validateSnapshotData(data) {
    if (!data || typeof data !== 'object' || data.kind !== SNAPSHOT_KIND) {
        throw new Error('This file is not a Lore Graph snapshot or export.');
    }
    if (Number(data.version) > SNAPSHOT_VERSION) {
        throw new Error('This snapshot was made by a newer version of Lore Graph. Update the extension first.');
    }
    if (!data.chunkResults || typeof data.chunkResults !== 'object' || Array.isArray(data.chunkResults)) {
        throw new Error('The snapshot has no extraction results in it.');
    }
    return data;
}

/** The current graph and name settings, in snapshot form. */
export async function captureCurrent(name) {
    const store = await loadGraphStore({ fresh: true });
    const matching = await loadMatching({ fresh: true });
    return {
        kind: SNAPSHOT_KIND,
        version: SNAPSHOT_VERSION,
        name,
        createdAt: Date.now(),
        chunkResults: store.chunkResults,
        decisions: store.decisions,
        matching,
    };
}

/**
 * Stores snapshot data as a file and adds it to the list.
 * @param {object} data snapshot data (from captureCurrent or an imported file)
 * @param {{ auto?: boolean }} [options]
 * @returns {Promise<SnapshotInfo>}
 */
async function storeSnapshot(data, { auto = false } = {}) {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const file = `${FILE_PREFIX}snapshot_${id}.json`;
    await saveJsonFile(file, data);
    const info = {
        id,
        name: String(data.name || 'Snapshot').slice(0, 120),
        createdAt: Date.now(),
        auto,
        file,
        stats: describeSnapshotData(data.chunkResults, data.matching),
    };
    let list = await listSnapshots();
    list.unshift(info);
    // Keep only the newest automatic snapshots; the user's own are never deleted automatically.
    const autos = list.filter(s => s.auto);
    for (const old of autos.slice(AUTO_KEEP)) {
        try { await deleteFile(getFileUrl(old.file)); } catch { /* already gone */ }
        list = list.filter(s => s !== old);
    }
    await saveList(list);
    return info;
}

/**
 * Saves the current graph and name settings as a snapshot.
 * @param {string} name
 * @param {{ auto?: boolean }} [options]
 */
export async function createSnapshot(name, options = {}) {
    return await storeSnapshot(await captureCurrent(name), options);
}

/** Reads a snapshot's data. */
export async function readSnapshot(info) {
    const data = await loadJsonFile(info.file);
    if (data === null) throw new Error(`The snapshot file for "${info.name}" is missing.`);
    return validateSnapshotData(data);
}

/**
 * Replaces the current graph and name settings with a snapshot's. The current state is
 * saved as an automatic "Before restore" snapshot first, so nothing is ever lost.
 * @param {SnapshotInfo} info
 */
export async function restoreSnapshot(info) {
    const data = await readSnapshot(info);
    await createSnapshot(`Before restoring "${info.name}"`, { auto: true });
    await applySnapshotData(data);
}

async function applySnapshotData(data) {
    const store = normalizeStore({ chunkResults: data.chunkResults, decisions: data.decisions });
    await saveGraphStore(store);
    await loadGraphStore({ fresh: true });
    if (data.matching && typeof data.matching === 'object') {
        await replaceMatching(data.matching);
    }
}

/** @param {SnapshotInfo} info */
export async function deleteSnapshot(info) {
    try { await deleteFile(getFileUrl(info.file)); } catch { /* already gone */ }
    const list = (await listSnapshots()).filter(s => s.id !== info.id);
    await saveList(list);
}

/** Renames a snapshot (the user's label only). */
export async function renameSnapshot(info, name) {
    const list = await listSnapshots();
    const entry = list.find(s => s.id === info.id);
    if (entry) {
        entry.name = String(name).slice(0, 120);
        entry.auto = false; // a renamed automatic snapshot is one the user wants to keep
        await saveList(list);
    }
}

/**
 * Adds an exported file as a new snapshot (it is not applied until the user restores it).
 * @param {string} text the file's text
 * @param {string} fileName
 */
export async function importSnapshotText(text, fileName) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`"${fileName}" isn't valid JSON, so it can't be a Lore Graph export.`);
    }
    validateSnapshotData(data);
    return await storeSnapshot({ ...data, name: data.name ? `${data.name} (imported)` : fileName });
}

/** Clears extraction results. */
export async function clearResults(shouldClear) {
    const store = await loadGraphStore({ fresh: true });
    const removed = Object.keys(store.chunkResults).filter(id => shouldClear(id));
    for (const id of removed) delete store.chunkResults[id];
    store.decisions.pending = [];
    await saveGraphStore(store);
    await loadGraphStore({ fresh: true });
    return removed.length;
}
