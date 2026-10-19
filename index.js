import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { debounce, escapeHtml } from '../../../utils.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { formatChunk } from './parser.js';
import { SCOPE_IMPORTED, SCOPE_LABELS, getActiveChunks, importFile, listCurrentSources, loadIndex, removeImport, saveIndex, scanSources } from './sources.js';
import { buildGraph, getChunkStatus } from './graph.js';
import { decideDuplicate, estimateExtractionTokens, findDuplicates, getUsableProfile, loadGraphStore, runExtraction } from './extraction.js';
import { showDuplicateReview, showGraphBrowser } from './graph-view.js';
import { DEFAULT_INJECTION_SETTINGS, clearInjection, interceptGeneration, invalidateRetrievalCache, runRetrieval } from './injection.js';
import { applyEverydayReview, findEverydayWords, loadMatching, setAliasSafe, setEntityMatchMode, setNameMatchModes } from './matching.js';
import { DEFAULT_RETRIEVAL_SETTINGS, countNameCasing, getMatchMode, getNameModes, looksCapitalisedInLore } from './retrieval.js';
import { matchForm } from './schema.js';
import { showRetrievalReport } from './report-view.js';
import { loadEmbeddingState, semanticSearch, syncEmbeddingIndex } from './embeddings.js';
import { addMessageButtons, attachPendingReport, expandRecord, getRecord, setPendingReport } from './inspector.js';
import { editTestPopup, loadTests, reviewSuggestionsPopup, runTest, saveTests, showTestList, suggestTests, summarizeRuns } from './tests.js';
import { CASUAL_LINES, pickSanityQueries, sectionKey } from './test-check.js';
import { highlightFromReport, showGraphMap } from './graph-map.js';
import { countUnprocessed, extractMemories, getMemoryState, saveMemoryState, validateMemories } from './memory.js';
import { showMemoryList } from './memory-view.js';
import { buildStoryGraph } from './memory-retrieval.js';
import { purgeMemoryVectors } from './embeddings.js';

const MODULE_NAME = 'lore_graph';
const EXTENSION_FOLDER = 'third-party/lore-graph';

// Configuration only. The graph and chunk index are stored as JSON files, never here.
const defaultSettings = {
    enabled: false,
    extraction_profile: '',
    extraction_max_tokens: 16000,
    extraction_concurrency: 3,
    extraction_timeout_seconds: 180,
    extraction_structured_output: true,
    ...DEFAULT_INJECTION_SETTINGS,
    record_injections: true,
    memory_enabled: false,
    memory_every: 6,
    memory_profile: '',
    folded: {}, // panel sections the user collapsed: { sources: true, chunks: true }
};

/** Runtime state (not saved in settings). */
const state = {
    /** @type {import('./sources.js').ChunkIndex|null} */
    index: null,
    /** @type {string[]} URLs of sources visible in the current chat */
    activeUrls: [],
    /** @type {Promise<void>|null} */
    scanning: null,
    rescanQueued: false,
    /** @type {AbortController|null} set while extraction runs */
    extraction: null,
    /** @type {object|null} what was injected before the last reply, and why */
    lastReport: null,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Fill in any keys added by newer versions without touching existing values.
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = structuredClone(value);
        }
    }
    return extension_settings[MODULE_NAME];
}

function setStatus(text) {
    $('#lore_graph_status').text(text);
}

/**
 * Rescans sources. Calls made while a scan is running are merged into one follow-up scan.
 * @param {{ quiet?: boolean }} [options]
 */
async function rescan({ quiet = false } = {}) {
    if (state.scanning) {
        state.rescanQueued = true;
        return state.scanning;
    }

    state.scanning = (async () => {
        try {
            do {
                state.rescanQueued = false;
                setStatus('Scanning lore sources…');
                if (!state.index) {
                    state.index = await loadIndex();
                }
                const { activeUrls, changed } = await scanSources(state.index);
                state.activeUrls = activeUrls;
                invalidateRetrievalCache();
                if (changed) {
                    await saveIndex(state.index);
                }
                render();
            } while (state.rescanQueued);

            const chunkCount = getActiveChunks(state.index, state.activeUrls).length;
            setStatus(`${chunkCount} chunks from ${state.activeUrls.length} source file(s). Last scan: ${new Date().toLocaleTimeString()}`);
            if (!quiet) {
                toastr.success(`${chunkCount} chunks loaded.`, 'Lore Graph');
            }
        } catch (error) {
            console.error('Lore Graph: scan failed', error);
            setStatus('Scan failed. See the browser console (F12) for details.');
            toastr.error(String(error?.message ?? error), 'Lore Graph: scan failed');
        } finally {
            state.scanning = null;
        }
    })();

    return state.scanning;
}

const rescanDebounced = debounce(() => rescan({ quiet: true }), 500);

// ---------------------------------------------------------------- rendering

function statusIcon(entry) {
    switch (entry.duplicateOf ? 'error' : entry.status) {
        case 'ok': return '<i class="fa-solid fa-circle-check lore_graph_status_ok" title="Parsed without problems"></i>';
        case 'warning': return '<i class="fa-solid fa-triangle-exclamation lore_graph_status_warning" title="Parsed with warnings"></i>';
        case 'skipped': return '<i class="fa-solid fa-circle-minus lore_graph_status_skipped" title="Skipped"></i>';
        default: return '<i class="fa-solid fa-circle-xmark lore_graph_status_error" title="Problem"></i>';
    }
}

function describeEntry(entry) {
    if (entry.duplicateOf) {
        const owner = state.index.docs[entry.duplicateOf];
        return `Not used: Doc ID ${escapeHtml(entry.docId)} is already provided by "${escapeHtml(owner?.name ?? entry.duplicateOf)}".`;
    }
    if (entry.status === 'skipped' || (entry.error && !entry.chunks.length)) {
        return escapeHtml(entry.error ?? 'Skipped.');
    }
    const parts = [`${escapeHtml(entry.docId ?? '?')}`, `${entry.chunks.length} chunks`];
    if (entry.warnings.length) {
        parts.push(`<span class="lore_graph_link lore_graph_status_warning" data-action="warnings">${entry.warnings.length} warning(s)</span>`);
    }
    if (entry.error) {
        parts.push(`<span class="lore_graph_status_error">${escapeHtml(entry.error)}</span>`);
    }
    return parts.join(' · ');
}

/** Collapsible panel sections; which ones are collapsed is remembered in the settings. */
function bindFolds() {
    const settings = getSettings();
    const apply = (name) => {
        const folded = !!settings.folded?.[name];
        $(`.lore_graph_fold_body[data-fold="${name}"]`).toggle(!folded);
        $(`.lore_graph_fold_header[data-fold="${name}"] i`).toggleClass('fa-chevron-down', !folded).toggleClass('fa-chevron-right', folded);
    };
    $('.lore_graph_fold_header').each((_, el) => apply(String($(el).data('fold'))));
    $('.lore_graph_fold_header').on('click', function () {
        const name = String($(this).data('fold'));
        settings.folded = { ...settings.folded, [name]: !settings.folded?.[name] };
        apply(name);
        saveSettingsDebounced();
    });
}

function renderSources() {
    const container = $('#lore_graph_sources').empty();
    const entries = Object.values(state.index?.docs ?? {});
    $('.lore_graph_fold_header[data-fold="sources"] .lore_graph_fold_count').text(entries.length ? `(${entries.length} file${entries.length === 1 ? '' : 's'})` : '');
    if (!entries.length) {
        container.append('<small class="lore_graph_empty">No lore files found. Add .txt lore files to the Data Bank (magic wand menu → Open Data Bank), or use Import file…, then click Rescan.</small>');
        return;
    }

    const active = new Set(state.activeUrls);
    const sorted = [...entries].sort((a, b) => Number(active.has(b.url)) - Number(active.has(a.url)) || a.name.localeCompare(b.name));

    for (const entry of sorted) {
        const isActive = active.has(entry.url);
        const row = $(`
            <div class="lore_graph_source ${isActive ? '' : 'inactive'}">
                ${statusIcon(entry)}
                <div class="lore_graph_source_main">
                    <div class="lore_graph_source_name" title="${escapeHtml(entry.title ?? entry.name)}">${escapeHtml(entry.name)}</div>
                    <div class="lore_graph_source_detail">${describeEntry(entry)}${isActive ? '' : ' · not active in this chat'}</div>
                </div>
                <span class="lore_graph_badge">${escapeHtml(SCOPE_LABELS[entry.scope] ?? entry.scope)}</span>
            </div>`);

        if (entry.scope === SCOPE_IMPORTED) {
            row.append($('<i class="fa-solid fa-trash-can menu_button" title="Remove this imported file"></i>').on('click', () => onRemoveImport(entry)));
        } else if (!isActive) {
            row.append($('<i class="fa-solid fa-eraser menu_button" title="Forget this file (it is not in the Data Bank for this chat)"></i>').on('click', () => onForget(entry)));
        }
        row.find('[data-action="warnings"]').on('click', () => showWarnings(entry));
        container.append(row);
    }
}

