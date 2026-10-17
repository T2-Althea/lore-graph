// Setting-independent helpers for the test list and the meaning-search check (pure, Node-testable).
// A test that expects sections from a document that isn't loaded is skipped, not failed,
// so one list can hold tests for several settings and only the relevant ones run.

/**
 * The document a chunk id belongs to ("COS-004 §16 Undead In Dungeons" → "COS-004").
 * @param {string} chunkId
 */
export function docOfChunkId(chunkId) {
    const i = chunkId.indexOf(' §');
    return i === -1 ? chunkId : chunkId.slice(0, i);
}

/** Chunk ids count as matching when equal, or when a split chunk's parts share the id. */
export const sameChunk = (expectedId, actualId) => actualId === expectedId || actualId.startsWith(`${expectedId} (part `);

/**
 * Decides whether a test can run with the loaded lore.
 * @param {{ expected: string[], nothing: boolean }} test
 * @param {string[]} chunkIds ids of the loaded (active) chunks
 * @returns {{ runnable: boolean, needs: string[], gone: string[] }}
 *   needs = documents the test expects that aren't loaded (the test is skipped);
 *   gone = expected sections whose document is loaded but which no longer exist (renamed or removed)
 */
export function checkTestRunnable(test, chunkIds) {
    if (test.nothing) return { runnable: true, needs: [], gone: [] };
    const loadedDocs = new Set(chunkIds.map(docOfChunkId));
    const needs = [...new Set(test.expected.map(docOfChunkId).filter(doc => !loadedDocs.has(doc)))];
    const gone = test.expected.filter(id => loadedDocs.has(docOfChunkId(id)) && !chunkIds.some(c => sameChunk(id, c)));
    return { runnable: needs.length === 0, needs, gone };
}

/**
 * Outcome of a test run.
 * @param {{ expected: string[], nothing: boolean }} test
 * @param {string[]} injected chunk ids that were sent (full or TL;DR)
 */
export function judgeTest(test, injected) {
    const missing = test.nothing ? [] : test.expected.filter(id => !injected.some(i => sameChunk(id, i)));
    const pass = test.nothing ? injected.length === 0 : missing.length === 0;
    return { pass, missing };
}

/** Lines that should never pull in lore, whatever the setting. */
export const CASUAL_LINES = [
    'Haha, nice weather today. Want to grab some food and talk about your family?',
    'Thanks for waiting. I\'m going to sleep now, see you in the morning.',
];

function firstSentences(text, maxChars = 300) {
    const sentences = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
    let out = '';
    for (const s of sentences) {
        if (out && (out + ' ' + s).length > maxChars) break;
        out = out ? `${out} ${s}` : s;
    }
    return out.slice(0, maxChars);
}

/** Sections are identified by document + section number (subsections share their section's TL;DR). */
export const sectionKey = (chunk) => `${chunk.docId} §${chunk.sectionNumber ?? '?'}`;

/**
 * Picks sanity-check searches from the loaded lore itself: each picked section's TL;DR (or its
 * first sentences when it has none) should find that section near the top. Spread across
 * documents and through each document, so it works for any setting.
 * @param {import('./parser.js').LoreChunk[]} chunks active chunks
 * @param {number} [count]
 * @returns {{ query: string, section: string, label: string }[]}
 */
