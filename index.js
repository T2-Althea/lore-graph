import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { debounce, escapeHtml } from '../../../utils.js';
import { formatChunk } from './parser.js';
import { SCOPE_IMPORTED, SCOPE_LABELS, getActiveChunks, importFile, listCurrentSources, loadIndex, removeImport, saveIndex, scanSources } from './sources.js';

const MODULE_NAME = 'lore_graph';
const EXTENSION_FOLDER = 'third-party/lore-graph';

// Configuration only. The graph and chunk index are stored as JSON files, never here.
const defaultSettings = {
    enabled: false,
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
}

// ---------------------------------------------------------------- popups

function showChunk(chunk, entry) {
    const html = `
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
        </div>`;
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true });
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

async function onRemoveImport(entry) {
    const confirmed = await callGenericPopup(`Remove the imported file "${escapeHtml(entry.name)}" and its chunks?`, POPUP_TYPE.CONFIRM);
    if (!confirmed) {
        return;
    }
    await removeImport(entry.url, state.index);
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
    $('#lore_graph_import').on('click', () => $('#lore_graph_import_file').trigger('click'));
    $('#lore_graph_import_file').on('change', async function () {
        const files = Array.from(this.files ?? []);
        this.value = '';
        if (files.length) {
            await onImportFiles(files);
        }
    });

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
