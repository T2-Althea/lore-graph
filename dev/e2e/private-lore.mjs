// Runs on the user's own lore when it has been copied to dev/.work/lore (never committed):
// the Æther / Ex-Zone setting is loaded while the saved tests are for the Dungeon / Guild one.
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_LORE, buildMeaningIndex, check, closePopup, configure, extractAll, importLore, openPanel, openST, run, shot, shotPanelArea, waitToast, writeExtensionFile } from './lib.mjs';

const files = ['Aether_Codex.txt', 'Ex-Zone_Codex.txt'].map(f => path.join(PRIVATE_LORE, f));
if (!files.every(f => fs.existsSync(f))) {
    console.log('private-lore: skipped (copy Aether_Codex.txt and Ex-Zone_Codex.txt into dev/.work/lore to run it)');
    process.exit(0);
}

await run('private-lore', async (page) => {
    await openST(page);
    await configure(page, { embed_enabled: true });
    await openPanel(page);
    await importLore(page, files);
    await extractAll(page);

    // The user's old test list (Dungeon / Guild setting), as it would be saved on their install.
    await writeExtensionFile(page, 'lore-graph_tests.json', {
        version: 1,
        tests: [
            ['The undead pulled back from our torches and tried to flank us.', ['COS-004 §16 Undead In Dungeons', 'COS-006 §5 When Field Conditions Differ From the Briefing']],
            ['I slid my plate across to the checkpoint clerk.', ['COS-006 §7 The Rank Plate', 'COS-006 §7 Restricted Zone Access']],
            ['We think a dragon is sleeping in the abandoned manor.', ['COS-004 §15 Aberrant Labyrinths', 'COS-004 §9 Yields & Wealth']],
            ['We cut an organic core out of the beast. Who gets it?', ['COS-006 §6 Organic Manacite Cores', 'COS-004 §11 Organic Cores']],
            ['The stone down here feels wrong. It reads like someone, not something.', ['COS-004 §15 Aberrant Labyrinths', 'COS-004 §3 Ambient Reading']],
            ['Haha, nice weather today. Want to grab some food and talk about your family?', []],
            ['She set a plate of stew in front of me. The smell made my stomach growl.', []],
        ].map(([text, expected], i) => ({ id: `old${i}`, text, expected, nothing: expected.length === 0, note: '', last: null })),
    });
    await openST(page);
    await openPanel(page);
    await buildMeaningIndex(page);
    await page.click('#lore_graph_tests_run');
    const result = await waitToast(page, /tests passed/);
    check(/2 of 2 tests passed\. 5 skipped because their lore isn't loaded/.test(result), `old tests with the new setting: "${result}"`);
    await shot(page, 'private-old-tests-skipped', page.locator('dialog[open] .popup-body'));
    await closePopup(page);
    await shotPanelArea(page, 'panel-test-list', page.locator('#lore_graph_settings h4:has-text("Test list")'), page.locator('#lore_graph_tests_summary'));

    await page.click('#lore_graph_embed_check');
    const sanity = page.locator('dialog[open] .lore_graph_sanity');
    await sanity.waitFor({ timeout: 60000 });
    const text = await sanity.textContent();
    check(/COS-00 §/.test(text) && /COS-01 §/.test(text), 'sanity check uses the Æther and Ex-Zone sections');
    console.log('  ', text.match(/\d+ of \d+ sections found[^.]*\./)?.[0]);
    await shot(page, 'private-sanity-check', page.locator('dialog[open] .popup-body'));
    await closePopup(page);

    await page.click('#lore_graph_tests_suggest');
    const review = page.locator('dialog[open] .lore_graph_suggestions');
    await review.waitFor({ timeout: 60000 });
    check(/COS-0[01] §/.test(await review.textContent()), 'suggestions are about the loaded setting');
    await shot(page, 'private-suggested', page.locator('dialog[open] .popup-body'));
});
