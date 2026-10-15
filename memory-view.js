// Milestone 6a: the memory list. Filter, edit, delete and add story memories for the open chat.

import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { MEMORY_KINDS, getMemoryState, newMemory, saveMemoryState } from './memory.js';

const splitNames = (text) => String(text ?? '').split(',').map(x => x.trim()).filter(Boolean);

/** Who knows a memory, as a readable string. */
export function knowersText(memory) {
    if (memory.everyone) return 'everyone';
    const learned = memory.learned.map(l => `${l.name}${l.from ? ` (told by ${l.from})` : ''}`);
    return [...memory.witnesses, ...learned].join(', ') || 'nobody listed';
}

/**
 * Edit popup for one memory. Saving marks it as edited by you, so it's kept even if the
 * messages it came from change later.
 * @returns {Promise<boolean>} whether it was saved
 */
async function editMemoryPopup(memory, isNew) {
    const root = $(`
        <div class="lore_graph_popup lore_graph_memory_editor">
            <h3>${isNew ? 'Add a memory' : `Edit memory ${escapeHtml(memory.id)}`}</h3>
            <label>Kind</label>
            <select class="text_pole lore_graph_mem_kind">${Object.entries(MEMORY_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
            <label>What should be remembered (one sentence)</label>
            <textarea class="text_pole lore_graph_mem_text" rows="3"></textarea>
            <label>About (names, comma-separated)</label>
            <input class="text_pole lore_graph_mem_characters" />
            <label>Witnesses: who saw or heard it (names, comma-separated)</label>
            <input class="text_pole lore_graph_mem_witnesses" />
            <label>Learned later (one per line as "Name: told by Someone")</label>
            <textarea class="text_pole lore_graph_mem_learned" rows="2"></textarea>
            <label class="checkbox_label"><input type="checkbox" class="lore_graph_mem_everyone" /> <span>Everyone knows this (common knowledge)</span></label>
            <label>Lore terms involved (comma-separated)</label>
            <input class="text_pole lore_graph_mem_lore" />
            <small class="lore_graph_hint">Memories you edit are kept even if the chat messages they came from change later.</small>
        </div>`);
    root.find('.lore_graph_mem_kind').val(memory.kind);
    root.find('.lore_graph_mem_text').val(memory.text);
    root.find('.lore_graph_mem_characters').val(memory.characters.join(', '));
    root.find('.lore_graph_mem_witnesses').val(memory.witnesses.join(', '));
    root.find('.lore_graph_mem_learned').val(memory.learned.map(l => `${l.name}${l.from ? `: told by ${l.from}` : ''}`).join('\n'));
    root.find('.lore_graph_mem_everyone').prop('checked', memory.everyone);
    root.find('.lore_graph_mem_lore').val(memory.loreTerms.join(', '));

    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel', wider: true, leftAlign: true, allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
    const text = String(root.find('.lore_graph_mem_text').val() ?? '').replace(/\s+/g, ' ').trim();
    if (!text) {
        toastr.warning('A memory needs some text.', 'Lore Graph');
        return false;
    }
    memory.kind = String(root.find('.lore_graph_mem_kind').val());
    memory.text = text;
    memory.characters = splitNames(root.find('.lore_graph_mem_characters').val());
    memory.witnesses = splitNames(root.find('.lore_graph_mem_witnesses').val());
    memory.learned = String(root.find('.lore_graph_mem_learned').val() ?? '').split('\n').map(line => {
        const [name, rest] = line.split(':');
        return name?.trim() ? { name: name.trim(), from: (rest ?? '').replace(/^\s*told by\s*/i, '').trim(), atMessage: -1, hash: 0 } : null;
    }).filter(Boolean);
    memory.everyone = root.find('.lore_graph_mem_everyone').prop('checked');
    memory.loreTerms = splitNames(root.find('.lore_graph_mem_lore').val());
    memory.edited = true;
    return true;
}

/**
 * The memory list for the open chat.
 * @param {() => void} onChange called after anything is edited or deleted
 */