function renderChunks() {
    const container = $('#lore_graph_chunks').empty();
    const docs = state.activeUrls
        .map(url => state.index.docs[url])
        .filter(entry => entry && !entry.duplicateOf && entry.chunks.length);
    const chunkCount = docs.reduce((sum, entry) => sum + entry.chunks.length, 0);
    $('.lore_graph_fold_header[data-fold="chunks"] .lore_graph_fold_count').text(docs.length ? `(${chunkCount} in ${docs.length} document${docs.length === 1 ? '' : 's'})` : '');

    if (!docs.length) {
        container.append('<small class="lore_graph_empty">No chunks yet.</small>');
        return;
    }

    for (const entry of docs) {
        const totalTokens = entry.chunks.reduce((sum, c) => sum + c.tokens, 0);
        const details = $(`<details><summary>${escapeHtml(entry.docId)} — ${escapeHtml(entry.title)} <small>(${entry.chunks.length} chunks, ~${totalTokens} tokens)</small></summary></details>`);

        let currentSection = null;
        let sectionEl = null;
        for (const chunk of entry.chunks) {
            const sectionKey = `${chunk.sectionNumber}|${chunk.sectionTitle}`;
            if (sectionKey !== currentSection) {
                currentSection = sectionKey;
                sectionEl = $(`
                    <div class="lore_graph_section">
                        <div class="lore_graph_section_title">§${escapeHtml(String(chunk.sectionNumber ?? '?'))} ${escapeHtml(chunk.sectionTitle)}</div>
                        <div class="lore_graph_section_tldr">${chunk.tldr ? `TL;DR: ${escapeHtml(chunk.tldr)}` : '<span class="lore_graph_status_warning">No TL;DR</span>'}</div>
                    </div>`);
                details.append(sectionEl);
            }

            let label = chunk.subsectionTitle ?? (chunk.kind === 'intro' ? 'Intro' : 'Whole section');
            if (chunk.partCount > 1) {
                label += ` (part ${chunk.part}/${chunk.partCount})`;
            }
            const row = $(`
                <div class="lore_graph_chunk" title="${escapeHtml(chunk.id)}">
                    <span class="lore_graph_chunk_label">${escapeHtml(label)}</span>
                    ${chunk.guardrail ? '<i class="fa-solid fa-shield-halved lore_graph_status_error" title="Has a ✕ Not This guardrail"></i>' : ''}
                    <span class="lore_graph_chunk_tokens">~${chunk.tokens} t</span>
                </div>`);
            row.on('click', () => showChunk(chunk, entry));
            sectionEl.append(row);
        }
        container.append(details);
    }
}

function render() {
    renderSources();
    renderChunks();
    renderGraphSummary();
}

/** Chunks usable in the current chat, in document order. */
function getCurrentChunks() {
    return state.index ? getActiveChunks(state.index, state.activeUrls) : [];
}

function findChunk(chunkId) {
    for (const url of state.activeUrls) {
        const entry = state.index?.docs[url];
        const chunk = entry?.chunks.find(c => c.id === chunkId);
        if (chunk) return { chunk, entry };
    }
    for (const entry of Object.values(state.index?.docs ?? {})) {
        const chunk = entry.chunks.find(c => c.id === chunkId);
        if (chunk) return { chunk, entry };
    }
    return null;
}

async function renderGraphSummary() {
    const chunks = getCurrentChunks();
    let store;
    try {
        store = await loadGraphStore({ fresh: true });
    } catch (error) {
        $('#lore_graph_summary').text(error.message);
        return;
    }
    const status = getChunkStatus(store, chunks);
    const graph = buildGraph(store, chunks.map(c => c.id));
    const placeholders = graph.entities.filter(e => e.placeholder).length;

    const toDo = status.missing.length + status.changed.length;
    $('#lore_graph_summary').html(`
        ${graph.entities.length} entities (${placeholders} placeholders) · ${graph.edges.length} relations<br>
        Chunks: ${status.done.length} extracted · ${toDo} new or changed · ${status.failed.length} failed`);

    const pending = store.decisions.pending.length;
    $('#lore_graph_dupes_review').toggle(pending > 0).find('span').text(`Review suggestions (${pending})`);

    const failedBox = $('#lore_graph_failed').empty();
    if (status.failed.length) {
        failedBox.append(`<small class="lore_graph_hint">Failed chunks are retried by "Extract new &amp; changed".</small>`);
        for (const id of status.failed) {
            const result = store.chunkResults[id];
            const row = $(`
                <div class="lore_graph_row">
                    <i class="fa-solid fa-circle-xmark lore_graph_status_error"></i>
                    <span class="lore_graph_link">${escapeHtml(id)}</span>
                    <div class="lore_graph_row_sub">${escapeHtml(result.error ?? 'Unknown error')}</div>
                </div>`);
            row.find('.lore_graph_link').on('click', () => showFailure(id, result));
            failedBox.append(row);
        }
    }
}

/** Loads the latest graph file, or shows why it can't and returns null. */
async function loadStoreOrWarn() {
    try {
        return await loadGraphStore({ fresh: true });
    } catch (error) {
        toastr.error(error.message, 'Lore Graph');
        return null;
    }
}

function setExtractionRunning(running) {
    $('#lore_graph_stop').toggle(running);
    $('#lore_graph_progress').toggle(running);
    $('#lore_graph_extract, #lore_graph_extract_all, #lore_graph_dupes_find').toggleClass('disabled', running);
}

// ---------------------------------------------------------------- popups

async function showChunk(chunk, entry) {
    let result = null;
    try {
        result = (await loadGraphStore()).chunkResults[chunk.id] ?? null;
    } catch { /* the summary area already reports unreadable graph files */ }

    let extractionHtml = '<div class="lore_graph_meta">Not extracted yet.</div>';
    if (result?.status === 'failed') {
        extractionHtml = `<div class="lore_graph_status_error">Failed: ${escapeHtml(result.error ?? '')}</div>`;
    } else if (result) {
        const stale = result.hash !== chunk.hash ? ' <span class="lore_graph_status_warning">(text changed since)</span>' : '';
        extractionHtml = `
            <div class="lore_graph_meta">${escapeHtml(result.model ?? '')} · ${new Date(result.extractedAt).toLocaleString()}${stale}</div>
            <div class="lore_graph_popup_block"><b>Entities:</b> ${result.entities.map(e => escapeHtml(e.name) + (e.defined_here ? '' : '<small> (mention)</small>')).join(', ') || '(none)'}</div>
            <div class="lore_graph_popup_block"><b>Relations:</b><br>${result.relations.map(r => `${escapeHtml(r.source)} <span class="lore_graph_badge">${escapeHtml(r.type)}</span> ${escapeHtml(r.target)}`).join('<br>') || '(none)'}</div>`;
    }

    const root = $(`
        <div class="lore_graph_popup">
            <h3>${escapeHtml(chunk.id)}</h3>
            <div class="lore_graph_meta">
                ${escapeHtml(entry.name)} · lines ${chunk.lineStart}–${chunk.lineEnd} · ~${chunk.tokens} tokens · hash ${escapeHtml(chunk.hash)}
            </div>
            <h4>TL;DR</h4>
            <div class="lore_graph_popup_block">${escapeHtml(chunk.tldr || '(none)')}</div>
            <h4>Text</h4>
            <div class="lore_graph_popup_block">${escapeHtml(chunk.text || '(empty)')}</div>
            ${chunk.guardrail ? `<h4>✕ Not This (guardrail)</h4><div class="lore_graph_popup_block lore_graph_guardrail">${escapeHtml(chunk.guardrail)}</div>` : ''}
            <h4>As it will appear in the prompt</h4>
            <div class="lore_graph_popup_block lore_graph_meta">${escapeHtml(formatChunk(chunk))}</div>
            <h4>What the graph got from this chunk</h4>
            ${extractionHtml}
            <div class="menu_button menu_button_icon lore_graph_reextract_one" title="Ask the AI again for this chunk only (one request) and replace its result">
                <i class="fa-solid fa-arrows-rotate"></i><span>Re-extract this chunk</span>
            </div>
        </div>`);

    const popupPromise = callGenericPopup(root, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true });
    root.find('.lore_graph_reextract_one').on('click', async function () {
        if (state.extraction) {
            toastr.info('An extraction is already running. Wait for it to finish or click Stop.', 'Lore Graph');
            return;
        }
        let profile;
        try {
            profile = getUsableProfile(getSettings().extraction_profile);
        } catch (error) {
            toastr.warning(error.message, 'Lore Graph');
            return;
        }
        $(this).addClass('disabled').find('span').text('Re-extracting… (you can close this window)');
        await startExtraction([chunk], profile);
        $(this).removeClass('disabled').find('span').text('Done. Reopen the chunk to see the new result.');
    });
    return popupPromise;
}

