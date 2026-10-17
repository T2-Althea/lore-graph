// End-to-end retrieval on invented lore from two different settings, no SillyTavern needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { retrieve } from '../../retrieval.js';
import { checkTestRunnable, judgeTest, CASUAL_LINES } from '../../test-check.js';
import { FIXTURES, buildIndexWithFakeAi, countTokens, loadChunks } from './helpers.js';

const settings = { messages: 4, hops: 2, budget: 1500 };
const files = [path.join(FIXTURES, 'Marsh_Wardens.txt'), path.join(FIXTURES, 'Orbital_Station.txt')];

async function injectedFor(index, text) {
    const report = await retrieve(index, [text], settings, countTokens, null);
    return report.chunks.filter(c => c.status === 'full' || c.status === 'tldr').map(c => c.id);
}

test('names from each setting pull in their own sections', async () => {
    const chunks = await loadChunks(files);
    const { index } = buildIndexWithFakeAi(chunks);
    const seal = await injectedFor(index, 'The keeper turned my Warden\'s Seal over in his hand before lifting the bar.');
    assert.ok(seal.some(id => id.startsWith('MW-001 §2')), seal.join(', '));
    const market = await injectedFor(index, 'I traded two shifts of credits at the Spinward Market.');
    assert.ok(market.includes('Orbital_Station §3 The Spinward Market'), market.join(', '));
    assert.ok(!market.some(id => id.startsWith('MW-001')), 'no cross-setting leak');
});

test('casual lines pull in nothing', async () => {
    const { index } = buildIndexWithFakeAi(await loadChunks(files));
    for (const line of CASUAL_LINES) assert.deepEqual(await injectedFor(index, line), []);
});

test('a mixed test list: other-setting tests skip, own tests run', async () => {
    const chunks = await loadChunks([files[1]]);
    const { index } = buildIndexWithFakeAi(chunks);
    const ids = chunks.map(c => c.id);
    const tests = [
        { text: 'The wraiths drifted toward our fire.', expected: ['MW-001 §3 Wraiths'], nothing: false },
        { text: 'The klaxon sounded twice and I grabbed my hood for the Vacuum Drills.', expected: ['Orbital_Station §2 The Drill'], nothing: false },
        { text: CASUAL_LINES[0], expected: [], nothing: true },
    ];
    const outcomes = [];
    for (const t of tests) {
        const r = checkTestRunnable(t, ids);
        outcomes.push(r.runnable ? (judgeTest(t, await injectedFor(index, t.text)).pass ? 'pass' : 'fail') : `skip:${r.needs}`);
    }
    assert.deepEqual(outcomes, ['skip:MW-001', 'pass', 'pass']);
});
