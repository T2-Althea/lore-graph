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

function renderSources() {
    const container = $('#lore_graph_sources').empty();
    const entries = Object.values(state.index?.docs ?? {});
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
        renderGraphSummary();
    }
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
    showGraphBrowser(graph, (chunkId) => {
        const found = findChunk(chunkId);
        if (found) showChunk(found.chunk, found.entry);
    });
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
    const store = await loadStoreOrWarn();
    if (!store) return;
    await showDuplicateReview([...store.decisions.pending], decideDuplicate);
    await renderGraphSummary();
}

// ---------------------------------------------------------------- init

export async function init() {
    const settings = getSettings();

    const html = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    $('#extensions_settings2').append(html);

    $('#lore_graph_enabled').prop('checked', settings.enabled).on('input', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (settings.enabled) {
            rescan({ quiet: true });
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
    $('#lore_graph_dupes_find').on('click', onFindDuplicates);
    $('#lore_graph_dupes_review').on('click', onReviewDuplicates);

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