function showWarnings(entry) {
    const items = entry.warnings
        .map(w => `<li>${w.line ? `<b>Line ${w.line}:</b> ` : ''}${escapeHtml(w.message)}</li>`)
        .join('');
    const html = `<div class="lore_graph_popup"><h3>Warnings for ${escapeHtml(entry.name)}</h3><ul>${items}</ul></div>`;
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true });
}

// ---------------------------------------------------------------- actions

async function onImportFiles(files) {
    if (!state.index) {
        state.index = await loadIndex();
    }
    for (const file of files) {
        try {
            await importFile(file, state.index);
            toastr.info(`Imported ${file.name}`, 'Lore Graph');
        } catch (error) {
            console.error('Lore Graph: import failed', error);
            toastr.error(String(error?.message ?? error), 'Lore Graph: import failed');
        }
    }
    await rescan();
}

/**
 * Opens a file picker. Where supported (Chrome, Edge), the browser's newer picker
 * remembers the last folder used for this button; elsewhere the plain file input is used.
 */
async function onImportClick() {
    if (typeof window.showOpenFilePicker !== 'function') {
        $('#lore_graph_import_file').trigger('click');
        return;
    }
    let handles;
    try {
        handles = await window.showOpenFilePicker({
            id: 'lore-graph-import',
            multiple: true,
            types: [{ description: 'Lore text files', accept: { 'text/plain': ['.txt'] } }],
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            return; // user closed the picker
        }
        console.warn('Lore Graph: modern file picker failed, using the standard one', error);
        $('#lore_graph_import_file').trigger('click');
        return;
    }
    const files = await Promise.all(handles.map(handle => handle.getFile()));
    if (files.length) {
        await onImportFiles(files);
    }
}

async function onRemoveImport(entry) {
    const confirmed = await callGenericPopup(`Remove the imported file "${escapeHtml(entry.name)}" and its chunks?`, POPUP_TYPE.CONFIRM);
    if (!confirmed) {
        return;
    }
    try {
        await removeImport(entry.url, state.index);
    } catch (error) {
        console.error('Lore Graph: remove failed', error);
        toastr.error(String(error?.message ?? error), 'Lore Graph');
        return;
    }
    await saveIndex(state.index);
    await rescan({ quiet: true });
}

async function onForget(entry) {
    delete state.index.docs[entry.url];
    await saveIndex(state.index);
    render();
}

async function onFileDeleted(url) {
    if (state.index?.docs[url]) {
        delete state.index.docs[url];
        await saveIndex(state.index);
        await rescan({ quiet: true });
    }
}

// ---------------------------------------------------------------- extraction

function showFailure(chunkId, result) {
    const html = `
        <div class="lore_graph_popup">
            <h3>Extraction failed: ${escapeHtml(chunkId)}</h3>
            <div class="lore_graph_meta">${escapeHtml(result.profileName ?? '')} · ${escapeHtml(result.model ?? '')} · ${new Date(result.extractedAt).toLocaleString()}</div>
            <h4>Reason</h4>
            <div class="lore_graph_popup_block">${escapeHtml(result.error ?? 'Unknown error')}</div>
            ${result.rawPreview ? `<h4>Start of the model's reply</h4><div class="lore_graph_popup_block lore_graph_meta">${escapeHtml(result.rawPreview)}</div>` : ''}
        </div>`;
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true });
}

/**
 * Shows what would be sent and lets the user pick documents. Returns the chunks to run, or null.
 * @param {import('./parser.js').LoreChunk[]} candidates
 * @param {import('./graph.js').Entity[]} entities current known entities
 * @param {object} profile
 * @param {string} title
 */
async function confirmExtraction(candidates, entities, profile, title) {
    const docIds = [...new Set(candidates.map(c => c.docId))];
    const root = $(`
        <div class="lore_graph_popup">
            <h3>${escapeHtml(title)}</h3>
            <div class="lore_graph_meta">Profile: <b>${escapeHtml(profile.name)}</b> · Model: <b>${escapeHtml(profile.model)}</b></div>
            <p>Documents to include (tip: run one document first to check quality):</p>
            <div class="flex-container">
                <div class="menu_button lore_graph_choose_all">Select all</div>
                <div class="menu_button lore_graph_choose_none">Unselect all</div>
            </div>
            <div class="lore_graph_doc_choices"></div>
            <p class="lore_graph_estimate"></p>
            <small class="lore_graph_hint">One AI call per chunk, run one after another. Progress is saved after every chunk, and you can stop at any time.</small>
        </div>`);
    const choices = root.find('.lore_graph_doc_choices');
    for (const docId of docIds) {
        const docChunks = candidates.filter(c => c.docId === docId);
        choices.append(`
            <label class="checkbox_label">
                <input type="checkbox" value="${escapeHtml(docId)}" checked />
                <span>${escapeHtml(docId)} — ${escapeHtml(docChunks[0].docTitle)} (${docChunks.length} chunks)</span>
            </label>`);
    }

    const selected = () => {
        const ids = new Set(choices.find('input:checked').map((_, el) => String($(el).val())).get());
        return candidates.filter(c => ids.has(c.docId));
    };
    const updateEstimate = async () => {
        const chunks = selected();
        const tokens = await estimateExtractionTokens(chunks, entities);
        root.find('.lore_graph_estimate').html(`<b>${chunks.length}</b> chunks · about <b>${tokens.toLocaleString()}</b> input tokens, plus the model's replies.`);
    };
    choices.on('change', 'input', updateEstimate);
    root.find('.lore_graph_choose_all').on('click', () => { choices.find('input').prop('checked', true); updateEstimate(); });
    root.find('.lore_graph_choose_none').on('click', () => { choices.find('input').prop('checked', false); updateEstimate(); });
    await updateEstimate();

    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Start extraction', cancelButton: 'Cancel', wider: true, leftAlign: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    const chunks = selected();
    return chunks.length ? chunks : null;
}

/** @param {'changed'|'all'} mode */
async function onExtract(mode) {
    if (state.extraction) return;
    const settings = getSettings();

    let profile;
    try {
        profile = getUsableProfile(settings.extraction_profile);
    } catch (error) {
        toastr.warning(error.message, 'Lore Graph');
        return;
    }

    if (state.scanning) await state.scanning;
    const chunks = getCurrentChunks();
    if (!chunks.length) {
        toastr.info('No chunks loaded. Add lore files and click Rescan first.', 'Lore Graph');
        return;
    }

    const store = await loadStoreOrWarn();
    if (!store) return;
    const status = getChunkStatus(store, chunks);
    const wanted = mode === 'all' ? new Set(chunks.map(c => c.id)) : new Set([...status.missing, ...status.changed, ...status.failed]);
    const candidates = chunks.filter(c => wanted.has(c.id));
    if (!candidates.length) {
        toastr.info('Every chunk is already extracted and unchanged.', 'Lore Graph');
        return;
    }

    const known = buildGraph(store, chunks.map(c => c.id)).entities;
    const toRun = await confirmExtraction(candidates, known, profile, mode === 'all' ? 'Re-extract everything' : 'Extract new & changed chunks');
    if (!toRun) return;

    await startExtraction(toRun, profile);
}

/**
 * Runs extraction with progress shown in the panel. Shared by the extract buttons and
 * the single-chunk "Re-extract this chunk" button.
 * @param {import('./parser.js').LoreChunk[]} toRun
 * @param {{ id: string }} profile
 */
