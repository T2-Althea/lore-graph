// Panel sections fold and stay folded, the extraction window has Select all / Unselect all,
// and a rejected API key pauses extraction at once instead of retrying chunk after chunk.
import path from 'node:path';
import { FAKE_URL, FIXTURES, check, configure, confirmPopup, extractAll, importLore, openPanel, openST, run, shot, shotPanelArea } from './lib.mjs';

const fake = (route, body = {}) => fetch(`${FAKE_URL}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

await run('panel-and-extraction', async (page) => {
    await openST(page);
    await configure(page);
    await openPanel(page);
    await importLore(page, [path.join(FIXTURES, 'Marsh_Wardens.txt'), path.join(FIXTURES, 'Orbital_Station.txt')]);

    // Folding: counts in the headers, lists hidden, remembered after a reload.
    const sourcesHeader = page.locator('.lore_graph_fold_header[data-fold="sources"]');
    const chunksHeader = page.locator('.lore_graph_fold_header[data-fold="chunks"]');
    check((await sourcesHeader.textContent()).includes('(2 files)'), 'sources header shows the file count');
    check((await chunksHeader.textContent()).includes('(8 in 2 documents)'), 'chunks header shows the chunk count');
    await shotPanelArea(page, 'panel-unfolded', sourcesHeader, page.locator('#lore_graph_chunks'));
    await sourcesHeader.click();
    await chunksHeader.click();
    check(!(await page.locator('#lore_graph_sources').isVisible()) && !(await page.locator('#lore_graph_chunks').isVisible()), 'both lists hide when their header is clicked');
    check(await page.locator('#lore_graph_rescan').isVisible(), 'Rescan and Import stay visible while the list is folded');
    await page.waitForTimeout(1500); // settings save is debounced
    await openST(page);
    await openPanel(page);
    check(!(await page.locator('#lore_graph_sources').isVisible()) && !(await page.locator('#lore_graph_chunks').isVisible()), 'folded sections stay folded after a reload');
    await shotPanelArea(page, 'panel-folded', sourcesHeader, page.locator('#lore_graph_extract_all'));
    await sourcesHeader.click();
    check(await page.locator('#lore_graph_sources').isVisible(), 'clicking again shows the list');

    // Select all / Unselect all in the extraction window.
    await page.click('#lore_graph_extract');
    const popup = page.locator('dialog[open]');
    await popup.locator('.lore_graph_doc_choices input').first().waitFor();
    await popup.locator('.lore_graph_choose_none').click();
    check(await popup.locator('.lore_graph_doc_choices input:checked').count() === 0, 'Unselect all clears every document');
    await page.waitForFunction(() => /^0 chunks/.test(document.querySelector('dialog[open] .lore_graph_estimate')?.textContent ?? ''));
    check(true, 'estimate updates to 0 chunks');
    await shot(page, 'extract-unselect-all', popup.locator('.popup-body'));
    await popup.locator('.lore_graph_choose_all').click();
    check(await popup.locator('.lore_graph_doc_choices input:checked').count() === 2, 'Select all ticks every document');
    await page.waitForFunction(() => /^8 chunks/.test(document.querySelector('dialog[open] .lore_graph_estimate')?.textContent ?? ''));
    await popup.locator('.popup-button-cancel').click();

    // A rejected API key: extraction pauses after the first answers, it doesn't retry every chunk.
    await fake('__reset');
    await fake('__fail', { status: 401, message: 'Invalid credentials' });
    await page.click('#lore_graph_extract');
    await confirmPopup(page);
    await page.waitForFunction(() => /^(Finished|Paused|Stopped|Extraction stopped)/.test(document.querySelector('#lore_graph_extract_status')?.textContent ?? ''), null, { timeout: 60000 });
    const status = await page.locator('#lore_graph_extract_status').textContent();
    check(/^Paused\..*rejected the API key/.test(status), `extraction paused on the bad key: "${status.slice(0, 120)}…"`);
    const sent = (await (await fetch(`${FAKE_URL}/__requests`)).json()).length;
    check(sent <= 3, `only ${sent} request(s) sent with the bad key (one per parallel worker at most)`);
    await shotPanelArea(page, 'extract-bad-key', page.locator('#lore_graph_extract'), page.locator('#lore_graph_extract_status'));

    await fake('__reset');
    await extractAll(page);
});
