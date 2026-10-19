// The "Snapshots & cleanup" window: save, restore, export, import and delete graph snapshots,
// and clear extraction results. Every risky action saves an automatic snapshot first.

import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { download, escapeHtml } from '../../../utils.js';
import { captureCurrent, clearResults, createSnapshot, deleteSnapshot, importSnapshotText, listSnapshots, readSnapshot, renameSnapshot, restoreSnapshot } from './snapshots.js';
import { toSafeFileName } from './storage.js';

const formatDate = (time) => new Date(time).toLocaleString();
const statsText = (s) => `${s.sections} section result(s) from ${s.documents} document(s)${s.failed ? `, ${s.failed} failed` : ''} · ~${s.entities} entities · ${s.names} name setting(s)`;

async function confirm(html) {
    return (await callGenericPopup(html, POPUP_TYPE.CONFIRM)) === POPUP_RESULT.AFFIRMATIVE;
}

function exportData(data) {
    const stamp = new Date(data.createdAt ?? Date.now()).toISOString().slice(0, 10);
    download(JSON.stringify(data), `lore-graph_${toSafeFileName(data.name || 'export')}_${stamp}.json`, 'application/json');
}

/**
 * @param {object} options
 * @param {() => boolean} options.isBusy true while an extraction is running (changes are blocked)
 * @param {() => string[]} options.knownChunkIds every chunk id of every lore file the extension knows
 * @param {() => Promise<void>} options.onChanged called after the graph or name settings changed
 */
