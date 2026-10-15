// Milestone 4: a saved list of test sentences with the sections each should pull in.
// "Run all tests" re-checks them in seconds (no AI calls; meaning search runs locally),
// so a broken link shows up right after lore files are added or edited.

import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml, uuidv4 } from '../../../utils.js';
import { FILE_PREFIX, loadJsonFile, saveJsonFile } from './storage.js';
import { runRetrieval } from './injection.js';

export const TESTS_FILE = `${FILE_PREFIX}tests.json`;

/**
 * @typedef {object} LoreTest
 * @property {string} id
 * @property {string} text one chat message per line, newest last
 * @property {string[]} expected chunk ids that must be injected
 * @property {boolean} nothing true when nothing at all should be injected
 * @property {string} note
 * @property {{ at: number, pass: boolean, missing: string[], injected: string[] }|null} last
 */

/** The CLAUDE.md test cases, used to start the list. */
const STARTER_TESTS = [
    ['The undead pulled back from our torches and tried to flank us.', ['COS-004 §16 Undead In Dungeons', 'COS-006 §5 When Field Conditions Differ From the Briefing'], 'Guild §5 is reached through the "field exception report" link'],
    ['I slid my plate across to the checkpoint clerk.', ['COS-006 §7 The Rank Plate', 'COS-006 §7 Restricted Zone Access'], ''],
    ['We think a dragon is sleeping in the abandoned manor.', ['COS-004 §15 Aberrant Labyrinths', 'COS-004 §9 Yields & Wealth'], 'Dragons don\'t hoard'],
    ['We cut an organic core out of the beast. Who gets it?', ['COS-006 §6 Organic Manacite Cores', 'COS-004 §11 Organic Cores'], ''],
    ['The stone down here feels wrong. It reads like someone, not something.', ['COS-004 §15 Aberrant Labyrinths', 'COS-004 §3 Ambient Reading'], 'Needs meaning search (no lore names in the sentence)'],
    ['Haha, nice weather today. Want to grab some food and talk about your family?', [], 'Casual chat'],
    ['She set a plate of stew in front of me. The smell made my stomach growl.', [], 'Everyday words only'],
];

function makeTest(text, expected, note, nothing = expected.length === 0) {
    return { id: uuidv4(), text, expected, nothing, note, last: null };
}

/** @returns {Promise<LoreTest[]>} */
export async function loadTests() {
    const data = await loadJsonFile(TESTS_FILE);
    if (data === null) {
        return STARTER_TESTS.map(([text, expected, note]) => makeTest(text, expected, note));
    }
    return Array.isArray(data?.tests) ? data.tests : [];
}

/** @param {LoreTest[]} tests */
export async function saveTests(tests) {
    await saveJsonFile(TESTS_FILE, { version: 1, tests });
}

/** Chunk ids count as matching when equal, or when a split chunk's parts share the id. */
const sameChunk = (expectedId, injectedId) => injectedId === expectedId || injectedId.startsWith(`${expectedId} (part `);

/**
 * Runs one test and records the outcome on it.
 * @param {LoreTest} test
 * @param {import('./parser.js').LoreChunk[]} chunks
 * @param {object} settings
 */
export async function runTest(test, chunks, settings) {
    const messages = test.text.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const report = await runRetrieval(chunks, messages, settings);
    const injected = report.chunks.filter(c => c.status === 'full' || c.status === 'tldr').map(c => c.id);
    const missing = test.nothing ? [] : test.expected.filter(id => !injected.some(i => sameChunk(id, i)));
    const pass = test.nothing ? injected.length === 0 : missing.length === 0;
    test.last = { at: Date.now(), pass, missing, injected };
    return { test, report, pass, missing, injected };
}

/**
 * Popup to create or edit a test.
 * @param {Partial<LoreTest>} initial
 * @param {string[]} allChunkIds for adding expected sections by hand
 * @param {{ title: string, injected?: string[] }} options injected = sections the test run found (pre-ticked)
 * @returns {Promise<LoreTest|null>}
 */