async function startExtraction(toRun, profile) {
    const settings = getSettings();
    const chunks = getCurrentChunks();
    const controller = new AbortController();
    state.extraction = controller;
    setExtractionRunning(true);
    const statusEl = $('#lore_graph_extract_status');
    const progressEl = $('#lore_graph_progress');
    let lastSummaryDone = 0;

    try {
        const outcome = await runExtraction({
            chunks: toRun,
            contextChunkIds: chunks.map(c => c.id),
            profileId: profile.id,
            settings,
            signal: controller.signal,
            onProgress: ({ done, total, running, failed, waiting }) => {
                progressEl.attr('max', total).val(done);
                const failedText = failed ? ` · ${failed} failed` : '';
                if (waiting) {
                    statusEl.text(`Provider is refusing requests (rate/usage limit). Waiting ${waiting}s before trying again… (${done}/${total} done${failedText})`);
                } else if (running.length) {
                    statusEl.text(`${done}/${total} done${failedText} · working on: ${running.join(' · ')}`);
                }
                if (done > lastSummaryDone) {
                    lastSummaryDone = done;
                    renderGraphSummary();
                }
            },
        });

        const summary = `${outcome.done} chunk(s) processed, ${outcome.failed} failed.`;
        if (outcome.stopReason) {
            statusEl.text(`Paused. ${summary} ${outcome.stopReason}`);
            toastr.warning(outcome.stopReason, 'Lore Graph: extraction paused', { timeOut: 15000 });
        } else if (outcome.stopped) {
            statusEl.text(`Stopped. ${summary} Click "Extract new & changed" to continue.`);
        } else {
            statusEl.text(`Finished. ${summary}`);
            toastr.success(summary, 'Lore Graph: extraction finished');
        }
    } catch (error) {
        console.error('Lore Graph: extraction error', error);
        statusEl.text(`Extraction stopped by an error: ${error?.message ?? error}`);
        toastr.error(String(error?.message ?? error), 'Lore Graph: extraction error');
    } finally {
        state.extraction = null;
        setExtractionRunning(false);
        invalidateRetrievalCache();
        renderGraphSummary();
    }
}

function openChunkById(chunkId) {
    const found = findChunk(chunkId);
    if (found) showChunk(found.chunk, found.entry);
}

async function onBrowse() {
    const chunks = getCurrentChunks();
    const store = await loadStoreOrWarn();
    if (!store) return;
    const graph = buildGraph(store, chunks.map(c => c.id));
    if (!graph.entities.length) {
        toastr.info('The graph is empty. Run extraction first.', 'Lore Graph');
        return;
    }
    let matching;
    try {
        matching = await loadMatching({ fresh: true });
    } catch (error) {
        toastr.error(error.message, 'Lore Graph');
        return;
    }
    showGraphBrowser(graph, openChunkById, {
        getMode: (entity) => getMatchMode(entity, matching),
        getNameModes: (entity) => getNameModes(entity, matching),
        setMode: async (entity, mode) => {
            await setEntityMatchMode(entity, mode);
            matching = await loadMatching();
            invalidateRetrievalCache();
        },
        setNameMode: async (name, mode) => {
            await setNameMatchModes([name], mode);
            matching = await loadMatching();
            invalidateRetrievalCache();
        },
        isShort: (name) => matchForm(name).replace(/\s/g, '').length < DEFAULT_RETRIEVAL_SETTINGS.minAliasLength,
        isSafe: (name) => matching.safeAliases.includes(matchForm(name)),
        setSafe: async (name, safe) => {
            await setAliasSafe(name, safe);
            matching = await loadMatching();
            invalidateRetrievalCache();
        },
    });
}

/** The graph for the current chat's lore, or null (with a message) if there's none. */
async function getCurrentGraph() {
    const store = await loadStoreOrWarn();
    if (!store) return null;
    const graph = buildGraph(store, getCurrentChunks().map(c => c.id));
    if (!graph.entities.length) {
        toastr.info('The graph is empty. Run extraction first.', 'Lore Graph');
        return null;
    }
    return graph;
}

async function openGraphMap() {
    const graph = await getCurrentGraph();
    if (!graph) return;
    // People and places from the open chat's memories (Milestone 6c).
    const memoryState = SillyTavern.getContext().chatId ? getMemoryState() : null;
    const story = memoryState?.memories.length ? buildStoryGraph(memoryState.memories, graph.entities) : null;
    showGraphMap(graph, { onOpenChunk: openChunkById, story });
}

/** Opens the map showing what a lore report matched and the paths it followed. */
async function openMapForReport(report) {
    const graph = await getCurrentGraph();
    if (!graph) return;
    const idByName = new Map();
    for (const entity of graph.entities) {
        for (const name of [entity.name, ...entity.aliases]) {
            if (!idByName.has(name.toLowerCase())) idByName.set(name.toLowerCase(), entity.id);
        }
    }
    const highlight = highlightFromReport(report, idByName);
    if (!highlight.nodes.size) {
        toastr.info('Nothing from this report is in the current graph.', 'Lore Graph');
        return;
    }
    showGraphMap(graph, { onOpenChunk: openChunkById, highlight, title: 'Why this lore was chosen' });
}

