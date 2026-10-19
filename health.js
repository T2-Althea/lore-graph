// Health check: points at the lore and graph spots most likely to cause bad retrieval,
// such as documents nothing links to, names two entities share, and names too short to match.
// Pure JavaScript (testable in Node); health-view.js draws the popup.

/**
 * @param {object} args
 * @param {{ entities: import('./graph.js').Entity[], edges: import('./graph.js').Edge[] }} args.graph graph of the active chunks
 * @param {import('./parser.js').LoreChunk[]} args.chunks active chunks
 * @param {Record<string, any>} args.chunkResults extraction results by chunk id
 * @param {{ names: { form: string, name: string, entityId: string, mode: string }[], tooShort: { name: string, entityId: string }[] }} args.index retrieval index
 * @param {Set<string>} args.knownChunkIds chunk ids of every lore file the extension knows
 * @param {number} [args.budget] the lore token budget
 */
export function computeHealth({ graph, chunks, chunkResults, index, knownChunkIds, budget = Infinity }) {
    const byId = new Map(graph.entities.map(e => [e.id, e]));
    const chunkById = new Map(chunks.map(c => [c.id, c]));
    const docOfChunk = (id) => chunkById.get(id)?.docId ?? String(id).split(' §')[0];

    // Sections: not extracted, failed, or extracted with nothing in them.
    const notExtracted = [];
    const failed = [];
    const empty = [];
    const outdated = [];
    for (const chunk of chunks) {
        const result = chunkResults[chunk.id];
        if (!result) notExtracted.push(chunk.id);
        else if (result.status === 'failed') failed.push({ id: chunk.id, error: result.error ?? '' });
        else if (result.hash !== chunk.hash) outdated.push(chunk.id);
        else if (!(result.entities?.length)) empty.push(chunk.id);
    }

    // Entities with no relationships: graph expansion can never reach them.
    const linked = new Set(graph.edges.flatMap(e => [e.source, e.target]));
    const isolated = graph.entities.filter(e => !linked.has(e.id) && !e.placeholder)
        .map(e => ({ name: e.name, type: e.type, chunk: e.definedIn[0] ?? e.sourceChunks[0] }));

    // Placeholders: referenced, defined nowhere. The more sections mention one, the more it matters.
    const placeholders = graph.entities.filter(e => e.placeholder)
        .map(e => ({ name: e.name, mentions: e.sourceChunks.length, chunk: e.sourceChunks[0] }))
        .sort((a, b) => b.mentions - a.mentions);

    // One name, several entities: whichever matches first wins, the other is invisible to that name.
    const entitiesByForm = new Map();
    for (const { form, name, entityId } of index.names) {
        if (!entitiesByForm.has(form)) entitiesByForm.set(form, new Map());
        entitiesByForm.get(form).set(entityId, name);
    }
    const sharedNames = [...entitiesByForm].filter(([, ids]) => ids.size > 1)
        .map(([, ids]) => ({ name: [...ids.values()][0], entities: [...ids.keys()].map(id => byId.get(id)?.name ?? id) }));

    // Names that never match because they're too short (unless marked safe).
    const tooShort = index.tooShort.map(t => ({ name: t.name, entity: byId.get(t.entityId)?.name ?? t.entityId }));

    // Documents with no relationship to any other document: their lore is only found by naming
    // their own terms (the lesson of the "field exception report" link).
    const docs = [...new Set(chunks.map(c => c.docId))];
    const homeDocs = (entity) => new Set((entity.definedIn.length ? entity.definedIn : entity.sourceChunks).map(docOfChunk));
    const crossLinks = new Map(docs.map(d => [d, 0]));
    for (const entity of graph.entities) {
        // An entity mentioned in several documents links them too.
        const mentionedIn = new Set(entity.sourceChunks.filter(id => chunkById.has(id)).map(docOfChunk));
        if (mentionedIn.size > 1) for (const d of mentionedIn) crossLinks.set(d, (crossLinks.get(d) ?? 0) + 1);
    }
    for (const edge of graph.edges) {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) continue;
        const da = homeDocs(a);
        const db = homeDocs(b);
        if ([...da].some(d => !db.has(d))) {
            for (const d of new Set([...da, ...db])) crossLinks.set(d, (crossLinks.get(d) ?? 0) + 1);
        }
    }
    const isolatedDocs = docs.length > 1 ? docs.filter(d => !crossLinks.get(d)) : [];

    // Sections bigger than the whole budget can only ever be sent as their TL;DR.
    const tooBig = chunks.filter(c => c.tokens > budget).map(c => ({ id: c.id, tokens: c.tokens }));

    // Saved results for sections in no known lore file (left over after files were removed).
    const leftover = Object.keys(chunkResults).filter(id => !knownChunkIds.has(id)).length;

    const problems = notExtracted.length + failed.length + outdated.length + isolatedDocs.length + sharedNames.length + tooBig.length;
    return { notExtracted, failed, empty, outdated, isolated, placeholders, sharedNames, tooShort, isolatedDocs, tooBig, budget, leftover, problems, documents: docs.length, sections: chunks.length };
}
