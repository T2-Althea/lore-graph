// "Capital letter only" matching: "the Sea" is a lore name, "sea water" is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { countNameCasing, hasCapitalisedUse, hideLowercaseCapitalNames, looksCapitalisedInLore, retrieve, buildRetrievalIndex } from '../../retrieval.js';
import { FIXTURES, buildIndexWithFakeAi, countTokens, loadChunks } from './helpers.js';

test('a capital letter counts only away from the start of a sentence', () => {
    assert.equal(hasCapitalisedUse('We sailed toward the Sea at dawn.', 'Sea'), true);
    assert.equal(hasCapitalisedUse('The Abyss opened below us.', 'the Abyss'), true);
    assert.equal(hasCapitalisedUse('*The Abyss stares back.*', 'Abyss'), true);
    assert.equal(hasCapitalisedUse('A cup of sea water.', 'Sea'), false);
    assert.equal(hasCapitalisedUse('Sea spray hit the deck.', 'Sea'), false, 'sentence start');
    assert.equal(hasCapitalisedUse('"Abyss take you!" she shouted.', 'Abyss'), false, 'start of a quote');
    assert.equal(hasCapitalisedUse('It was calm.\nSea birds circled.', 'Sea'), false, 'start of a line');
    assert.equal(hasCapitalisedUse('the old Seas of the north', 'Sea'), true, 'plural');
    assert.equal(hasCapitalisedUse('the Seaward gate', 'Sea'), false, 'part of a longer word');
});

test('the lore\'s own casing is counted, sentence starts ignored', async () => {
    const chunks = await loadChunks([path.join(FIXTURES, 'Tide_Temple.txt')]);
    const texts = chunks.map(c => [c.tldr, c.text].join('\n'));
    const sea = countNameCasing(texts, 'Sea');
    assert.ok(sea.capitalised >= 5 && sea.lowercase === 0, JSON.stringify(sea));
    assert.ok(looksCapitalisedInLore(sea));
    const water = countNameCasing(texts, 'water');
    assert.ok(!looksCapitalisedInLore(water), JSON.stringify(water));
});

async function injected(index, text) {
    const report = await retrieve(index, [text], { messages: 4, hops: 2, budget: 1500 }, countTokens, null);
    return { ids: report.chunks.filter(c => c.status === 'full' || c.status === 'tldr').map(c => c.id), report };
}

test('Capital letter only: capitalised counts, lowercase needs a lore term nearby', async () => {
    const chunks = await loadChunks([path.join(FIXTURES, 'Tide_Temple.txt'), path.join(FIXTURES, 'Marsh_Wardens.txt')]);
    const { graph } = buildIndexWithFakeAi(chunks);
    const matching = { modes: { sea: 'capital', abyss: 'capital' }, safeAliases: [], checkedNames: [] };
    const index = buildRetrievalIndex(graph, chunks, matching);

    const capital = await injected(index, 'We swore by the Sea before we set out.');
    assert.ok(capital.ids.includes('TT-001 §1 The Sea'), capital.ids.join(', '));
    assert.equal(capital.report.seeds.find(s => s.name === 'Sea')?.capitalised, true);

    const lower = await injected(index, 'She handed me a cup of sea water.');
    assert.deepEqual(lower.ids, []);
    assert.match(lower.report.ignored.find(i => i.name === 'Sea')?.reason ?? '', /without a capital letter/);

    const start = await injected(index, 'Sea spray soaked my boots.');
    assert.deepEqual(start.ids, [], 'a capital at the start of a sentence is not enough');

    const vouched = await injected(index, 'The Marsh Wardens dumped sea water on the fire.');
    assert.ok(vouched.ids.includes('TT-001 §1 The Sea'), 'lowercase still counts next to a clear lore term');

    // Without the mode (and "Sea" marked safe despite being short), every "sea" matches.
    const plain = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: ['sea'], checkedNames: [] });
    const short = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [] });
    assert.deepEqual((await injected(short, 'We swore by the Sea.')).ids, [], 'short names are skipped unless safe or Capital letter only');
    assert.ok((await injected(plain, 'She handed me a cup of sea water.')).ids.includes('TT-001 §1 The Sea'));
});

test('meaning search only sees capitalised uses; the strict mode also hides sentence starts', () => {
    const plain = { names: [{ name: 'the Abyss', mode: 'capital' }] };
    const strict = { names: [{ name: 'the Abyss', mode: 'capital_strict' }] };
    assert.equal(hideLowercaseCapitalNames(plain, 'He stared into the abyss.'), 'He stared into the .');
    assert.equal(hideLowercaseCapitalNames(plain, 'He stared into the Abyss.'), 'He stared into the Abyss.');
    assert.equal(hideLowercaseCapitalNames(plain, 'Abyss take you!'), 'Abyss take you!');
    assert.equal(hideLowercaseCapitalNames(strict, 'Abyss take you!'), ' take you!');
    assert.equal(hideLowercaseCapitalNames(strict, '"Abyss," she said.'), '"," she said.');
    assert.equal(hideLowercaseCapitalNames(strict, 'He stared into the Abyss.'), 'He stared into the Abyss.');
});