export function showMemoryList(onChange) {
    const state = getMemoryState();
    if (!state) {
        toastr.info('Open a chat first.', 'Lore Graph');
        return;
    }
    const filters = { kind: '', person: '', search: '', showReplaced: false };
    const root = $('<div class="lore_graph_popup lore_graph_memories"></div>');

    function render() {
        const people = [...new Set(state.memories.flatMap(m => [...m.characters, ...m.witnesses, ...m.learned.map(l => l.name)]))].sort();
        const shown = state.memories.filter(m =>
            (filters.showReplaced || !m.superseded)
            && (!filters.kind || m.kind === filters.kind)
            && (!filters.person || m.everyone || [...m.characters, ...m.witnesses, ...m.learned.map(l => l.name)].includes(filters.person))
            && (!filters.search || m.text.toLowerCase().includes(filters.search.toLowerCase())));
        root.html(`
            <h3>Story memory</h3>
            <div class="lore_graph_meta">${state.memories.filter(m => !m.superseded).length} memories in this chat. Read up to message #${state.processedUpTo}. Memories are not sent to the AI yet (that comes in step 6b).</div>
            <div class="flex-container lore_graph_mem_filters">
                <select class="text_pole lore_graph_mem_f_kind"><option value="">All kinds</option>${Object.entries(MEMORY_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
                <select class="text_pole lore_graph_mem_f_person" title="Show what this person knows"><option value="">Everyone's memories</option>${people.map(p => `<option value="${escapeHtml(p)}">Known to ${escapeHtml(p)}</option>`).join('')}</select>
                <input class="text_pole lore_graph_mem_f_search" type="search" placeholder="Search…" />
                <label class="checkbox_label"><input type="checkbox" class="lore_graph_mem_f_replaced" /> <span>Show replaced</span></label>
                <div class="menu_button menu_button_icon lore_graph_mem_add"><i class="fa-solid fa-plus"></i><span>Add</span></div>
            </div>
            <table class="lore_graph_table"><tbody></tbody></table>`);
        root.find('.lore_graph_mem_f_kind').val(filters.kind);
        root.find('.lore_graph_mem_f_person').val(filters.person);
        root.find('.lore_graph_mem_f_search').val(filters.search);
        root.find('.lore_graph_mem_f_replaced').prop('checked', filters.showReplaced);

        const body = root.find('tbody');
        if (!shown.length) body.append(`<tr><td><small class="lore_graph_empty">${state.memories.length ? 'No memories match the filters.' : 'No memories yet. Chat a little, then click "Remember recent events" (or wait for the automatic run).'}</small></td></tr>`);
        for (const memory of [...shown].reverse()) {
            const sources = memory.sources.map(s => `#${s.index}`).join(', ');
            const row = $(`
                <tr class="${memory.superseded ? 'lore_graph_mem_replaced' : ''}">
                    <td><span class="lore_graph_badge">${escapeHtml(MEMORY_KINDS[memory.kind] ?? memory.kind)}</span><div class="lore_graph_row_sub">${escapeHtml(memory.id)}</div></td>
                    <td>
                        ${escapeHtml(memory.text)}${memory.superseded ? ' <small>(replaced by a newer memory)</small>' : ''}
                        <div class="lore_graph_row_sub">Known to: ${escapeHtml(knowersText(memory))}</div>
                        ${memory.loreTerms.length ? `<div class="lore_graph_row_sub">Lore: ${escapeHtml(memory.loreTerms.join(', '))}</div>` : ''}
                        <div class="lore_graph_row_sub">${sources ? `From message ${escapeHtml(sources)}` : 'Added by you'}${memory.edited ? ' · edited by you' : ''}</div>
                    </td>
                    <td class="lore_graph_test_actions">
                        <i class="fa-solid fa-pencil menu_button" title="Edit"></i>
                        <i class="fa-solid fa-trash-can menu_button" title="Delete"></i>
                    </td>
                </tr>`);
            row.find('.fa-pencil').on('click', async () => {
                if (await editMemoryPopup(memory, false)) {
                    saveMemoryState();
                    onChange?.();
                    render();
                }
            });
            row.find('.fa-trash-can').on('click', async () => {
                const ok = await callGenericPopup(`Delete this memory?<br><i>${escapeHtml(memory.text)}</i>`, POPUP_TYPE.CONFIRM);
                if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
                state.memories = state.memories.filter(m => m !== memory);
                for (const other of state.memories) {
                    if (memory.supersedes.includes(other.id)) other.superseded = state.memories.some(m => m.supersedes.includes(other.id));
                }
                saveMemoryState();
                onChange?.();
                render();
            });
            body.append(row);
        }
    }

    root.on('change', '.lore_graph_mem_f_kind', function () { filters.kind = String($(this).val()); render(); });
    root.on('change', '.lore_graph_mem_f_person', function () { filters.person = String($(this).val()); render(); });
    root.on('change', '.lore_graph_mem_f_replaced', function () { filters.showReplaced = $(this).prop('checked'); render(); });
    root.on('change', '.lore_graph_mem_f_search', function () { filters.search = String($(this).val()); render(); });
    root.on('click', '.lore_graph_mem_add', async () => {
        const memory = newMemory(state);
        if (await editMemoryPopup(memory, true)) {
            state.memories.push(memory);
            saveMemoryState();
            onChange?.();
            render();
        }
    });

    render();
    return callGenericPopup(root, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true, okButton: 'Close' });
}
