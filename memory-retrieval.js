// Milestone 6b: choosing which story memories to send with a reply.
// Pure JavaScript (no SillyTavern imports) so it can be tested in Node.
//
// Witnesses: in "single" mode the AI plays one character, who only gets memories they
// witnessed, were told about, or that everyone knows. In "narrator" mode nothing is
// filtered; each memory is labelled with who knows it so the narrator can keep secrets.

import { matchForm } from './schema.js';

export const DEFAULT_MEMORY_RETRIEVAL = {
    budget: 600,      // tokens for the "Story so far" block
    recentCount: 3,   // the newest memories the character knows are always considered
};

const KIND_LABELS = { event: 'Event', fact: 'Fact', relationship: 'Relationship', entity: 'Person/place' };
/** Lasting kinds stay useful longer than one-off events. */
const KIND_BONUS = { fact: 0.3, relationship: 0.3, entity: 0.2, event: 0 };

const lower = (s) => String(s ?? '').toLowerCase();

/** Everyone who knows a memory (witnesses plus those told later). */
export function knowersOf(memory) {
    return [...memory.witnesses, ...memory.learned.map(l => l.name)];
}

/** Whether `name` knows this memory. */
export function knows(memory, name) {
    if (memory.everyone) return true;
    const n = lower(name);
    return knowersOf(memory).some(k => lower(k) === n);
}

/**
 * @param {{ memories: object[], mode: 'single'|'narrator' }} state the chat's memory state
 * @param {string[]} messages scanned messages, newest last
 * @param {object} options
 * @param {string} options.character the character the AI is playing (single mode)
 * @param {string[]} [options.loreNames] lore entities matched for this reply (link memories to lore)
 * @param {string[]} [options.meaningIds] memory ids found by meaning search, best first
 * @param {number} [options.budget]
 * @param {number} [options.recentCount]
 * @param {(text: string) => number|Promise<number>} countTokens
 */
export async function selectMemories(state, messages, options, countTokens) {
    const budget = options.budget ?? DEFAULT_MEMORY_RETRIEVAL.budget;
    const recentCount = options.recentCount ?? DEFAULT_MEMORY_RETRIEVAL.recentCount;
    const mode = state.mode === 'narrator' ? 'narrator' : 'single';
    const active = state.memories.filter(m => !m.superseded && m.text);

    const visible = mode === 'single' ? active.filter(m => knows(m, options.character)) : active;
    const hidden = mode === 'single' ? active.filter(m => !knows(m, options.character)) : [];

    const haystack = ` ${matchForm(messages.join(' '))} `;
    const mentioned = (term) => {
        const form = matchForm(term);
        return form.replace(/\s/g, '').length >= 3 && haystack.includes(` ${form} `);
    };
    const loreForms = new Set((options.loreNames ?? []).map(matchForm));
    const meaningRank = new Map((options.meaningIds ?? []).map((id, rank) => [id, rank]));

    // Newer memories score higher; things mentioned now score much higher.
    const recent = new Set(visible.slice(-recentCount));
    const scored = visible.map((memory, position) => {
        const reasons = [];
        let score = 0.3 * ((position + 1) / visible.length) + (KIND_BONUS[memory.kind] ?? 0);
        if (recent.has(memory)) { score += 0.5; reasons.push('recent'); }
        for (const name of memory.characters) {
            if (mentioned(name)) { score += 1; reasons.push(`mentions ${name}`); }
        }
        for (const term of memory.loreTerms) {
            if (mentioned(term)) { score += 1; reasons.push(`mentions ${term}`); }
            else if (loreForms.has(matchForm(term))) { score += 0.6; reasons.push(`linked lore: ${term}`); }
        }
        // Close in meaning to the scene (only boosts memories this character may know).
        if (meaningRank.has(memory.id)) {
            const rank = meaningRank.get(memory.id);
            score += Math.max(0.5, 1 - 0.15 * rank);
            reasons.push(`meaning match #${rank + 1}`);
        }
        return { memory, score, reasons };
    }).sort((a, b) => b.score - a.score);

    // Fill the budget by score, then present in story order.
    const lines = [];
    const selected = [];
    const cut = [];
    let used = 0;
    for (const item of scored) {
        const { memory } = item;
        const label = KIND_LABELS[memory.kind] ?? 'Event';
        const knownTo = mode === 'narrator' ? ` (known to: ${memory.everyone ? 'everyone' : knowersOf(memory).join(', ') || 'unknown'})` : '';
        const line = `- [${label}] ${memory.text}${knownTo}`;
        const tokens = await countTokens(line);
        if (used + tokens > budget) {
            cut.push(item);
            continue;
        }
        used += tokens;
        selected.push({ ...item, line, tokens });
    }
    const order = new Map(state.memories.map((m, i) => [m, i]));
    selected.sort((a, b) => order.get(a.memory) - order.get(b.memory));
    lines.push(...selected.map(s => s.line));

    return {
        mode,
        character: options.character,
        selected,
        cut,
        hidden,
        text: lines.join('\n'),
        tokens: used,
    };
}

/**
 * Story people and places for the graph map (Milestone 6c): one node per character named in
 * the chat's memories, linked to the lore entities their memories mention, and to each other
 * when they share a memory. Lore nodes are left untouched.
 * @param {object[]} memories the chat's memories
 * @param {import('./graph.js').Entity[]} loreEntities
 * @returns {{ entities: object[], edges: object[] }}
 */
export function buildStoryGraph(memories, loreEntities) {
    const loreByForm = new Map();
    for (const entity of loreEntities) {
        for (const name of [entity.name, ...entity.aliases]) {
            const form = matchForm(name);
            if (form && !loreByForm.has(form)) loreByForm.set(form, entity.id);
        }
    }
    const nodes = new Map();
    const node = (name) => {
        const id = `story:${lower(name)}`;
        if (!nodes.has(id)) {
            nodes.set(id, { id, name, type: 'Story', aliases: [], description: '', memories: [], sourceChunks: [], definedIn: [], placeholder: false, story: true });
        }
        return nodes.get(id);
    };
    const edges = new Map();
    const addEdge = (source, target, memory) => {
        const key = `story|${source}|${target}`;
        const edge = edges.get(key);
        if (edge) {
            edge.weight++;
            edge.memories.push(memory.text);
        } else {
            edges.set(key, { id: key, source, target, type: 'story', evidence: memory.text, memories: [memory.text], chunkId: '', chunkIds: [], weight: 1 });
        }
    };

    for (const memory of memories.filter(m => !m.superseded && m.text)) {
        const people = [...new Set(memory.characters)].map(node);
        people.forEach(p => p.memories.push(memory.text));
        for (const person of people) {
            for (const term of memory.loreTerms) {
                const loreId = loreByForm.get(matchForm(term));
                if (loreId) addEdge(person.id, loreId, memory);
            }
        }
        for (let i = 0; i < people.length; i++) {
            for (let j = i + 1; j < people.length; j++) addEdge(people[i].id, people[j].id, memory);
        }
    }
    for (const n of nodes.values()) {
        n.description = n.memories.slice(-3).join(' ');
        n.sourceChunks = [];
    }
    return { entities: [...nodes.values()], edges: [...edges.values()] };
}
