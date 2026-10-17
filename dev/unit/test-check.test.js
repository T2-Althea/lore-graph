import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { checkTestRunnable, cleanSuggestions, docOfChunkId, judgeTest, pickSanityQueries, pickSectionsForSuggestions, sectionKey } from '../../test-check.js';
import { FIXTURES, PRIVATE_LORE, loadChunks } from './helpers.js';

const marsh = path.join(FIXTURES, 'Marsh_Wardens.txt');
const station = path.join(FIXTURES, 'Orbital_Station.txt');

test('docOfChunkId takes the part before " §"', () => {
    assert.equal(docOfChunkId('COS-004 §16 Undead In Dungeons'), 'COS-004');
    assert.equal(docOfChunkId('Orbital_Station §2 The Drill (part 1/2)'), 'Orbital_Station');
});

test('a test for a document that is not loaded is skipped, naming the document', async () => {
    const ids = (await loadChunks([marsh])).map(c => c.id);
    const r = checkTestRunnable({ expected: ['COS-004 §16 Undead In Dungeons', 'COS-006 §5 Contracts'], nothing: false }, ids);
    assert.equal(r.runnable, false);
    assert.deepEqual(r.needs, ['COS-004', 'COS-006']);
});

test('a test spanning a loaded and a missing document is skipped', async () => {
    const ids = (await loadChunks([marsh])).map(c => c.id);
    const r = checkTestRunnable({ expected: ['MW-001 §3 Wraiths', 'COS-004 §3 Smell'], nothing: false }, ids);
    assert.equal(r.runnable, false);
    assert.deepEqual(r.needs, ['COS-004']);
});

test('a test whose section was renamed runs (and reports it gone) instead of being skipped', async () => {
    const ids = (await loadChunks([marsh])).map(c => c.id);
    const r = checkTestRunnable({ expected: ['MW-001 §3 Wraiths', 'MW-001 §9 Old Name'], nothing: false }, ids);
    assert.equal(r.runnable, true);
    assert.deepEqual(r.gone, ['MW-001 §9 Old Name']);
});

test('"inject nothing" tests always run, whatever is loaded', () => {
    assert.equal(checkTestRunnable({ expected: [], nothing: true }, []).runnable, true);
});

test('split chunks match their base id', () => {
    const ids = ['X §1 Big (part 1/2)', 'X §1 Big (part 2/2)'];
    assert.equal(checkTestRunnable({ expected: ['X §1 Big'], nothing: false }, ids).gone.length, 0);
    assert.deepEqual(judgeTest({ expected: ['X §1 Big'], nothing: false }, ['X §1 Big (part 2/2)']), { pass: true, missing: [] });
});

test('judgeTest: nothing-tests fail when anything is injected', () => {
    assert.equal(judgeTest({ expected: [], nothing: true }, []).pass, true);
    assert.equal(judgeTest({ expected: [], nothing: true }, ['A §1 B']).pass, false);
    assert.deepEqual(judgeTest({ expected: ['A §1 B', 'A §2 C'], nothing: false }, ['A §1 B']).missing, ['A §2 C']);
});

test('sanity queries come from the loaded lore and cover every document', async () => {
    const chunks = await loadChunks([marsh, station]);
    const queries = pickSanityQueries(chunks);
    assert.ok(queries.length >= 4 && queries.length <= 6, `got ${queries.length}`);
    const docs = new Set(queries.map(q => q.section.split(' §')[0]));
    assert.deepEqual([...docs].sort(), ['MW-001', 'Orbital_Station']);
    for (const q of queries) {
        const chunk = chunks.find(c => sectionKey(c) === q.section);
        assert.ok(chunk.tldr.startsWith(q.query.slice(0, 20)), 'query is the section TL;DR');
    }
    // Different sections, no repeats.
    assert.equal(new Set(queries.map(q => q.section)).size, queries.length);
});

test('sanity queries fall back to the text when a section has no TL;DR', () => {
    const chunks = [{ id: 'D §1 A', docId: 'D', sectionNumber: 1, sectionTitle: 'A', tldr: '', text: 'First sentence here. Second one.', part: 1 }];
    assert.equal(pickSanityQueries(chunks)[0].query, 'First sentence here. Second one.');
});

test('sanity queries spread over a long document', { skip: !fs.existsSync(PRIVATE_LORE) && 'private lore not present' }, async () => {
    const chunks = await loadChunks([path.join(PRIVATE_LORE, 'Ex-Zone_Codex.txt')]);
    const numbers = pickSanityQueries(chunks).map(q => Number(q.section.split('§')[1]));
    assert.equal(numbers.length, 6);
    assert.ok(Math.max(...numbers) >= 12, `picks reach the later sections: ${numbers}`);
});

test('suggestion sections prefer ones no test covers yet', async () => {
    const chunks = await loadChunks([marsh, station]);
    const picked = pickSectionsForSuggestions(chunks, [{ expected: ['MW-001 §3 Wraiths'] }], 4);
    assert.equal(picked.length, 4);
    assert.ok(!picked.some(p => p.id === 'MW-001 §3 Wraiths'));
    assert.ok(picked.some(p => p.id.startsWith('Orbital_Station')) && picked.some(p => p.id.startsWith('MW-001')));
});

test('cleanSuggestions drops unknown sections, duplicates and empty lines', () => {
    const out = cleanSuggestions({
        tests: [
            { text: 'The gate keeper squinted at my seal.', expected: ['MW-001 §2 The Seal Itself', 'NOPE §1'], kind: 'names' },
            { text: 'Only an unknown section.', expected: ['NOPE §1'], kind: 'names' },
            { text: 'Nice weather.', expected: ['MW-001 §3 Wraiths'], kind: 'casual' },
            { text: 'existing line', expected: ['MW-001 §3 Wraiths'], kind: 'names' },
            { text: '   ', expected: ['MW-001 §3 Wraiths'], kind: 'meaning' },
        ],
    }, ['MW-001 §2 The Seal Itself', 'MW-001 §3 Wraiths'], [{ text: 'Existing line' }]);
    assert.deepEqual(out, [
        { text: 'The gate keeper squinted at my seal.', expected: ['MW-001 §2 The Seal Itself'], kind: 'names' },
        { text: 'Nice weather.', expected: [], kind: 'casual' },
    ]);
});