export async function showSnapshotWindow({ isBusy, knownChunkIds, onChanged }) {
    const root = $(`
        <div class="lore_graph_popup lore_graph_snapshots">
            <h3>Snapshots &amp; cleanup</h3>
            <div class="lore_graph_meta">A snapshot is a saved copy of the graph's extraction results and your name settings (Always, Needs context, Capital letter…, pinned and blocked sections). Restore one to undo a bad re-extraction or go back to an earlier version. Automatic snapshots are made before every restore, clear and "Re-extract everything"; the last 5 are kept.</div>
            <div class="flex-container">
                <div class="menu_button menu_button_icon lore_graph_snap_save"><i class="fa-solid fa-camera"></i><span>Save snapshot now</span></div>
                <div class="menu_button menu_button_icon lore_graph_snap_export_current"><i class="fa-solid fa-file-export"></i><span>Export current graph</span></div>
                <div class="menu_button menu_button_icon lore_graph_snap_import"><i class="fa-solid fa-file-import"></i><span>Import a file</span></div>
                <input type="file" class="lore_graph_snap_file" accept=".json,application/json" hidden />
            </div>
            <div class="flex-container">
                <div class="menu_button menu_button_icon lore_graph_snap_clear_orphans" title="Results for sections that no longer exist in any lore file the extension knows about"><i class="fa-solid fa-broom"></i><span>Clear results of removed files</span></div>
                <div class="menu_button menu_button_icon lore_graph_snap_clear_all"><i class="fa-solid fa-trash-can"></i><span>Clear the whole graph</span></div>
            </div>
            <div class="lore_graph_snap_list"></div>
        </div>`);

    const list = root.find('.lore_graph_snap_list');
    const blocked = () => {
        if (!isBusy()) return false;
        toastr.info('An extraction is running. Wait for it to finish or click Stop first.', 'Lore Graph');
        return true;
    };

    async function renderList() {
        list.html('<div class="lore_graph_meta">Loading…</div>');
        let snapshots;
        try {
            snapshots = await listSnapshots();
        } catch (error) {
            list.html(`<div class="lore_graph_status_error">${escapeHtml(error.message)}</div>`);
            return;
        }
        list.empty();
        if (!snapshots.length) {
            list.append('<div class="lore_graph_meta">No snapshots yet.</div>');
            return;
        }
        for (const info of snapshots) {
            const row = $(`
                <div class="lore_graph_row lore_graph_snap_row">
                    <b>${escapeHtml(info.name)}</b>${info.auto ? ' <span class="lore_graph_badge" title="Made automatically; only the newest 5 are kept. Rename it to keep it.">auto</span>' : ''}
                    <div class="lore_graph_row_sub">${escapeHtml(formatDate(info.createdAt))} · ${escapeHtml(statsText(info.stats))}</div>
                    <div class="flex-container">
                        <div class="menu_button menu_button_icon" data-act="restore"><i class="fa-solid fa-clock-rotate-left"></i><span>Restore</span></div>
                        <div class="menu_button menu_button_icon" data-act="export"><i class="fa-solid fa-download"></i><span>Export</span></div>
                        <div class="menu_button menu_button_icon" data-act="rename"><i class="fa-solid fa-pen"></i><span>Rename</span></div>
                        <div class="menu_button menu_button_icon" data-act="delete"><i class="fa-solid fa-trash"></i><span>Delete</span></div>
                    </div>
                </div>`);
            row.on('click', '[data-act]', async function () {
                const act = $(this).data('act');
                try {
                    if (act === 'restore') {
                        if (blocked()) return;
                        if (!await confirm(`<h3>Restore "${escapeHtml(info.name)}"?</h3><p>The current graph and name settings are replaced by this snapshot's. The current state is saved as an automatic snapshot first, so you can come back to it.</p>`)) return;
                        await restoreSnapshot(info);
                        await onChanged();
                        toastr.success(`Restored "${info.name}".`, 'Lore Graph');
                    } else if (act === 'export') {
                        exportData(await readSnapshot(info));
                    } else if (act === 'rename') {
                        const name = await callGenericPopup('New name for this snapshot:', POPUP_TYPE.INPUT, info.name);
                        if (!name || !String(name).trim()) return;
                        await renameSnapshot(info, String(name).trim());
                    } else if (act === 'delete') {
                        if (!await confirm(`<h3>Delete "${escapeHtml(info.name)}"?</h3><p>This snapshot can't be brought back afterwards. The current graph is not affected.</p>`)) return;
                        await deleteSnapshot(info);
                    }
                } catch (error) {
                    toastr.error(String(error?.message ?? error), 'Lore Graph');
                }
                await renderList();
            });
            list.append(row);
        }
    }

    root.find('.lore_graph_snap_save').on('click', async () => {
        const name = await callGenericPopup('Name this snapshot (for example "Guild world, good run"):', POPUP_TYPE.INPUT, `Snapshot ${new Date().toLocaleDateString()}`);
        if (!name || !String(name).trim()) return;
        try {
            await createSnapshot(String(name).trim());
            toastr.success('Snapshot saved.', 'Lore Graph');
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Lore Graph');
        }
        await renderList();
    });

    root.find('.lore_graph_snap_export_current').on('click', async () => {
        try {
            exportData(await captureCurrent('Current graph'));
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Lore Graph');
        }
    });

    const fileInput = root.find('.lore_graph_snap_file');
    root.find('.lore_graph_snap_import').on('click', () => fileInput.trigger('click'));
    fileInput.on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const info = await importSnapshotText(await file.text(), file.name);
            toastr.success(`Imported as the snapshot "${info.name}". Click Restore on it to use it.`, 'Lore Graph', { timeOut: 8000 });
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Lore Graph: import failed');
        }
        await renderList();
    });

    async function clear(kind) {
        if (blocked()) return;
        const known = new Set(knownChunkIds());
        const shouldClear = kind === 'all' ? () => true : (id) => !known.has(id);
        const question = kind === 'all'
            ? '<h3>Clear the whole graph?</h3><p>Every extraction result is removed, so every section needs extracting again (that costs AI calls). Name settings stay. A snapshot is saved first, so you can restore it.</p>'
            : '<h3>Clear results of removed files?</h3><p>Removes results for sections that aren\'t in any lore file the extension knows about (files deleted, or lore you only used in another setup). Files attached to a character are known once a chat with that character has been opened. A snapshot is saved first.</p>';
        if (!await confirm(question)) return;
        try {
            await createSnapshot(kind === 'all' ? 'Before clearing the graph' : 'Before clearing removed files', { auto: true });
            const removed = await clearResults(shouldClear);
            await onChanged();
            toastr.success(`${removed} section result(s) removed.`, 'Lore Graph');
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Lore Graph');
        }
        await renderList();
    }
    root.find('.lore_graph_snap_clear_orphans').on('click', () => clear('orphans'));
    root.find('.lore_graph_snap_clear_all').on('click', () => clear('all'));

    renderList();
    return callGenericPopup(root, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true, okButton: 'Close' });
}