async function onFindDuplicates() {
    if (state.extraction) return;
    const settings = getSettings();
    let profile;
    try {
        profile = getUsableProfile(settings.extraction_profile);
    } catch (error) {
        toastr.warning(error.message, 'Lore Graph');
        return;
    }
    const store = await loadStoreOrWarn();
    if (!store) return;
    const entities = buildGraph(store, getCurrentChunks().map(c => c.id)).entities;
    if (entities.length < 2) {
        toastr.info('The graph needs entities first. Run extraction.', 'Lore Graph');
        return;
    }
    const listTokens = await getTokenCountAsync(entities.map(e => `${e.name} ${e.type} ${e.aliases.join(' ')} ${e.description}`).join('\n'));
    const confirmed = await callGenericPopup(
        `<div class="lore_graph_popup"><h3>Find possible duplicates</h3><p>This makes <b>one</b> AI call with ${entities.length} entities (about ${listTokens.toLocaleString()} input tokens) using <b>${escapeHtml(profile.name)}</b>. You'll review each suggestion before anything is merged.</p></div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: 'Run', cancelButton: 'Cancel' });
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;

    const button = $('#lore_graph_dupes_find').addClass('disabled');
    $('#lore_graph_extract_status').text('Asking the AI for possible duplicates…');
    try {
        const added = await findDuplicates(entities, profile.id, settings);
        $('#lore_graph_extract_status').text(added ? `${added} new suggestion(s) to review.` : 'No new duplicates suggested.');
        await renderGraphSummary();
        if (added) await onReviewDuplicates();
    } catch (error) {
        console.error('Lore Graph: duplicate finder failed', error);
        $('#lore_graph_extract_status').text(String(error?.message ?? error));
        toastr.error(String(error?.message ?? error), 'Lore Graph');
    } finally {
        button.removeClass('disabled');
    }
}

async function onReviewDuplicates() {
    if (state.extraction) {
        // The running extraction saves the graph file and would overwrite these decisions.
        toastr.info('Review duplicates after the extraction finishes.', 'Lore Graph');
        return;
    }
    const store = await loadStoreOrWarn();
    if (!store) return;
    await showDuplicateReview([...store.decisions.pending], decideDuplicate);
    invalidateRetrievalCache();
    await renderGraphSummary();
}

// ---------------------------------------------------------------- retrieval

async function onEverydayCheck() {
    if (state.everydayRunning) {
        toastr.info('The everyday-word check is already running; progress shows under the button.', 'Lore Graph');
        return;
    }
    const settings = getSettings();
    let profile;
    try {
        profile = getUsableProfile(settings.extraction_profile);
    } catch (error) {
        toastr.warning(error.message, 'Lore Graph');
        return;
    }
    const store = await loadStoreOrWarn();
    if (!store) return;
    const entities = buildGraph(store, getCurrentChunks().map(c => c.id)).entities;
    if (!entities.length) {
        toastr.info('The graph is empty. Run extraction first.', 'Lore Graph');
        return;
    }
    const confirmed = await callGenericPopup(
        `<div class="lore_graph_popup"><h3>Check for everyday words</h3>
            <p>Some lore names are also normal words. For example "seal" can mean a <i>Warden's Seal</i> in the lore, but "a seal on a letter" has nothing to do with it, and "the Sea" can be a named place while "sea water" is not. Without this check, ordinary chat can pull in lore by accident.</p>
            <p>The AI will read your entity names (using <b>${escapeHtml(profile.name)}</b>, in a few small requests) and list the ones that are everyday words. <b>This can take a minute or two</b>; progress shows under the button.</p>
            <p>When it's done, a list appears for you to review. For each name you choose <b>Needs context</b> (only counts when a clearly lore-specific word is also in the recent messages) or <b>Capital letter only</b> (for names like "the Sea" vs "the sea"; suggested when your lore writes the name with a capital letter). Nothing changes until you click Apply.</p></div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: 'Start check', cancelButton: 'Cancel', wider: true, leftAlign: true });
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;

    const button = $('#lore_graph_everyday').addClass('disabled');
    const statusEl = $('#lore_graph_everyday_status');
    statusEl.text('Starting the check…');
    state.everydayRunning = true;
    try {
        const { suggestions, checkedForms, failedBatches, error } = await findEverydayWords(entities, profile.id, settings,
            (done, total) => statusEl.text(`Checking names: ${done} / ${total}…`));
        const rows = await buildEverydayRows(suggestions, entities);
        if (!rows.length && !checkedForms.length) {
            statusEl.text('Every name has already been checked, and no name set to "Needs context" looks capitalised in your lore. New names are checked after future extractions.');
            toastr.info('Every name has already been checked.', 'Lore Graph');
            return;
        }
        const failedNote = failedBatches ? ` ${failedBatches} batch(es) failed and will be retried next time (${error}).` : '';
        statusEl.text(`Found ${rows.length} name(s) to review among ${checkedForms.length} newly checked names. Review them in the window.${failedNote}`);
        toastr.info('The everyday-word list is ready to review.', 'Lore Graph');
        const changes = await reviewEverydayWords(rows);
        if (changes === null) {
            statusEl.text('Review cancelled. Nothing was changed; you can run the check again.');
            return;
        }
        await applyEverydayReview(changes, checkedForms);
        invalidateRetrievalCache();
        const count = (mode) => changes.filter(c => c.mode === mode).length;
        const summary = `${count('context')} name(s) set to "Needs context", ${count('capital')} to "Capital letter only", ${count('capital_strict')} to "Capital letter, strict".`;
        statusEl.text(`${summary} Change any entity in Browse graph.${failedNote}`);
        toastr.success(summary, 'Lore Graph');
    } catch (error) {
        console.error('Lore Graph: everyday-word check failed', error);
        statusEl.text(String(error?.message ?? error));
        toastr.error(String(error?.message ?? error), 'Lore Graph');
    } finally {
        state.everydayRunning = false;
        button.removeClass('disabled');
    }
}

/** Lore text used to see how names are written (titles left out: they capitalise every word). */
function loreTextsForCasing() {
    return getCurrentChunks().map(c => [c.tldr, c.text, c.guardrail].filter(Boolean).join('\n'));
}

/**
 * Review rows: the AI's new suggestions, plus names already set to "Needs context" that the
 * lore writes with a capital letter (no AI needed for those). Each row gets a suggested mode.
 */
async function buildEverydayRows(suggestions, entities) {
    const texts = loreTextsForCasing();
    const rows = suggestions.map(s => {
        const casing = countNameCasing(texts, s.name);
        const capital = s.capitalised || looksCapitalisedInLore(casing);
        return { ...s, casing, existing: false, suggested: capital ? 'capital' : 'context' };
    });
    const matching = await loadMatching({ fresh: true });
    const seen = new Set(rows.map(r => matchForm(r.name)));
    for (const entity of entities) {
        for (const { name, mode } of getNameModes(entity, matching)) {
            const form = matchForm(name);
            if (mode !== 'context' || seen.has(form)) continue;
            seen.add(form);
            const casing = countNameCasing(texts, name);
            if (looksCapitalisedInLore(casing)) rows.push({ entity, name, capitalised: false, casing, existing: true, suggested: 'capital' });
        }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lets the user pick how each suggested name should match before anything is saved.
 * @returns {Promise<{ name: string, mode: 'context'|'capital'|'capital_strict' }[]|null>} changes, or null if cancelled
 */
async function reviewEverydayWords(rows) {
    const root = $(`<div class="lore_graph_popup lore_graph_everyday_review">
        <h3>Everyday words</h3>
        <div class="lore_graph_meta"><b>Needs context</b>: the name only counts when a clearly lore-specific word is also in the recent messages.
            <b>Capital letter only</b>: written with a capital letter in the middle of a sentence ("we sailed for the Sea") it always counts; in lowercase ("sea water") it counts like Needs context. The first word of a sentence doesn't count as a capital.
            <b>Leave as is</b>: no change. Only the listed name changes; the entity's other names keep working. You can change any name later in Browse graph.</div>
        <table class="lore_graph_table"><tbody></tbody></table></div>`);
    const body = root.find('tbody');
    if (!rows.length) body.append('<tr><td><small class="lore_graph_empty">No everyday words suggested.</small></td></tr>');
    rows.forEach((row, i) => {
        const { capitalised, lowercase } = row.casing;
        const evidence = [
            row.existing ? 'Already set to Needs context.' : '',
            capitalised + lowercase ? `Your lore writes it with a capital letter ${capitalised} of ${capitalised + lowercase} times (sentence starts not counted).` : 'Not found in the lore text as written.',
            row.capitalised ? 'The AI says the capitalised form names something specific.' : '',
        ].filter(Boolean).join(' ');
        const option = (value, label) => `<option value="${value}" ${row.suggested === value ? 'selected' : ''}>${label}</option>`;
        body.append(`
            <tr>
                <td>
                    <b>${escapeHtml(row.name)}</b>${row.name !== row.entity.name ? ` <small>(another name for "${escapeHtml(row.entity.name)}")</small>` : ''} <small>${escapeHtml(row.entity.type)}</small>
                    <div class="lore_graph_row_sub">${escapeHtml(evidence)}</div>
                </td>
                <td>
                    <select class="text_pole lore_graph_everyday_mode" data-index="${i}">
                        ${option('context', 'Needs context')}${option('capital', 'Capital letter only')}${option('capital_strict', 'Capital letter, strict')}<option value="keep">Leave as is</option>
                    </select>
                </td>
            </tr>`);
    });
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Apply', cancelButton: 'Cancel', wider: true, leftAlign: true, allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return root.find('.lore_graph_everyday_mode').map((_, el) => ({ name: rows[Number($(el).data('index'))].name, mode: String($(el).val()) })).get()
        .filter(change => change.mode !== 'keep');
}

async function onTestRetrieval() {
    const text = String($('#lore_graph_test_input').val() ?? '').trim();
    if (!text) {
        toastr.info('Type a sentence to test first.', 'Lore Graph');
        return;
    }
    const chunks = getCurrentChunks();
    if (!chunks.length) {
        toastr.info('No chunks loaded. Click Rescan first.', 'Lore Graph');
        return;
    }
    try {
        // Each line counts as one message, newest last.
        const messages = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
        const report = await runRetrieval(chunks, messages, getSettings());
        state.lastTest = { text, report };
        $('#lore_graph_save_test').removeClass('disabled');
        showRetrievalReport(report, 'Test retrieval', openChunkById, openMapForReport);
    } catch (error) {
        console.error('Lore Graph: test retrieval failed', error);
        toastr.error(String(error?.message ?? error), 'Lore Graph');
    }
}

// ---------------------------------------------------------------- inspector & test list (M4)

function getChunkMap() {
    return new Map(getCurrentChunks().map(c => [c.id, c]));
}

async function onMessageLoreClick() {
    const messageId = Number($(this).closest('.mes').attr('mesid'));
    const record = getRecord(messageId);
    if (!record) {
        toastr.info('No lore record for this message. It was generated before Lore Graph recorded replies, with the extension off, or with recording turned off.', 'Lore Graph');
        return;
    }
    const report = expandRecord(record, getChunkMap(), getSettings().inject_template);
    showRetrievalReport(report, `Lore for message #${messageId}`, openChunkById, openMapForReport);
}

async function getTests() {
    if (!state.tests) {
        try {
            state.tests = await loadTests();
        } catch (error) {
            toastr.error(`Could not read the test list: ${error?.message ?? error}`, 'Lore Graph');
            return null;
        }
    }
    return state.tests;
}

function renderTestSummary() {
    const tests = state.tests;
    const el = $('#lore_graph_tests_summary');
    if (!tests) {
        el.text('');
        return;
    }
    const withRun = tests.filter(t => t.last);
    const latest = withRun.length ? Math.max(...withRun.map(t => t.last.at)) : 0;
    el.text(`${tests.length} test(s).${withRun.length ? ` Last run (${new Date(latest).toLocaleString()}): ${summarizeRuns(tests).text}.` : ' Not run yet.'}`);
}

async function runOneTest(test) {
    const chunks = getCurrentChunks();
    if (!chunks.length) {
        toastr.info('No chunks loaded. Click Rescan first.', 'Lore Graph');
        return null;
    }
    const result = await runTest(test, chunks, getSettings());
    await saveTests(state.tests);
    renderTestSummary();
    return result;
}

const testListHandlers = {
    onOpenReport: (report, title) => showRetrievalReport(report, title, openChunkById, openMapForReport),
    onRun: runOneTest,
    onEdit: async (test) => {
        const edited = await editTestPopup(test, getCurrentChunks().map(c => c.id), { title: 'Edit test' });
        if (!edited) return;
        Object.assign(test, edited);
        await saveTests(state.tests);
        renderTestSummary();
    },
    onDelete: async (test) => {
        const confirmed = await callGenericPopup(`Delete the test "${escapeHtml(test.text.slice(0, 80))}"?`, POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        const i = state.tests.indexOf(test);
        if (i !== -1) state.tests.splice(i, 1);
        await saveTests(state.tests);
        renderTestSummary();
    },
};

async function onSaveAsTest() {
    if (!state.lastTest) {
        toastr.info('Run a Test retrieval first.', 'Lore Graph');
        return;
    }
    const tests = await getTests();
    if (!tests) return;
    const injected = state.lastTest.report.chunks.filter(c => c.status === 'full' || c.status === 'tldr').map(c => c.id);
    const test = await editTestPopup({ text: state.lastTest.text, nothing: injected.length === 0 }, getCurrentChunks().map(c => c.id), { title: 'Save as test', injected });
    if (!test) return;
    tests.push(test);
    await saveTests(tests);
    renderTestSummary();
    toastr.success('Test saved.', 'Lore Graph');
}

async function onRunAllTests() {
    if (state.testsRunning) return;
    const tests = await getTests();
    if (!tests) return;
    if (!tests.length) {
        toastr.info('The test list is empty. Use "Save as test" after a Test retrieval.', 'Lore Graph');
        return;
    }
    const chunks = getCurrentChunks();
    if (!chunks.length) {
        toastr.info('No chunks loaded. Click Rescan first.', 'Lore Graph');
        return;
    }
    state.testsRunning = true;
    const button = $('#lore_graph_tests_run').addClass('disabled');
    const results = [];
    try {
        for (let i = 0; i < tests.length; i++) {
            $('#lore_graph_tests_summary').text(`Running test ${i + 1} of ${tests.length}…`);
            results.push(await runTest(tests[i], chunks, getSettings()));
        }
        await saveTests(tests);
    } catch (error) {
        console.error('Lore Graph: running tests failed', error);
        toastr.error(String(error?.message ?? error), 'Lore Graph');
    } finally {
        state.testsRunning = false;
        button.removeClass('disabled');
        renderTestSummary();
    }
    if (results.length) {
        const ran = results.filter(r => !r.skipped);
        const passed = ran.filter(r => r.pass).length;
        const skipped = results.length - ran.length;
        if (!getSettings().embed_enabled) {
            toastr.info('Meaning search is off, so tests that rely on it may fail.', 'Lore Graph');
        }
        showTestList(tests, results, testListHandlers);
        const text = `${passed} of ${ran.length} tests passed.${skipped ? ` ${skipped} skipped because their lore isn't loaded.` : ''}`;
        (passed === ran.length ? toastr.success : toastr.warning)(text, 'Lore Graph');
    }
}

async function onSuggestTests() {
    if (state.testsRunning) return;
    const tests = await getTests();
    if (!tests) return;
    const chunks = getCurrentChunks();
    if (!chunks.length) {
        toastr.info('No chunks loaded. Click Rescan first.', 'Lore Graph');
        return;
    }
    const settings = getSettings();
    let profile;
    try {
        profile = getUsableProfile(settings.extraction_profile);
    } catch (error) {
        toastr.warning(String(error?.message ?? error), 'Lore Graph');
        return;
    }
    state.testsRunning = true;
    const button = $('#lore_graph_tests_suggest').addClass('disabled');
    const statusEl = $('#lore_graph_tests_summary');
    try {
        statusEl.text(`Asking ${profile.name} for test lines (one AI call)…`);
        const suggestions = await suggestTests(chunks, tests, profile, settings);
        const rows = [];
        for (let i = 0; i < suggestions.length; i++) {
            statusEl.text(`Trying suggestion ${i + 1} of ${suggestions.length}…`);
            const s = suggestions[i];
            const result = await runTest({ text: s.text, expected: s.expected, nothing: s.kind === 'casual' }, chunks, settings);
            rows.push({ ...s, pass: result.pass, missing: result.missing, injected: result.injected });
        }
        renderTestSummary();
        const added = await reviewSuggestionsPopup(rows);
        if (added.length) {
            tests.push(...added);
            await saveTests(tests);
            toastr.success(`${added.length} test(s) added.`, 'Lore Graph');
        }
    } catch (error) {
        console.error('Lore Graph: suggesting tests failed', error);
        toastr.error(String(error?.message ?? error), 'Lore Graph');
    } finally {
        state.testsRunning = false;
        button.removeClass('disabled');
        renderTestSummary();
    }
}

async function onOpenTestList() {
    const tests = await getTests();
    if (!tests) return;
    showTestList(tests, null, testListHandlers);
}

// ---------------------------------------------------------------- chat memory (M6a)

function renderMemoryStatus(extra = '') {
    const memoryState = getMemoryState();
    const el = $('#lore_graph_mem_status');
    if (!memoryState || !SillyTavern.getContext().chatId) {
        el.text('Open a chat to use memory.');
        return;
    }
    $('#lore_graph_mem_mode').val(memoryState.mode);
    const active = memoryState.memories.filter(m => !m.superseded).length;
    const waiting = countUnprocessed();
    el.text(`${extra ? extra + ' ' : ''}${active} memories in this chat · ${waiting} new message(s) not read yet.`);
}

/**
 * Reads unprocessed messages into memories.
 * @param {{ quiet?: boolean }} [options] quiet = automatic run (no toast unless something went wrong)
 */
async function runMemory({ quiet = false } = {}) {
    if (state.memoryRunning) return;
    if (!SillyTavern.getContext().chatId) {
        if (!quiet) toastr.info('Open a chat first.', 'Lore Graph');
        return;
    }
    state.memoryRunning = true;
    const button = $('#lore_graph_mem_run').addClass('disabled');
    $('#lore_graph_mem_status').text('Reading recent messages…');
    try {
        validateMemories();
        const result = await extractMemories(getSettings());
        const summary = result.read
            ? `Read ${result.read} message(s): ${result.added} new memory(ies)${result.learned ? `, ${result.learned} "learned later"` : ''}.`
            : 'No new messages to read.';
        renderMemoryStatus(summary);
        if (!quiet) toastr.success(summary, 'Lore Graph: memory');
    } catch (error) {
        console.error('Lore Graph: making memories failed', error);
        renderMemoryStatus(`Last attempt failed: ${error?.message ?? error}`);
        toastr.warning(String(error?.message ?? error), 'Lore Graph: memory');
    } finally {
        state.memoryRunning = false;
        button.removeClass('disabled');
    }
}

function onChatHistoryChanged() {
    try {
        const removed = validateMemories();
        if (removed) toastr.info(`${removed} memory(ies) removed because their messages were deleted, edited or swiped away.`, 'Lore Graph');
        renderMemoryStatus();
    } catch (error) {
        console.error('Lore Graph: checking memories failed', error);
    }
}

function bindMemory() {
    const settings = getSettings();
    $('#lore_graph_mem_enabled').prop('checked', settings.memory_enabled).on('input', function () {
        settings.memory_enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    bindNumber('#lore_graph_mem_every', 'memory_every', { min: 1, max: 100 });
    bindNumber('#lore_graph_mem_budget', 'memory_budget', { min: 50, max: 10000 });
    $('#lore_graph_mem_inject').prop('checked', settings.memory_inject).on('input', function () {
        settings.memory_inject = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (!settings.memory_inject) clearInjection(settings);
    });
    $('#lore_graph_mem_mode').on('change', function () {
        const memoryState = getMemoryState();
        if (!memoryState) return;
        memoryState.mode = String($(this).val()) === 'narrator' ? 'narrator' : 'single';
        saveMemoryState();
    });
    $('#lore_graph_mem_run').on('click', () => runMemory());
    $('#lore_graph_mem_list').on('click', () => {
        validateMemories();
        showMemoryList(() => renderMemoryStatus());
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (_messageId, type) => {
        const current = getSettings();
        if (type === 'quiet' || !current.memory_enabled || !current.memory_every) return;
        // Run in the background once enough new messages have built up.
        setTimeout(() => {
            if (countUnprocessed() >= current.memory_every) runMemory({ quiet: true });
            else renderMemoryStatus();
        }, 500);
    });
    // A deleted chat's memory search data is removed too (its memories went with the chat).
    for (const event of [event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED]) {
        eventSource.on(event, (chatId) => {
            const current = getSettings();
            if (current.embed_model && chatId) purgeMemoryVectors(chatId, current).catch(() => { });
        });
    }
    for (const event of [event_types.MESSAGE_DELETED, event_types.MESSAGE_EDITED, event_types.MESSAGE_SWIPED, event_types.CHAT_CHANGED]) {
        eventSource.on(event, onChatHistoryChanged);
    }
    renderMemoryStatus();
}

function bindInspectorAndTests() {
    const settings = getSettings();
    $('#lore_graph_record').prop('checked', settings.record_injections).on('input', function () {
        settings.record_injections = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#lore_graph_save_test').on('click', onSaveAsTest);
    $('#lore_graph_tests_run').on('click', onRunAllTests);
    $('#lore_graph_tests_open').on('click', onOpenTestList);
    $('#lore_graph_tests_suggest').on('click', onSuggestTests);
    $(document).on('click', '.lore_graph_mes_button', onMessageLoreClick);

    addMessageButtons();
    eventSource.on(event_types.CHAT_CHANGED, addMessageButtons);
    eventSource.on(event_types.MORE_MESSAGES_LOADED, addMessageButtons);
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        try {
            if (getSettings().record_injections) attachPendingReport(Number(messageId), type, getChunkMap());
        } catch (error) {
            console.error('Lore Graph: could not attach the lore record', error);
        }
    });
    getTests().then(renderTestSummary);
}

function renderLastInjection() {
    const report = state.lastReport;
    const el = $('#lore_graph_last_summary');
    if (!report) {
        el.text('No reply generated yet in this session.');
        return;
    }
    const included = report.chunks.filter(c => c.status === 'full' || c.status === 'tldr').length;
    const sources = [...report.seeds.map(s => s.name), ...(report.meaningHits?.chunks.length ? ['meaning matches'] : [])];
    const memoryText = report.memory?.selected.length ? ` Plus ${report.memory.selected.length} story memory(ies).` : '';
    el.text(included
        ? `Last reply (${new Date(report.at).toLocaleTimeString()}): ${included} chunk(s), ${report.tokens} tokens, from ${sources.join(', ')}.${memoryText}`
        : `Last reply (${new Date(report.at).toLocaleTimeString()}): no lore injected${report.ignored.length ? ` (ignored: ${report.ignored.map(i => i.via).join(', ')})` : ''}.${memoryText}`);
}

/** Called by SillyTavern before each generation (see generate_interceptor in manifest.json). */
globalThis.loreGraph_generateInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        const report = await interceptGeneration(chat, type, getSettings(), getCurrentChunks);
        if (report) {
            state.lastReport = report;
            setPendingReport(report);
            renderLastInjection();
            console.debug('Lore Graph: injected', report);
        }
    } catch (error) {
        console.error('Lore Graph: retrieval failed; the reply continues without lore', error);
        toastr.error('Lore retrieval failed; this reply has no lore. See the browser console (F12).', 'Lore Graph', { preventDuplicates: true });
    }
};

function bindNumber(selector, key, { min, max, integer = true }) {
    const settings = getSettings();
    $(selector).val(settings[key]).on('input', function () {
        const value = Number($(this).val());
        if (Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))) {
            settings[key] = value;
            saveSettingsDebounced();
        }
    });
}

function bindRetrievalSettings() {
    const settings = getSettings();
    bindNumber('#lore_graph_ret_messages', 'retrieval_messages', { min: 0, max: 50 });
    bindNumber('#lore_graph_ret_hops', 'retrieval_hops', { min: 0, max: 4 });
    bindNumber('#lore_graph_ret_budget', 'retrieval_budget', { min: 100, max: 20000 });
    bindNumber('#lore_graph_depth', 'inject_depth', { min: 0, max: 9999 });

    // Changing where the lore goes clears the old placement so it can't linger in both places.
    const changePlacement = (apply) => {
        clearInjection(settings);
        apply();
        saveSettingsDebounced();
    };
    $(`input[name="lore_graph_position"][value="${settings.inject_position}"]`).prop('checked', true);
    $('input[name="lore_graph_position"]').on('change', function () {
        changePlacement(() => { settings.inject_position = Number($(this).val()); });
    });
    $('#lore_graph_depth').on('change', () => changePlacement(() => { }));
    $('#lore_graph_role').val(settings.inject_role).on('change', function () {
        changePlacement(() => { settings.inject_role = Number($(this).val()); });
    });
    $('#lore_graph_template').val(settings.inject_template).on('input', function () {
        settings.inject_template = String($(this).val());
        saveSettingsDebounced();
    });
    $('#lore_graph_scan').prop('checked', settings.inject_scan).on('input', function () {
        settings.inject_scan = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#lore_graph_test').on('click', onTestRetrieval);
    $('#lore_graph_last').on('click', () => {
        if (!state.lastReport) {
            toastr.info('No reply has been generated with Lore Graph enabled yet in this session.', 'Lore Graph');
            return;
        }
        showRetrievalReport(state.lastReport, 'Last injection', openChunkById, openMapForReport);
    });
    $('#lore_graph_everyday').on('click', onEverydayCheck);
    renderLastInjection();
    bindEmbeddingSettings();
    bindInspectorAndTests();
    bindMemory();
}

// ---------------------------------------------------------------- meaning search (M3b)

async function renderEmbeddingStatus() {
    const settings = getSettings();
    const el = $('#lore_graph_embed_status');
    let state = null;
    try {
        state = await loadEmbeddingState({ fresh: true });
    } catch (error) {
        el.text(`Could not read the meaning index file: ${error?.message ?? error}`);
        return;
    }
    if (!state) {
        el.text('No meaning index yet. Fill in the model name, then click "Build / update index".');
        return;
    }
    const chunkIds = new Set(getCurrentChunks().map(c => c.id));
    const indexed = new Set(Object.values(state.chunks));
    const missing = [...chunkIds].filter(id => !indexed.has(id)).length;
    let text = `Index built ${new Date(state.builtAt).toLocaleString()} with ${state.model}: ${Object.keys(state.chunks).length} chunks, ${Object.keys(state.entities).length} entities.`;
    if (state.model !== settings.embed_model) {
        text += ` ⚠ The selected model is different ("${settings.embed_model || 'none'}"). Rebuild the index to use it.`;
    } else if (missing) {
        text += ` ${missing} current chunk(s) not indexed yet; click "Build / update index".`;
    }
    el.text(text);
}

async function onBuildEmbeddingIndex() {
    if (state.embedBuilding) return;
    const settings = getSettings();
    if (!settings.embed_model) {
        toastr.warning('Enter the embedding model name first (as LM Studio shows it).', 'Lore Graph');
        return;
    }
    const chunks = getCurrentChunks();
    if (!chunks.length) {
        toastr.info('No chunks loaded. Click Rescan first.', 'Lore Graph');
        return;
    }
    const store = await loadStoreOrWarn();
    if (!store) return;
    const entities = buildGraph(store, chunks.map(c => c.id)).entities;

    const previous = await loadEmbeddingState({ fresh: true }).catch(() => null);
    if (previous && previous.model !== settings.embed_model) {
        const confirmed = await callGenericPopup(
            `<div class="lore_graph_popup"><h3>Different embedding model</h3><p>The current index was built with <b>${escapeHtml(previous.model)}</b>. Building with <b>${escapeHtml(settings.embed_model)}</b> embeds everything again (on your computer, no cost). The old index is kept, so switching back later is instant.</p></div>`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Build', cancelButton: 'Cancel' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    }

    state.embedBuilding = true;
    const button = $('#lore_graph_embed_build').addClass('disabled');
    const statusEl = $('#lore_graph_embed_status');
    statusEl.text('Checking what needs embedding…');
    try {
        const result = await syncEmbeddingIndex(chunks, entities, settings,
            (stage, done, total) => statusEl.text(`Embedding ${stage}: ${done} / ${total}…`));
        invalidateRetrievalCache();
        toastr.success(`Chunks: ${result.chunks.added} added, ${result.chunks.removed} removed. Entities: ${result.entities.added} added, ${result.entities.removed} removed.`, 'Lore Graph: meaning index updated');
        await renderEmbeddingStatus();
    } catch (error) {
        console.error('Lore Graph: building the meaning index failed', error);
        statusEl.text(String(error?.message ?? error));
        toastr.error(String(error?.message ?? error), 'Lore Graph');
    } finally {
        state.embedBuilding = false;
        button.removeClass('disabled');
    }
}

/**
 * Meaning-search sanity check, built from the loaded lore so it works for any setting: each
 * picked section's TL;DR should find that section near the top, and casual chat should find
 * nothing above the threshold. Random-looking rankings point at a broken model file.
 */
async function onEmbeddingSanityCheck() {
    const settings = getSettings();
    const chunks = getCurrentChunks();
    if (!chunks.length) {
        toastr.info('No chunks loaded. Click Rescan first.', 'Lore Graph');
        return;
    }
    const button = $('#lore_graph_embed_check').addClass('disabled');
    try {
        const sectionOf = new Map(chunks.map(c => [c.id, sectionKey(c)]));
        const rows = [];
        let found = 0;
        const queries = pickSanityQueries(chunks);
        for (const { query, section, label } of queries) {
            const wide = await semanticSearch(query, settings, { topK: 5, threshold: 0 });
            const used = await semanticSearch(query, settings);
            const usedIds = new Set(used.chunks.map(c => c.id));
            const ok = wide.chunks.some(c => sectionOf.get(c.id) === section);
            if (ok) found++;
            rows.push(`
                <h4>${ok ? '✅' : '⚠'} ${escapeHtml(label)}</h4>
                <div class="lore_graph_meta">Searched for its summary: "${escapeHtml(query)}"</div>
                <ol>${wide.chunks.map(c => `<li>${sectionOf.get(c.id) === section ? '<b>' : ''}${escapeHtml(c.id)}${sectionOf.get(c.id) === section ? '</b>' : ''}${usedIds.has(c.id) ? ' <small>(above threshold, would be used)</small>' : ' <small>(below threshold)</small>'}</li>`).join('')}</ol>`);
        }
        let casualOk = 0;
        for (const line of CASUAL_LINES) {
            const used = await semanticSearch(line, settings);
            const ok = used.chunks.length === 0;
            if (ok) casualOk++;
            rows.push(`
                <h4>${ok ? '✅' : '⚠'} Casual chat: "${escapeHtml(line)}"</h4>
                <div class="lore_graph_meta">${ok ? 'Nothing above the threshold, as expected.' : `Above the threshold: ${used.chunks.map(c => escapeHtml(c.id)).join(', ')}`}</div>`);
        }
        const summaryOk = found === queries.length;
        const advice = [
            !summaryOk ? (found >= queries.length / 2
                ? 'Most sections found themselves. A miss or two is normal for sections whose summary is very general.'
                : 'Many sections did not find themselves. If the rankings look random, the model file may have a pooling problem: try a different GGUF of the model (for example the official upload) and rebuild the index.') : '',
            casualOk < CASUAL_LINES.length ? 'Casual chat matched lore: raise the similarity threshold a little.' : '',
        ].filter(Boolean).join(' ');
        callGenericPopup(`<div class="lore_graph_popup lore_graph_sanity"><h3>Meaning search sanity check</h3>
            <div class="lore_graph_meta">${found} of ${queries.length} sections found their own summary in the top 5 · casual chat: ${casualOk} of ${CASUAL_LINES.length} matched nothing. ${advice || 'All checks look right.'}</div>
            ${rows.join('')}</div>`, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true });
    } catch (error) {
        console.error('Lore Graph: sanity check failed', error);
        toastr.error(String(error?.message ?? error), 'Lore Graph');
    } finally {
        button.removeClass('disabled');
    }
}

function bindEmbeddingSettings() {
    const settings = getSettings();
    const changed = () => {
        saveSettingsDebounced();
        invalidateRetrievalCache();
        renderEmbeddingStatus();
    };
    $('#lore_graph_embed_enabled').prop('checked', settings.embed_enabled).on('input', function () {
        settings.embed_enabled = !!$(this).prop('checked');
        changed();
    });
    $('#lore_graph_embed_url').val(settings.embed_url).on('change', function () {
        settings.embed_url = String($(this).val()).trim().replace(/\/+$/, '');
        changed();
    });
    $('#lore_graph_embed_model').val(settings.embed_model).on('change', function () {
        settings.embed_model = String($(this).val()).trim();
        changed();
    });
    bindNumber('#lore_graph_embed_top_k', 'embed_top_k', { min: 1, max: 20 });
    bindNumber('#lore_graph_embed_threshold', 'embed_threshold', { min: 0, max: 1, integer: false });
    $('#lore_graph_embed_build').on('click', onBuildEmbeddingIndex);
    $('#lore_graph_embed_check').on('click', onEmbeddingSanityCheck);
    renderEmbeddingStatus();
}

// ---------------------------------------------------------------- init

export async function init() {
    const settings = getSettings();

    const html = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    $('#extensions_settings2').append(html);
    bindFolds();

    $('#lore_graph_enabled').prop('checked', settings.enabled).on('input', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (settings.enabled) {
            rescan({ quiet: true });
        } else {
            clearInjection(settings);
        }
    });

    $('#lore_graph_rescan').on('click', () => rescan());
    $('#lore_graph_import').on('click', onImportClick);
    $('#lore_graph_import_file').on('change', async function () {
        const files = Array.from(this.files ?? []);
        this.value = '';
        if (files.length) {
            await onImportFiles(files);
        }
    });

    try {
        ConnectionManagerRequestService.handleDropdown('#lore_graph_profile', settings.extraction_profile, (profile) => {
            settings.extraction_profile = profile?.id ?? '';
            saveSettingsDebounced();
        });
    } catch (error) {
        console.warn('Lore Graph: Connection Manager unavailable', error);
        $('#lore_graph_profile').replaceWith('<small class="lore_graph_status_error">The Connection Manager extension is disabled. Enable it to run extraction.</small>');
    }
    $('#lore_graph_max_tokens').val(settings.extraction_max_tokens).on('input', function () {
        const value = Number($(this).val());
        if (Number.isFinite(value) && value >= 500) {
            settings.extraction_max_tokens = Math.round(value);
            saveSettingsDebounced();
        }
    });
    $('#lore_graph_concurrency').val(settings.extraction_concurrency).on('input', function () {
        const value = Number($(this).val());
        if (Number.isInteger(value) && value >= 1 && value <= 8) {
            settings.extraction_concurrency = value;
            saveSettingsDebounced();
        }
    });
    $('#lore_graph_timeout').val(settings.extraction_timeout_seconds).on('input', function () {
        const value = Number($(this).val());
        if (Number.isFinite(value) && value >= 0) {
            settings.extraction_timeout_seconds = Math.round(value);
            saveSettingsDebounced();
        }
    });
    $('#lore_graph_structured').prop('checked', settings.extraction_structured_output).on('input', function () {
        settings.extraction_structured_output = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#lore_graph_extract').on('click', () => onExtract('changed'));
    $('#lore_graph_extract_all').on('click', () => onExtract('all'));
    $('#lore_graph_stop').on('click', () => state.extraction?.abort());
    $('#lore_graph_browse').on('click', onBrowse);
    $('#lore_graph_map').on('click', openGraphMap);
    $('#lore_graph_dupes_find').on('click', onFindDuplicates);
    $('#lore_graph_dupes_review').on('click', onReviewDuplicates);
    bindRetrievalSettings();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (getSettings().enabled) {
            rescanDebounced();
        }
    });
    eventSource.on(event_types.FILE_ATTACHMENT_DELETED, onFileDeleted);

    // Show what's saved right away; scan automatically only when enabled.
    try {
        state.index = await loadIndex();
    } catch (error) {
        console.error('Lore Graph: could not load index', error);
    }
    if (state.index) {
        state.activeUrls = listCurrentSources(state.index).map(x => x.url);
        render();
    }
    if (settings.enabled) {
        rescan({ quiet: true });
    } else {
        setStatus('Extension is disabled. Click Rescan to load lore anyway.');
    }

    console.log('Lore Graph: loaded');
}
