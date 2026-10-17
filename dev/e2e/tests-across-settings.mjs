// Test list and sanity check work with any setting: tests for lore that isn't loaded are skipped,
// "Suggest tests" writes tests for the loaded lore, and the sanity check is built from it.
import path from 'node:path';
import { FIXTURES, buildMeaningIndex, check, closePopup, configure, confirmPopup, extractAll, importLore, openPanel, openST, run, shot, waitToast, writeExtensionFile } from './lib.mjs';

const MARSH = path.join(FIXTURES, 'Marsh_Wardens.txt');
const STATION = path.join(FIXTURES, 'Orbital_Station.txt');

await run('tests-across-settings', async (page) => {
    await openST(page);
    await configure(page);
    await openPanel(page);
    await importLore(page, [MARSH, STATION]);
    await extractAll(page);

    // 1. A brand-new test list has only setting-neutral tests, and they pass.
    await page.click('#lore_graph_tests_run');
    const first = await waitToast(page, /tests passed/);
    check(/2 of 2 tests passed/.test(first), `fresh list: "${first}"`);
    const firstPopup = page.locator('dialog[open] .lore_graph_tests');
    check(!/COS-|undead|Rank Plate/i.test(await firstPopup.textContent()), 'no tests from the old setting in a fresh list');
    await closePopup(page);

    // 2. A list that also holds another setting's tests (like the user's old Dungeon/Guild ones).
    await writeExtensionFile(page, 'lore-graph_tests.json', {
        version: 1,
        tests: [
            { id: 't1', text: 'The undead pulled back from our torches and tried to flank us.', expected: ['COS-004 §16 Undead In Dungeons', 'COS-006 §5 When Field Conditions Differ From the Briefing'], nothing: false, note: 'Old setting', last: null },
            { id: 't2', text: 'I slid my plate across to the checkpoint clerk.', expected: ['COS-006 §7 The Rank Plate'], nothing: false, note: 'Old setting', last: null },
            { id: 't3', text: 'The gate keeper checked my Warden\'s Seal against his ledger.', expected: ['MW-001 §2 The Seal Itself'], nothing: false, note: '', last: null },
            { id: 't4', text: 'The Wraiths stopped at the edge of the river.', expected: ['MW-001 §3 Wraiths', 'MW-001 §3 Old Wraith Section'], nothing: false, note: 'Expects a section that was renamed', last: null },
            { id: 't5', text: 'Haha, nice weather today.', expected: [], nothing: true, note: '', last: null },
        ],
    });
    await openST(page);
    await openPanel(page);
    await page.click('#lore_graph_tests_run');
    const mixed = await waitToast(page, /tests passed/);
    check(/2 of 3 tests passed\. 2 skipped because their lore isn't loaded/.test(mixed), `mixed list: "${mixed}"`);
    const popup = page.locator('dialog[open] .lore_graph_tests');
    const text = await popup.textContent();
    check((text.match(/⏭ skipped/g) ?? []).length === 2, 'two tests shown as skipped');
    check(/Needs COS-004, COS-006, which aren't loaded/.test(text) && /Needs COS-006, which isn't loaded/.test(text), 'skipped tests name the missing documents');
    check(/No longer in the lore \(renamed or removed\?\):.*MW-001 §3 Old Wraith Section/.test(text), 'a renamed section fails and is named');
    await shot(page, 'tests-mixed-settings', page.locator('dialog[open] .popup-body'));
    await closePopup(page);
    const summary = await page.locator('#lore_graph_tests_summary').textContent();
    check(/2 of 3 passed, 2 skipped \(lore not loaded\)/.test(summary), `panel summary: "${summary}"`);

    // 3. Suggest tests: one AI call, each suggestion tried once, reviewed before saving.
    await page.click('#lore_graph_tests_suggest');
    const review = page.locator('dialog[open] .lore_graph_suggestions');
    await review.waitFor({ timeout: 60000 });
    const reviewText = await review.textContent();
    const rows = await review.locator('tbody tr').count();
    check(rows >= 4, `suggestions shown: ${rows}`);
    check(!/NOPE §9/.test(reviewText), 'a suggestion naming a section that does not exist is dropped');
    check(/passes now/.test(reviewText) && /Casual: should inject nothing/.test(reviewText), 'each suggestion shows whether it passes now');
    await shot(page, 'tests-suggested', page.locator('dialog[open] .popup-body'));
    await review.locator('.lore_graph_suggest_pick').first().uncheck();
    await confirmPopup(page);
    const added = await waitToast(page, /test\(s\) added/);
    check(added.includes(`${rows - 1} test(s) added`), `added all but the unticked one: "${added}"`);
    const sent = await (await fetch('http://127.0.0.1:8124/__requests')).json();
    const suggestCall = sent.find(r => r.messages[0]?.content.includes('You write test lines'));
    check(suggestCall && !/COS-|manacite|Rank Plate/.test(suggestCall.messages.map(m => m.content).join('\n')), 'the suggestion request only contains the loaded lore and neutral instructions');

    // 4. Meaning search sanity check, built from the loaded lore.
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.lore_graph.embed_enabled = true; });
    await buildMeaningIndex(page);
    await page.click('#lore_graph_embed_check');
    const sanity = page.locator('dialog[open] .lore_graph_sanity');
    await sanity.waitFor({ timeout: 60000 });
    const sanityText = await sanity.textContent();
    check(/\d of \d sections found their own summary in the top 5/.test(sanityText), 'sanity check reports sections found');
    check(/MW-001/.test(sanityText) && /Orbital_Station/.test(sanityText), 'sanity check uses both loaded documents');
    check(!/COS-00[46]|rank plate/i.test(sanityText), 'sanity check has nothing from the old setting');
    await shot(page, 'sanity-check', page.locator('dialog[open] .popup-body'));
    await closePopup(page);
});
