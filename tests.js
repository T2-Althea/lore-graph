// Milestone 4: a saved list of test sentences with the sections each should pull in.
// "Run all tests" re-checks them in seconds (no AI calls; meaning search runs locally),
// so a broken link shows up right after lore files are added or edited.

import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml, uuidv4 } from '../../../utils.js';
import { FILE_PREFIX, loadJsonFile, saveJsonFile } from './storage.js';
import { runRetrieval } from './injection.js';
import { CASUAL_LINES, SUGGEST_KINDS, checkTestRunnable, cleanSuggestions, judgeTest, pickSectionsForSuggestions } from './test-check.js';
import { callModelForJson } from './extraction.js';

export const TESTS_FILE = `${FILE_PREFIX}tests.json`;

/**
 * @typedef {object} LoreTest
 * @property {string} id
 * @property {string} text one chat message per line, newest last
 * @property {string[]} expected chunk ids that must be injected
 * @property {boolean} nothing true when nothing at all should be injected
 * @property {string} note
 * @property {{ at: number, pass: boolean, skipped?: boolean, needs?: string[], gone?: string[], missing: string[], injected: string[] }|null} last
 */

/** A new list starts with lines that should pull in nothing in any setting. Use "Suggest tests"
 * or "Save as test" to add ones for your own lore. */
const STARTER_TESTS = CASUAL_LINES.map(text => [text, [], 'Casual chat: should inject nothing in any setting']);

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

/**
 * Runs one test and records the outcome on it. A test that expects sections from a document
 * that isn't loaded is skipped (not run, not failed).
 * @param {LoreTest} test
 * @param {import('./parser.js').LoreChunk[]} chunks
 * @param {object} settings
 */
export async function runTest(test, chunks, settings) {
    const { runnable, needs, gone } = checkTestRunnable(test, chunks.map(c => c.id));
    if (!runnable) {
        test.last = { at: Date.now(), pass: false, skipped: true, needs, gone: [], missing: [], injected: [] };
        return { test, report: null, pass: false, skipped: true, missing: [], injected: [] };
    }
    const messages = test.text.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const report = await runRetrieval(chunks, messages, settings);
    // Pinned sections are sent every time, so they don't count for or against a test.
    const injected = report.chunks.filter(c => (c.status === 'full' || c.status === 'tldr') && !c.pinned).map(c => c.id);
    const { pass, missing } = judgeTest(test, injected);
    test.last = { at: Date.now(), pass, skipped: false, needs: [], gone, missing, injected };
    return { test, report, pass, skipped: false, missing, injected };
}

/** "3 of 4 passed, 2 skipped" for the tests that have a last run. */
export function summarizeRuns(tests) {
    const ran = tests.filter(t => t.last && !t.last.skipped);
    const skipped = tests.filter(t => t.last?.skipped).length;
    const passed = ran.filter(t => t.last.pass).length;
    return { ran: ran.length, passed, skipped, text: `${passed} of ${ran.length} passed${skipped ? `, ${skipped} skipped (lore not loaded)` : ''}` };
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
            <input type="text" class="text_pole lore_graph_test_note" placeholder="e.g. checks a link between two documents" />
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
        const summary = summarizeRuns(tests);
        root.html(`
            <h3>${results ? 'Test results' : 'Test list'}</h3>
            <div class="lore_graph_meta">${tests.length} test(s)${summary.ran || summary.skipped ? ` · ${summary.text} on the last run` : ' · not run yet'}. Click a result to see its full report. Tests for lore that isn't loaded are skipped.</div>
            <table class="lore_graph_table"><tbody></tbody></table>`);
        const body = root.find('tbody');
        if (!tests.length) body.append('<tr><td><small class="lore_graph_empty">No tests yet. Use "Save as test" after a Test retrieval.</small></td></tr>');
        for (const test of tests) {
            const status = !test.last ? '<span class="lore_graph_badge">not run</span>'
                : test.last.skipped ? '<span class="lore_graph_badge lore_graph_status_skipped">⏭ skipped</span>'
                : test.last.pass ? '<span class="lore_graph_badge lore_graph_chunkstatus_full">✅ pass</span>'
                    : '<span class="lore_graph_badge lore_graph_status_error">❌ fail</span>';
            const gone = test.last?.gone?.length ? ` <b>No longer in the lore (renamed or removed?):</b> ${test.last.gone.map(escapeHtml).join(', ')}` : '';
            const detail = test.last?.skipped
                ? `Needs ${test.last.needs.map(escapeHtml).join(', ')}, which ${test.last.needs.length > 1 ? 'aren\'t' : 'isn\'t'} loaded. Expects: ${test.expected.map(escapeHtml).join(', ')}`
                : test.last && !test.last.pass
                ? (test.nothing ? `Injected ${test.last.injected.length} section(s) but should inject nothing.` : `Missing: ${test.last.missing.map(escapeHtml).join(', ')}.${gone}`)
                : (test.nothing ? 'Should inject nothing.' : `Expects: ${test.expected.map(escapeHtml).join(', ')}`);
            const row = $(`
                <tr>
                    <td>${status}</td>
                    <td>
                        <span class="${reports.get(test.id) ? 'lore_graph_link lore_graph_test_open' : ''}">${escapeHtml(test.text.replace(/\n+/g, ' / '))}</span>
                        ${test.note ? `<div class="lore_graph_row_sub"><i>${escapeHtml(test.note)}</i></div>` : ''}
                        <div class="lore_graph_row_sub">${detail}</div>
                    </td>
                    <td class="lore_graph_test_actions">
                        <i class="fa-solid fa-play menu_button" title="Run this test"></i>
                        <i class="fa-solid fa-pencil menu_button" title="Edit"></i>
                        <i class="fa-solid fa-trash-can menu_button" title="Delete"></i>
                    </td>
                </tr>`);
            row.find('.lore_graph_test_open').on('click', () => reports.get(test.id) && handlers.onOpenReport(reports.get(test.id), `Test: ${test.text.slice(0, 60)}`));
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

// ---------------------------------------------------------------- "Suggest tests" (one AI call)

const SUGGEST_SCHEMA = {
    name: 'lore_graph_test_suggestions',
    description: 'Roleplay test lines and the lore sections each should retrieve',
    strict: true,
    value: {
        type: 'object',
        properties: {
            tests: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                        expected: { type: 'array', items: { type: 'string' } },
                        kind: { type: 'string', enum: Object.keys(SUGGEST_KINDS) },
                    },
                    required: ['text', 'expected', 'kind'],
                    additionalProperties: false,
                },
            },
        },
        required: ['tests'],
        additionalProperties: false,
    },
};