export function pickSanityQueries(chunks, count = 6) {
    /** @type {Map<string, Map<string, import('./parser.js').LoreChunk>>} doc -> section key -> first chunk */
    const byDoc = new Map();
    for (const chunk of chunks) {
        if (!byDoc.has(chunk.docId)) byDoc.set(chunk.docId, new Map());
        const sections = byDoc.get(chunk.docId);
        const key = sectionKey(chunk);
        if (!sections.has(key)) sections.set(key, chunk);
    }
    const lists = [...byDoc.values()].map(sections => {
        const all = [...sections.values()].filter(c => (c.tldr || c.text).trim());
        // Every n-th section, so the picks cover the whole document, not just its start.
        const step = Math.max(1, Math.floor(all.length / Math.ceil(count / Math.max(1, byDoc.size))));
        return all.filter((_, i) => i % step === Math.floor(step / 2));
    });
    const picked = [];
    for (let round = 0; picked.length < count && lists.some(l => l.length > round); round++) {
        for (const list of lists) {
            if (picked.length < count && list[round]) picked.push(list[round]);
        }
    }
    return picked.map(chunk => ({
        query: firstSentences(chunk.tldr || chunk.text),
        section: sectionKey(chunk),
        label: `${chunk.docId} §${chunk.sectionNumber ?? '?'} ${chunk.sectionTitle}`,
    }));
}

// ---------------------------------------------------------------- "Suggest tests"

export const SUGGEST_KINDS = {
    names: 'Uses lore names',
    meaning: 'No lore names (meaning search)',
    casual: 'Casual: should inject nothing',
};

/**
 * Sections to show the AI when suggesting tests: ones no test covers yet first, spread over
 * the documents, at most `limit`.
 * @param {import('./parser.js').LoreChunk[]} chunks active chunks
 * @param {{ expected: string[] }[]} tests existing tests
 * @param {number} [limit]
 * @returns {{ id: string, summary: string }[]}
 */
export function pickSectionsForSuggestions(chunks, tests, limit = 30) {
    const covered = new Set(tests.flatMap(t => t.expected));
    const isCovered = (chunk) => [...covered].some(id => sameChunk(id, chunk.id));
    const byDoc = new Map();
    for (const chunk of chunks) {
        if (chunk.part > 1) continue; // one entry per split chunk
        if (!byDoc.has(chunk.docId)) byDoc.set(chunk.docId, []);
        byDoc.get(chunk.docId).push(chunk);
    }
    const lists = [...byDoc.values()].map(list => [...list.filter(c => !isCovered(c)), ...list.filter(isCovered)]);
    const picked = [];
    for (let round = 0; picked.length < limit && lists.some(l => l.length > round); round++) {
        for (const list of lists) {
            if (picked.length < limit && list[round]) picked.push(list[round]);
        }
    }
    const baseId = (chunk) => chunk.partCount > 1 ? chunk.id.replace(/ \(part \d+\/\d+\)$/, '') : chunk.id;
    return picked.map(chunk => ({
        id: baseId(chunk),
        summary: [chunk.subsectionTitle ? `${chunk.sectionTitle} > ${chunk.subsectionTitle}` : chunk.sectionTitle, firstSentences(chunk.tldr || chunk.text, 240), chunk.subsectionTitle ? firstSentences(chunk.text, 200) : ''].filter(Boolean).join('\n'),
    }));
}

/**
 * Cleans the AI's suggestions: known section ids only, no duplicates of existing tests.
 * @param {any} data parsed reply
 * @param {string[]} allowedIds section ids that were offered
 * @param {{ text: string }[]} tests existing tests
 * @returns {{ text: string, expected: string[], kind: string }[]}
 */
export function cleanSuggestions(data, allowedIds, tests) {
    const allowed = new Set(allowedIds);
    const seen = new Set(tests.map(t => t.text.trim().toLowerCase()));
    const out = [];
    for (const raw of Array.isArray(data?.tests) ? data.tests : []) {
        const text = String(raw?.text ?? '').trim().slice(0, 600);
        const kind = Object.hasOwn(SUGGEST_KINDS, raw?.kind) ? raw.kind : 'names';
        const expected = kind === 'casual' ? [] : [...new Set((Array.isArray(raw?.expected) ? raw.expected : []).map(String).filter(id => allowed.has(id)))];
        if (!text || seen.has(text.toLowerCase())) continue;
        if (kind !== 'casual' && !expected.length) continue;
        seen.add(text.toLowerCase());
        out.push({ text, expected, kind });
    }
    return out;
}
