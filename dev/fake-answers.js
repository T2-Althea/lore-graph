// Scripted answers for the fake AI (see fake-backend.js). Pure functions, also used by unit tests.

const DIM = 512;

const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those '
    + 'there their they them he she his her we our you your i me my not no do does did so than then into over under up out about '
    + 'can could will would should may might must has have had any all each every some such what which who whom when where why how '
    + 'one two also only just more most much many other same own very too here within without between through after before while '
    + 'instruct query given roleplay scene retrieve lore sections earlier story events relevant happening now').split(/\s+/));

export function words(text) {
    return String(text).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.filter(w => w.length > 2 && !STOP.has(w))
        .map(w => w.replace(/(ies)$/, 'y').replace(/(?<=[^s])s$/, '')) ?? [];
}

function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function embed(text) {
    // Queries carry an instruction prefix ("Instruct: … Query: …"); only the query part counts.
    const body = String(text).includes('Query: ') ? String(text).split('Query: ').pop() : String(text);
    const v = new Array(DIM).fill(0);
    const counts = new Map();
    for (const w of words(body)) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const [w, n] of counts) v[hash(w) % DIM] += 1 + Math.log(n);
    const norm = Math.hypot(...v) || 1;
    return v.map(x => x / norm);
}

// ---------------------------------------------------------------- scripted JSON answers

const TITLE_SKIP = /^(what|how|when|why|the|a|an|in|on|of|and|or|for|to|at|by|with|from|after|before)$/i;

function titleEntity(title) {
    return title.replace(/^(the|a|an)\s+/i, '').replace(/^What\s+.+?\s+Is$/i, m => m.split(/\s+/).slice(1, -1).join(' ')).trim();
}

/** Capitalised phrases that aren't at the start of a sentence, e.g. "Rank Plate", "Ex-Zone", "Æther". */
function namedPhrases(text) {
    const found = new Map();
    const re = /(?<![.!?:]\s|^|\n)\b(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)*)/gu;
    for (const m of text.matchAll(re)) {
        const phrase = m[1].split(/\s+/).filter(w => !TITLE_SKIP.test(w)).join(' ');
        if (phrase.length < 3 || /^(TL|DR|I)$/.test(phrase)) continue;
        found.set(phrase.toLowerCase(), { phrase, n: (found.get(phrase.toLowerCase())?.n ?? 0) + 1 });
    }
    return [...found.values()].sort((a, b) => b.n - a.n).map(x => x.phrase);
}

export function answerExtraction(user) {
    const chunk = user.split('LORE CHUNK:\n')[1] ?? '';
    const lines = chunk.split('\n');
    const location = lines[1] ?? '';
    const titles = location.split(' > ').slice(1).map(t => t.replace(/^\d+\.\s*/, '').trim());
    const main = titleEntity(titles.at(-1) ?? 'Unknown');
    const section = titles.length > 1 ? titleEntity(titles[0]) : '';
    const body = lines.slice(2).join('\n');
    const entities = [{ name: main, type: 'Concept', aliases: [], description: `What the lore calls ${main}.`, defined_here: true }];
    for (const phrase of namedPhrases(body)) {
        if (entities.length >= 8) break;
        if (entities.some(e => e.name.toLowerCase() === phrase.toLowerCase())) continue;
        entities.push({ name: phrase, type: 'Concept', aliases: [], description: '', defined_here: false });
    }
    if (section && !entities.some(e => e.name.toLowerCase() === section.toLowerCase())) {
        entities.push({ name: section, type: 'Concept', aliases: [], description: '', defined_here: false });
    }
    const relations = entities.slice(1).map(e => ({ source: main, type: 'related_to', target: e.name, evidence: 'Mentioned in the same section.' }));
    return { entities, relations };
}

const EVERYDAY = new Set(['plate', 'smell', 'weight', 'strength', 'failure', 'renewal', 'focus', 'form', 'character', 'branch', 'badge', 'core', 'clock', 'window', 'line', 'remnant']);

// Everyday words that the fake AI also calls proper names when capitalised.
const CAPITALISED = new Set(['sea', 'abyss', 'shroud']);

function answerEveryday(user) {
    const names = user.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    const everyday = names.filter(n => EVERYDAY.has(n.toLowerCase()) || CAPITALISED.has(n.toLowerCase()));
    return { everyday, capitalised: everyday.filter(n => CAPITALISED.has(n.toLowerCase())) };
}

function answerMemory(user) {
    const people = (user.match(/PEOPLE IN THIS CHAT: ([^(\n]+)/)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const newPart = user.split('NEW MESSAGES:\n')[1] ?? '';
    const memories = [];
    for (const m of newPart.matchAll(/\[#(\d+)\] ([^:\n]+): ([^\n]+)/g)) {
        const [, index, speaker, text] = m;
        const sentence = text.split(/(?<=[.!?])\s/)[0].slice(0, 160);
        if (words(sentence).length < 3) continue;
        memories.push({
            kind: 'event',
            text: `${speaker} said: ${sentence}`,
            characters: [speaker],
            witnesses: people,
            learned_by: [],
            lore_terms: namedPhrases(text).slice(0, 3),
            source_messages: [Number(index)],
            supersedes: [],
        });
    }
    return { memories: memories.slice(0, 6), learned: [] };
}

function answerTestSuggestions(user) {
    // "Suggest tests": one line per listed section (first six), made from its summary sentence.
    const blocks = (user.split('LORE SECTIONS:\n')[1] ?? '').split(/\n\n(?=\[)/).slice(0, 6);
    const tests = blocks.map(block => {
        const [first, , summary = ''] = block.split('\n');
        const id = first.replace(/^\[|\]$/g, '');
        return { text: `I keep thinking about it. ${summary.split(/(?<=[.!?])\s/)[0]}`, expected: [id], kind: 'names' };
    });
    tests.push({ text: 'Haha, nice weather today. Want to grab some food?', expected: [], kind: 'casual' });
    tests.push({ text: 'This one names a section that does not exist.', expected: ['NOPE §9 Nothing'], kind: 'names' });
    return { tests };
}

export function pickAnswer(messages) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    if (system.includes('You extract a knowledge graph')) return JSON.stringify(answerExtraction(user));
    if (system.includes('refer to the SAME thing')) return JSON.stringify({ pairs: [] });
    if (system.includes('which lore terms can be matched in chat safely')) return JSON.stringify(answerEveryday(user));
    if (system.includes('You keep the story memory')) return JSON.stringify(answerMemory(user));
    if (system.includes('You write test lines')) return JSON.stringify(answerTestSuggestions(user));
    return null;
}

