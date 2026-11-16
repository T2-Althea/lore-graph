// Aliases never join two things that are each defined under their own name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../../graph.js';

const entity = (name, aliases = [], defined_here = true) => ({ name, type: 'Object', aliases, description: `${name}.`, defined_here });
const store = (results, merges = []) => ({
    chunkResults: Object.fromEntries(results.map((entities, i) => [`R-001 §${i + 1} S${i + 1}`, { status: 'ok', entities, relations: [] }])),
    decisions: { merges, rejected: [], pending: [] },
});

test('an alias does not fold a defined kind into the general term (or kinds into each other)', () => {
    const s = store([
        [entity('Relic')],
        [entity('Profane Relic')],
        [entity('Divine Relic')],
        [entity('Relic', ['Profane Relic', 'divine Relic'], false)], // one bad result
    ]);
    const g = buildGraph(s, Object.keys(s.chunkResults));
    const names = g.entities.map(e => e.name).sort();
    assert.deepEqual(names, ['Divine Relic', 'Profane Relic', 'Relic']);
    assert.deepEqual(g.entities.find(e => e.name === 'Relic').aliases, [], 'refused aliases are not kept as nicknames');
});

test('aliases still merge a defined thing with names nobody defines separately', () => {
    const s = store([[entity('Hollow Court', ['the Court'])], [entity('the Court', [], false)]]);
    const g = buildGraph(s, Object.keys(s.chunkResults));
    assert.equal(g.entities.length, 1);
    assert.equal(g.entities[0].sourceChunks.length, 2);
});

test('merges the user approved always apply', () => {
    const s = store([[entity('S-Rank')], [entity('S-Rank, Singular Designation', ['S-Rank'])]], [['s rank', 's rank singular designation']]);
    const g = buildGraph(s, Object.keys(s.chunkResults));
    assert.equal(g.entities.length, 1);
});