export async function editTestPopup(initial, allChunkIds, { title, injected = [] }) {
    const expected = new Set(initial.expected ?? injected);
    const candidates = [...new Set([...(initial.expected ?? []), ...injected])];
    const root = $(`
        <div class="lore_graph_popup lore_graph_test_editor">
            <h3>${escapeHtml(title)}</h3>
            <label>Test text (each line is one chat message, newest last)</label>
            <textarea class="text_pole lore_graph_test_text" rows="3"></textarea>
            <label class="checkbox_label"><input type="checkbox" class="lore_graph_test_nothing" /> <span>Should inject nothing (for casual or everyday-word sentences)</span></label>
            <div class="lore_graph_test_expected_box">
                <label>Sections that must be injected</label>
                <div class="lore_graph_test_expected"></div>
                <div class="flex-container">
                    <input type="text" class="text_pole lore_graph_test_add" list="lore_graph_chunk_ids" placeholder="Add another section… (start typing its name)" />
                    <datalist id="lore_graph_chunk_ids">${allChunkIds.map(id => `<option value="${escapeHtml(id)}"></option>`).join('')}</datalist>
                    <div class="menu_button lore_graph_test_add_button">Add</div>
                </div>
            </div>
            <label>Note (optional)</label>
            <input type="text" class="text_pole lore_graph_test_note" placeholder="e.g. checks the Guild §5 link" />
        </div>`);
    root.find('.lore_graph_test_text').val(initial.text ?? '');
    root.find('.lore_graph_test_note').val(initial.note ?? '');
    root.find('.lore_graph_test_nothing').prop('checked', !!initial.nothing);

    const list = root.find('.lore_graph_test_expected');
    const addRow = (id, checked) => {
        if (list.find(`input[value="${CSS.escape(id)}"]`).length) return;
        list.append(`<label class="checkbox_label"><input type="checkbox" value="${escapeHtml(id)}" ${checked ? 'checked' : ''}/> <span>${escapeHtml(id)}</span></label>`);
    };
    candidates.forEach(id => addRow(id, expected.has(id)));
    if (!candidates.length) list.append('<small class="lore_graph_empty lore_graph_test_none">None yet. Add sections below.</small>');
    const toggleExpected = () => root.find('.lore_graph_test_expected_box').toggle(!root.find('.lore_graph_test_nothing').prop('checked'));
    root.find('.lore_graph_test_nothing').on('change', toggleExpected);
    toggleExpected();
    root.find('.lore_graph_test_add_button').on('click', () => {
        const id = String(root.find('.lore_graph_test_add').val() ?? '').trim();
        if (!allChunkIds.includes(id)) {
            toastr.warning('Pick a section name from the suggestions.', 'Lore Graph');
            return;
        }
        root.find('.lore_graph_test_none').remove();
        addRow(id, true);
        root.find('.lore_graph_test_add').val('');
    });

    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Save test', cancelButton: 'Cancel', wider: true, leftAlign: true, allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    const text = String(root.find('.lore_graph_test_text').val() ?? '').trim();
    const nothing = root.find('.lore_graph_test_nothing').prop('checked');
    const chosen = list.find('input:checked').map((_, el) => String($(el).val())).get();
    if (!text) {
        toastr.warning('The test needs some text.', 'Lore Graph');
        return null;
    }
    if (!nothing && !chosen.length) {
        toastr.warning('Tick at least one section, or choose "Should inject nothing".', 'Lore Graph');
        return null;
    }
    return {
        id: initial.id ?? uuidv4(),
        text,
        expected: nothing ? [] : chosen,
        nothing,
        note: String(root.find('.lore_graph_test_note').val() ?? '').trim(),
        last: null,
    };
}

/**
 * Results of "Run all tests", or the saved list when results is null.
 * @param {LoreTest[]} tests
 * @param {{ test: LoreTest, report: object }[]|null} results
 * @param {object} handlers
 * @param {(report: object, title: string) => void} handlers.onOpenReport
 * @param {(test: LoreTest) => Promise<void>} handlers.onEdit updates the test in place
 * @param {(test: LoreTest) => Promise<void>} handlers.onDelete removes it from `tests` (same array) after confirming
 * @param {(test: LoreTest) => Promise<{ report: object }|null>} handlers.onRun
 */
export function showTestList(tests, results, handlers) {
    const reports = new Map((results ?? []).map(r => [r.test.id, r.report]));
    const root = $('<div class="lore_graph_popup lore_graph_tests"></div>');

    function render() {
        const ran = tests.filter(t => t.last);
        const passed = ran.filter(t => t.last.pass).length;
        root.html(`
            <h3>${results ? 'Test results' : 'Test list'}</h3>
            <div class="lore_graph_meta">${tests.length} test(s)${ran.length ? ` · ${passed} of ${ran.length} passed on the last run` : ' · not run yet'}. Click a result to see its full report.</div>
            <table class="lore_graph_table"><tbody></tbody></table>`);
        const body = root.find('tbody');
        if (!tests.length) body.append('<tr><td><small class="lore_graph_empty">No tests yet. Use "Save as test" after a Test retrieval.</small></td></tr>');
        for (const test of tests) {
            const status = !test.last ? '<span class="lore_graph_badge">not run</span>'
                : test.last.pass ? '<span class="lore_graph_badge lore_graph_chunkstatus_full">✅ pass</span>'
                    : '<span class="lore_graph_badge lore_graph_status_error">❌ fail</span>';
            const detail = test.last && !test.last.pass
                ? (test.nothing ? `Injected ${test.last.injected.length} section(s) but should inject nothing.` : `Missing: ${test.last.missing.map(escapeHtml).join(', ')}`)
                : (test.nothing ? 'Should inject nothing.' : `Expects: ${test.expected.map(escapeHtml).join(', ')}`);
            const row = $(`
                <tr>
                    <td>${status}</td>
                    <td>
                        <span class="${reports.has(test.id) ? 'lore_graph_link lore_graph_test_open' : ''}">${escapeHtml(test.text.replace(/\n+/g, ' / '))}</span>
                        ${test.note ? `<div class="lore_graph_row_sub"><i>${escapeHtml(test.note)}</i></div>` : ''}
                        <div class="lore_graph_row_sub">${detail}</div>
                    </td>
                    <td class="lore_graph_test_actions">
                        <i class="fa-solid fa-play menu_button" title="Run this test"></i>
                        <i class="fa-solid fa-pencil menu_button" title="Edit"></i>
                        <i class="fa-solid fa-trash-can menu_button" title="Delete"></i>
                    </td>
                </tr>`);
            row.find('.lore_graph_test_open').on('click', () => handlers.onOpenReport(reports.get(test.id), `Test: ${test.text.slice(0, 60)}`));
            row.find('.fa-play').on('click', async () => {
                const result = await handlers.onRun(test);
                if (result) reports.set(test.id, result.report);
                render();
            });
            row.find('.fa-pencil').on('click', async () => { await handlers.onEdit(test); render(); });
            row.find('.fa-trash-can').on('click', async () => { await handlers.onDelete(test); render(); });
            body.append(row);
        }
    }

    render();
    return callGenericPopup(root, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true, okButton: 'Close' });
}
