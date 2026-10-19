// "Capital letter only": the everyday-word check suggests it for names the lore capitalises,
// and retrieval then tells "the Sea" (lore) from "sea water" (not lore).
import path from 'node:path';
import { FIXTURES, check, closePopup, configure, confirmPopup, extractAll, importLore, openPanel, openST, run, shot } from './lib.mjs';

async function testRetrieval(page, text) {
    await page.fill('#lore_graph_test_input', text);
    await page.click('#lore_graph_test');
    const popup = page.locator('dialog[open] .popup-body');
    await popup.waitFor();
    await page.waitForTimeout(300);
    return popup;
}

await run('capital-letters', async (page) => {
    await openST(page);
    await configure(page);
    await openPanel(page);
    await importLore(page, [path.join(FIXTURES, 'Tide_Temple.txt'), path.join(FIXTURES, 'Marsh_Wardens.txt')]);
    await extractAll(page);

    await page.click('#lore_graph_everyday');
    await confirmPopup(page);
    const review = page.locator('dialog[open] .lore_graph_everyday_review');
    await review.waitFor({ timeout: 60000 });
    const row = (name) => review.locator('tr', { has: page.locator(`b:text-is("${name}")`) });
    check(await row('Sea').locator('select').inputValue() === 'capital', '"Sea" is suggested as Capital letter only');
    check(await row('Abyss').locator('select').inputValue() === 'capital', '"Abyss" is suggested as Capital letter only');
    check(/capital letter \d+ of \d+ times/.test(await row('Sea').textContent()), 'the review shows how the lore writes the name');
    await shot(page, 'everyday-review-capital', review.locator('xpath=ancestor::div[contains(@class,"popup-body")]'));
    await confirmPopup(page);
    await page.waitForFunction(() => /to "Capital letter only"/.test(document.querySelector('#lore_graph_everyday_status')?.textContent ?? ''));
    check(true, 'the choices were applied');

    let popup = await testRetrieval(page, 'We swore by the Sea before we set out.');
    let text = await popup.textContent();
    check(/TT-001 §1 The Sea/.test(text) && /written with a capital letter/.test(text), '"the Sea" pulls in the Sea section');
    await shot(page, 'capital-report-sea', popup);
    await closePopup(page);

    popup = await testRetrieval(page, 'She handed me a cup of sea water.');
    text = await popup.textContent();
    check(!/TT-001 §1 The Sea \(/.test(text) && /written without a capital letter/.test(text), '"sea water" is ignored, with the reason shown');
    await shot(page, 'capital-report-sea-water', popup);
    await closePopup(page);

    popup = await testRetrieval(page, 'Sea spray soaked my boots.');
    check(/written without a capital letter/.test(await popup.textContent()), 'a capital at the start of a sentence does not count');
    await closePopup(page);

    // The graph browser offers the new mode.
    await page.click('#lore_graph_browse');
    const browser = page.locator('dialog[open]');
    await browser.locator('.lore_graph_search').fill('Sea');
    await browser.locator('.lore_graph_entity_row[data-id="sea"]').dispatchEvent('click');
    const select = browser.locator('.lore_graph_match_mode');
    check(await select.inputValue() === 'capital', 'Browse graph shows "Capital letter only" for Sea');
    await shot(page, 'capital-browse-graph', browser.locator('.popup-body'));

    await closePopup(page);

    // Names an earlier check already set to "Needs context" are offered the new mode, without asking the AI again.
    await page.evaluate(async () => {
        const matching = await import('/scripts/extensions/third-party/lore-graph/matching.js');
        await matching.setNameMatchModes(['Abyss'], 'context');
    });
    await fetch('http://127.0.0.1:8124/__reset', { method: 'POST' });
    await page.click('#lore_graph_everyday');
    await confirmPopup(page);
    const again = page.locator('dialog[open] .lore_graph_everyday_review');
    await again.waitFor({ timeout: 60000 });
    const abyss = again.locator('tr', { has: page.locator('b:text-is("Abyss")') });
    check(/Already set to Needs context/.test(await abyss.textContent()) && await abyss.locator('select').inputValue() === 'capital', 'an existing "Needs context" name the lore capitalises is offered Capital letter only');
    const sent = await (await fetch('http://127.0.0.1:8124/__requests')).json();
    check(sent.length === 0, 'no AI call when every name was already checked');
    await shot(page, 'everyday-review-existing', again.locator('xpath=ancestor::div[contains(@class,"popup-body")]'));
    await confirmPopup(page);
});
