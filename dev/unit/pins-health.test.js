// Pinned/blocked sections and the health check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { retrieve, buildRetrievalIndex } from '../../retrieval.js';
import { computeHealth } from '../../health.js';
import { FIXTURES, buildIndexWithFakeAi, countTokens, loadChunks } from './helpers.js';

const files = [path.join(FIXTURES, 'Tide_Temple.txt'), path.join(FIXTURES, 'Marsh_Wardens.txt')];
const sent = (report) => report.chunks.filter(c => c.status === 'full' || c.status === 'tldr');

test('a pinned section is sent even in casual chat; a blocked one never is', async () => {
    const chunks = await loadChunks(files);
    const { graph } = buildIndexWithFakeAi(chunks);
    const pin = chunks.at(-1).id;
    const index = buildRetrievalIndex(graph, chunks, { modes: { sea: 'capital' }, safeAliases: [], checkedNames: [], pinnedChunks: [pin], blockedChunks: ['TT-001 §1 The Sea'] });

    const casual = await retrieve(index, ['Nice weather today.'], { messages: 4, hops: 2, budget: 1500 }, countTokens, null);
    assert.deepEqual(sent(casual).map(c => c.id), [pin]);
    assert.equal(sent(casual)[0].pinned, true);

    const sea = await retrieve(index, ['We swore by the Sea before we set out.'], { messages: 4, hops: 2, budget: 1500 }, countTokens, null);
    assert.ok(!sent(sea).some(c => c.id === 'TT-001 §1 The Sea'), 'blocked section was sent');
    assert.ok(sea.chunks.some(c => c.id === 'TT-001 §1 The Sea' && c.status === 'blocked'), 'blocked section should be listed as blocked');
});

test('the health check finds missing extraction, oversized sections and leftover results', async () => {
    const chunks = await loadChunks(files);
    const { graph, store } = buildIndexWithFakeAi(chunks);
    const index = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [] });
    const results = { ...store.chunkResults, 'OLD-1 §1 Gone': { status: 'ok', entities: [], relations: [], hash: 'x' } };
    delete results[chunks[0].id];
    const health = computeHealth({ graph, chunks, chunkResults: results, index, knownChunkIds: new Set(chunks.map(c => c.id)), budget: 10 });
    assert.deepEqual(health.notExtracted, [chunks[0].id]);
    assert.equal(health.leftover, 1);
    assert.ok(health.tooBig.length > 0, 'every fixture section is bigger than a 10-token budget');
    assert.ok(health.problems > 0);
});
