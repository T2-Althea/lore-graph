// The ordinary-word rule, topics in play, and sticky lore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { retrieve, buildRetrievalIndex, setOrdinaryWords } from '../../retrieval.js';
import { FIXTURES, buildIndexWithFakeAi, countTokens, loadChunks } from './helpers.js';

const files = [path.join(FIXTURES, 'Tide_Temple.txt'), path.join(FIXTURES, 'Marsh_Wardens.txt')];
const opts = (extra = {}) => ({ messages: 4, hops: 2, budget: 1500, ...extra });
const sent = (report) => report.chunks.filter(c => c.status === 'full' || c.status === 'tldr');

async function setup() {
    const chunks = await loadChunks(files);
    const { graph } = buildIndexWithFakeAi(chunks);
    const wraith = graph.entities.find(e => /^wraiths?$/i.test(e.name));
    assert.ok(wraith, 'fixture should have a Wraith entity');
    return { chunks, graph, wraith };
}

test('ordinary-word rule: one-word English names need a lore term nearby; your own choice wins', async () => {
    const { chunks, graph, wraith } = await setup();
    setOrdinaryWords(['wraith', 'wraiths', 'seal']);
    try {
        const ruled = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [] });
        const alone = await retrieve(ruled, ['A wraith rose from the mud.'], opts(), countTokens, null);
        assert.equal(alone.seeds.length, 0, 'an ordinary word alone should not count');
        assert.ok(alone.ignored.some(i => i.entityId === wraith.id));

        const near = await retrieve(ruled, ['The Marsh Wardens fought a wraith.'], opts(), countTokens, null);
        assert.ok(near.seeds.some(s => s.entityId === wraith.id), 'a multi-word lore name nearby lets it count');

        const chosen = buildRetrievalIndex(graph, chunks, { modes: { wraith: 'always' }, safeAliases: [], checkedNames: [] });
        const own = await retrieve(chosen, ['A wraith rose from the mud.'], opts(), countTokens, null);
        assert.ok(own.seeds.some(s => s.entityId === wraith.id), 'a name the user set to Always counts alone');
    } finally {
        setOrdinaryWords(null);
    }
});

test('topics in play: an everyday name counts when its own entity fired recently', async () => {
    const { chunks, graph, wraith } = await setup();
    const index = buildRetrievalIndex(graph, chunks, { modes: { wraith: 'context' }, safeAliases: [], checkedNames: [] });
    const without = await retrieve(index, ['A wraith rose from the mud.'], opts(), countTokens, null);
    assert.equal(without.seeds.length, 0);

    const recent = { topics: new Map([[wraith.name.toLowerCase(), 3]]), sticky: [] };
    const withTopic = await retrieve(index, ['A wraith rose from the mud.'], opts({ recent }), countTokens, null);
    const seed = withTopic.seeds.find(s => s.entityId === wraith.id);
    assert.ok(seed, 'topic in play should let the everyday name count');
    assert.equal(seed.inPlay, 3);
    assert.ok(sent(withTopic).some(c => /Wraiths/.test(c.id)));
});

test('sticky lore: last reply\'s sections stay for casual lines, ranked below anything named', async () => {
    const { chunks, graph } = await setup();
    const index = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [] });
    const wraithChunk = chunks.find(c => /Wraiths/.test(c.id)).id;
    const recent = { topics: new Map(), sticky: [{ id: wraithChunk, repliesAgo: 1 }] };

    const casual = await retrieve(index, ['Nice weather today.'], opts({ recent }), countTokens, null);
    assert.deepEqual(sent(casual).map(c => c.id), [wraithChunk]);
    assert.equal(sent(casual)[0].sticky, true, 'marked as sticky so it is not carried forward again');

    const named = await retrieve(index, ['The Marsh Wardens showed the Warden\'s Seal at the gate.'], opts({ recent }), countTokens, null);
    const order = sent(named).map(c => c.id);
    assert.ok(order.length > 1 && order.indexOf(wraithChunk) !== 0, 'named sections come before sticky ones');

    const off = await retrieve(index, ['Nice weather today.'], opts(), countTokens, null);
    assert.equal(sent(off).length, 0, 'without recent replies nothing is sticky');
});

test('topics in play: a short name ("Sea") fires only while its own topic is in play', async () => {
    const { chunks, graph } = await setup();
    const sea = graph.entities.find(e => /^(the )?sea$/i.test(e.name));
    assert.ok(sea, 'fixture should have a Sea entity');
    const index = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [] });
    const quiet = await retrieve(index, ['The sea feels strange tonight.'], opts(), countTokens, null);
    assert.equal(quiet.seeds.length, 0, 'too short to count normally');
    const recent = { topics: new Map([[sea.name.toLowerCase(), 2]]), sticky: [] };
    const inPlay = await retrieve(index, ['The sea feels strange tonight.'], opts({ recent }), countTokens, null);
    assert.ok(inPlay.seeds.some(s => s.entityId === sea.id && s.inPlay === 2));
});

test('trigger phrases send their section; "a + b" needs both words; Only when named blocks meaning', async () => {
    const { chunks, graph } = await setup();
    const abyss = chunks.find(c => /Abyss/.test(c.id)).id;
    const index = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [], chunkTriggers: { [abyss]: ['sunken oath', 'ocean + creature'] }, namedOnlyChunks: [abyss] });
    const ids = async (text, meaning = null) => sent(await retrieve(index, [text], opts(), countTokens, meaning)).map(c => c.id);

    assert.ok((await ids('She whispered a sunken oath.')).includes(abyss));
    assert.ok((await ids('The ocean is full of scary creatures.')).includes(abyss), 'both parts, plural ok');
    assert.ok(!(await ids('The ocean was calm.')).includes(abyss), 'one part is not enough');
    const report = await retrieve(index, ['She whispered a sunken oath.'], opts(), countTokens, null);
    assert.equal(report.triggered[0]?.phrase, 'sunken oath');

    const meaning = { chunks: [{ id: abyss, rank: 0, weak: false, alone: true }], entities: [] };
    assert.ok(!(await ids('Something dark lies below.', meaning)).includes(abyss), 'Only when named: never by meaning alone');
});

test('stop phrases hold back sections that came in indirectly, but not ones the chat names', async () => {
    const { chunks, graph } = await setup();
    const abyss = chunks.find(c => /Abyss/.test(c.id)).id;
    const meaning = { chunks: [{ id: abyss, rank: 0, weak: false }], entities: [] };
    const plain = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [] });
    const stopping = buildRetrievalIndex(graph, chunks, { modes: {}, safeAliases: [], checkedNames: [], chunkStopPhrases: { [abyss]: ['wardens'] } });
    const run = (index, text) => retrieve(index, [text], opts(), countTokens, meaning);

    const scene = 'The Marsh Wardens rested by the fire.';
    assert.ok(sent(await run(plain, scene)).some(c => c.id === abyss), 'sent by meaning without a stop phrase');
    const held = await run(stopping, scene);
    assert.ok(!sent(held).some(c => c.id === abyss), 'held back by the stop phrase');
    assert.equal(held.chunks.find(c => c.id === abyss)?.status, 'stopped');
    assert.equal(held.chunks.find(c => c.id === abyss)?.stopPhrase, 'wardens');

    const named = await run(stopping, 'The Marsh Wardens rested while the Tide Temple priests spoke of the Abyss.');
    assert.ok(sent(named).some(c => c.id === abyss), 'still sent when the chat names what the section is about');
});