const SUGGEST_INSTRUCTIONS = `You write test lines for a tool that finds the right lore sections for a roleplay chat.
You get a list of lore sections, each with its [id] and a short summary. Write lines a player or character might actually say or narrate during a scene in this setting, and say which section(s) each line should pull in.

Write these kinds:
- "names": a line that uses the setting's own terms for the thing (names, titles, materials, places) in a natural scene, not a question about the lore. About half the lines.
- "meaning": a line that is clearly about a section's idea but avoids that section's special terms, describing it in plain words instead. About a third of the lines.
- "casual": one or two everyday lines that have nothing to do with the lore (small talk, food, sleep). "expected" is an empty array.

Rules:
- One or two sentences per line, in the voice of a roleplay message.
- "expected": the [id] of each section the line clearly needs (usually one, at most three), copied exactly from the list, without the brackets. Only sections a reader of the line would obviously need.
- Spread the lines over different sections and documents.
Return JSON: { "tests": [ { "text": "...", "expected": ["<id>"], "kind": "names" } ] }. Reply with the JSON object only.`;

/**
 * Asks the AI for test lines about the loaded lore. Nothing is saved here.
 * @param {import('./parser.js').LoreChunk[]} chunks active chunks
 * @param {LoreTest[]} tests existing tests (sections they cover are offered last)
 * @param {object} profile connection profile
 * @param {object} settings extension settings
 * @param {number} [count] how many lines to ask for
 */
export async function suggestTests(chunks, tests, profile, settings, count = 10) {
    const sections = pickSectionsForSuggestions(chunks, tests);
    if (!sections.length) throw new Error('No lore sections are loaded.');
    const list = sections.map(s => `[${s.id}]\n${s.summary}`).join('\n\n');
    const data = await callModelForJson(profile, [
        { role: 'system', content: SUGGEST_INSTRUCTIONS },
        { role: 'user', content: `Write about ${count} lines.\n\nLORE SECTIONS:\n${list}` },
    ], SUGGEST_SCHEMA, settings, (d) => Array.isArray(d?.tests) ? null : 'The reply has no "tests" array.');
    return cleanSuggestions(data, sections.map(s => s.id), tests);
}

/**
 * Review popup for suggestions, each already run once so the user sees whether it passes now.
 * @param {{ text: string, expected: string[], kind: string, pass: boolean, missing: string[], injected: string[] }[]} suggestions
 * @returns {Promise<LoreTest[]>} the tests to add (empty when cancelled)
 */
export async function reviewSuggestionsPopup(suggestions) {
    const root = $(`
        <div class="lore_graph_popup lore_graph_suggestions">
            <h3>Suggested tests</h3>
            <div class="lore_graph_meta">Written by the AI from your loaded lore, then run once. A suggestion that fails now is either a weak suggestion or a real gap in what gets found: open "Test retrieval" with it to see which. Untick the ones you don't want.</div>
            <table class="lore_graph_table"><tbody></tbody></table>
        </div>`);
    const body = root.find('tbody');
    suggestions.forEach((s, i) => {
        const result = s.pass ? '<span class="lore_graph_badge lore_graph_chunkstatus_full">✅ passes now</span>'
            : '<span class="lore_graph_badge lore_graph_status_error">❌ fails now</span>';
        const detail = s.kind === 'casual'
            ? (s.pass ? 'Injects nothing.' : `Injects ${s.injected.map(escapeHtml).join(', ')}`)
            : `Expects: ${s.expected.map(escapeHtml).join(', ')}${s.missing.length ? `. <b>Missing:</b> ${s.missing.map(escapeHtml).join(', ')}` : ''}`;
        body.append(`
            <tr>
                <td><input type="checkbox" class="lore_graph_suggest_pick" data-index="${i}" checked /></td>
                <td>
                    ${escapeHtml(s.text)}
                    <div class="lore_graph_row_sub"><i>${escapeHtml(SUGGEST_KINDS[s.kind])}</i> · ${result}</div>
                    <div class="lore_graph_row_sub">${detail}</div>
                </td>
            </tr>`);
    });
    if (!suggestions.length) body.append('<tr><td><small class="lore_graph_empty">The AI did not return any usable suggestions. Try again.</small></td></tr>');
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Add ticked tests', cancelButton: 'Cancel', wider: true, leftAlign: true, allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return [];
    const picked = root.find('.lore_graph_suggest_pick:checked').map((_, el) => Number($(el).data('index'))).get();
    return picked.map(i => makeTest(suggestions[i].text, suggestions[i].expected, `Suggested · ${SUGGEST_KINDS[suggestions[i].kind]}`, suggestions[i].kind === 'casual'));
}
