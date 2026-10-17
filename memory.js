// Milestone 6a: chat memory. The AI reads new chat messages in batches and writes short
// memories (events, changed facts, relationships, new people/places) with who witnessed
// them. Memories live in the chat's own metadata, so they belong to that story, follow
// branches/checkpoints, and are deleted with the chat. Nothing is injected yet (that's 6b).

import { getStringHash } from '../../../utils.js';
import { callModelForJson, getUsableProfile } from './extraction.js';

export const MEMORY_KEY = 'lore_graph_memory';
export const MEMORY_KINDS = { event: 'Event', fact: 'Changed fact', relationship: 'Relationship', entity: 'New person/place' };

const MEMORY_VERSION = 1;
const MAX_MESSAGE_CHARS = 2500;
const CONTEXT_MESSAGES = 3;
const CONTEXT_MEMORIES = 20;

/**
 * @typedef {object} Memory
 * @property {string} id short id shown to the model ("m12")
 * @property {'event'|'fact'|'relationship'|'entity'} kind
 * @property {string} text one sentence
 * @property {string[]} characters who it's about
 * @property {string[]} witnesses who saw or heard it happen
 * @property {{ name: string, from: string, atMessage: number, hash: number }[]} learned who found out later, from whom
 * @property {boolean} everyone known to all characters
 * @property {string[]} loreTerms names of lore things it involves
 * @property {{ index: number, hash: number }[]} sources messages it came from
 * @property {string[]} supersedes ids of memories this one replaces (changed facts)
 * @property {boolean} [superseded] replaced by a newer memory
 * @property {boolean} [edited] changed by the user (kept even if its messages change)
 * @property {number} createdAt
 */

/**
 * @typedef {object} MemoryState what's stored in chat_metadata.lore_graph_memory
 * @property {number} version
 * @property {number} processedUpTo index of the last chat message already read (-1 = none)
 * @property {'single'|'narrator'} mode how the AI plays this chat (used in 6b)
 * @property {number} nextId
 * @property {Memory[]} memories
 */

const context = () => SillyTavern.getContext();

/** The memory state of the open chat (created on first use). */
export function getMemoryState() {
    const metadata = context().chatMetadata;
    if (!metadata) return null;
    const state = metadata[MEMORY_KEY];
    if (!state || typeof state !== 'object' || !Array.isArray(state.memories)) {
        metadata[MEMORY_KEY] = { version: MEMORY_VERSION, processedUpTo: -1, mode: 'single', nextId: 1, memories: [] };
    }
    return metadata[MEMORY_KEY];
}

export function saveMemoryState() {
    context().saveMetadataDebounced();
}

const messageHash = (message) => getStringHash(String(message?.mes ?? ''));

/** Indices of real chat messages (not system notes) after `from`. */
function unprocessedIndices(state) {
    const chat = context().chat;
    const indices = [];
    for (let i = state.processedUpTo + 1; i < chat.length; i++) {
        if (chat[i] && !chat[i].is_system) indices.push(i);
    }
    return indices;
}

export function countUnprocessed() {
    const state = getMemoryState();
    return state ? unprocessedIndices(state).length : 0;
}

/** The people in this chat: the user's persona and the character(s). */
export function getChatPeople() {
    const ctx = context();
    const people = new Set([ctx.name1]);
    if (ctx.groupId) {
        const group = ctx.groups.find(g => g.id == ctx.groupId);
        for (const avatar of group?.members ?? []) {
            const character = ctx.characters.find(c => c.avatar === avatar);
            if (character?.name) people.add(character.name);
        }
    } else if (ctx.name2) {
        people.add(ctx.name2);
    }
    return [...people].filter(Boolean);
}

/**
 * Removes memories whose source messages were deleted, edited or swiped away, and steps the
 * "processed" marker back so the changed messages are read again next time.
 * Memories the user edited by hand are kept.
 * @returns {number} how many memories were removed
 */
export function validateMemories() {
    const state = getMemoryState();
    if (!state) return 0;
    const chat = context().chat;
    let firstChanged = Infinity;
    const before = state.memories.length;
    state.memories = state.memories.filter(memory => {
        if (memory.edited) return true;
        const broken = memory.sources.find(s => !chat[s.index] || messageHash(chat[s.index]) !== s.hash);
        if (broken) firstChanged = Math.min(firstChanged, broken.index);
        return !broken;
    });
    // "Learned later" entries depend on their own message; a changed message undoes just that.
    for (const memory of state.memories) {
        if (memory.edited) continue;
        memory.learned = memory.learned.filter(l => {
            const ok = chat[l.atMessage] && messageHash(chat[l.atMessage]) === l.hash;
            if (!ok) firstChanged = Math.min(firstChanged, l.atMessage);
            return ok;
        });
    }
    if (state.processedUpTo >= chat.length) state.processedUpTo = chat.length - 1;
    if (firstChanged !== Infinity) state.processedUpTo = Math.min(state.processedUpTo, firstChanged - 1);
    // A replaced memory comes back if the memory that replaced it is gone.
    const stillReplaced = new Set(state.memories.flatMap(m => m.supersedes));
    for (const memory of state.memories) {
        if (memory.superseded && !stillReplaced.has(memory.id)) memory.superseded = false;
    }
    const removed = before - state.memories.length;
    if (removed || firstChanged !== Infinity) saveMemoryState();
    return removed;
}

const MEMORY_SCHEMA = {
    name: 'lore_graph_memories',
    description: 'Memories from new roleplay messages',
    strict: true,
    value: {
        type: 'object',
        properties: {
            memories: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        kind: { type: 'string', enum: Object.keys(MEMORY_KINDS) },
                        text: { type: 'string' },
                        characters: { type: 'array', items: { type: 'string' } },
                        witnesses: { type: 'array', items: { type: 'string' } },
                        lore_terms: { type: 'array', items: { type: 'string' } },
                        supersedes: { type: 'array', items: { type: 'string' } },
                        source_messages: { type: 'array', items: { type: 'integer' } },
                        learned_by: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { name: { type: 'string' }, told_by: { type: 'string' }, source_message: { type: 'integer' } },
                                required: ['name', 'told_by', 'source_message'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['kind', 'text', 'characters', 'witnesses', 'lore_terms', 'supersedes', 'source_messages', 'learned_by'],
                    additionalProperties: false,
                },
            },
            learned: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        memory_id: { type: 'string' },
                        learners: { type: 'array', items: { type: 'string' } },
                        told_by: { type: 'string' },
                        source_message: { type: 'integer' },
                    },
                    required: ['memory_id', 'learners', 'told_by', 'source_message'],
                    additionalProperties: false,
                },
            },
        },
        required: ['memories', 'learned'],
        additionalProperties: false,
    },
};

const MEMORY_INSTRUCTIONS = `You keep the story memory for an ongoing roleplay. You read NEW messages and write down what should be remembered later.

Write memories of these kinds:
- "event": something that happened (a fight, a discovery, a deal, a death, a decision).
- "fact": something about the world or a character that is now different (who owns an item, which place is cleared, who is injured). If it replaces an earlier memory, list that memory's id in "supersedes".
- "relationship": how characters stand with each other (trust, debts, grudges, promises, attraction).
- "entity": a new person, creature, group or place introduced by the story itself.

Rules:
- One short, specific sentence per memory, in past tense for events. Use names, not "he/she".
- Only what actually happened or was stated in the NEW messages. No guesses, no repetition of existing memories, no trivia (small talk, routine actions, descriptions that change nothing).
- Do NOT record general world knowledge: how things work in the setting, what a creature or place is in general, rules or history explained by a character. That is already in the lore books. Record only what happened in THIS story, or story-specific facts (e.g. "Mira owns the amulet" is a memory; "wraiths avoid salt" is not).
- Usually 0 to 6 memories per batch. Returning none is fine.
- "characters": who the memory is about. "witnesses": who was present to see or hear it. Whoever speaks or acts in a message always witnessed it, and so does anyone they are talking to. Someone asleep, absent, or out of earshot is not a witness. When unsure who else was present, list only the people clearly there.
- "learned_by": if, later in these NEW messages, someone who wasn't a witness is told about it (or reads or overhears it), list them with who told them and the [#number] where it happened. Otherwise an empty array.
- "learned" (top level): when a character is told about an EXISTING memory (listed below with its id), add an entry with that id, the learners, and who told them.
- "lore_terms": names of setting concepts involved (places, creatures, organizations, items), as written.
- "source_messages": the [#number] of the message(s) the memory comes from.
Reply with the JSON object only.`;

function formatMessage(chat, index) {
    const message = chat[index];
    const text = String(message.mes ?? '').replace(/\s+\n/g, '\n').trim();
    return `[#${index}] ${message.name}: ${text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) + '…' : text}`;
}

function cleanNames(list, known) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        const canonical = known.find(k => k.toLowerCase() === name.toLowerCase()) ?? name;
        if (!out.some(x => x.toLowerCase() === canonical.toLowerCase())) out.push(canonical);
    }
    return out;
}

/**
 * Reads unprocessed messages and saves new memories. One AI call.
 * @param {object} settings extension settings
 * @param {{ maxMessages?: number }} [options]
 * @returns {Promise<{ added: number, learned: number, read: number }>}
 */
export async function extractMemories(settings, { maxMessages = 30 } = {}) {
    const state = getMemoryState();
    if (!state) throw new Error('Open a chat first.');
    const profile = getUsableProfile(settings.memory_profile || settings.extraction_profile);
    const chat = context().chat;
    const indices = unprocessedIndices(state).slice(0, maxMessages);
    if (!indices.length) return { added: 0, learned: 0, read: 0 };

    const people = getChatPeople();
    const storyPeople = [...new Set(state.memories.flatMap(m => [...m.characters, ...m.witnesses]))].filter(n => !people.includes(n));
    const earlier = [];
    for (let i = indices[0] - 1; i >= 0 && earlier.length < CONTEXT_MESSAGES; i--) {
        if (chat[i] && !chat[i].is_system) earlier.unshift(formatMessage(chat, i));
    }
    const recentMemories = state.memories.filter(m => !m.superseded).slice(-CONTEXT_MEMORIES);

    const userContent = [
        `PEOPLE IN THIS CHAT: ${people.join(', ')} (${context().name1} is the user's character)`,
        storyPeople.length ? `OTHER CHARACTERS SEEN SO FAR: ${storyPeople.join(', ')}` : '',
        recentMemories.length ? `EXISTING MEMORIES (do not repeat these):\n${recentMemories.map(m => `${m.id} [${m.kind}] ${m.text} (witnesses: ${m.everyone ? 'everyone' : [...m.witnesses, ...m.learned.map(l => l.name)].join(', ') || 'unknown'})`).join('\n')}` : 'EXISTING MEMORIES: none yet',
        earlier.length ? `EARLIER MESSAGES (already remembered, for context only):\n${earlier.join('\n\n')}` : '',
        `NEW MESSAGES:\n${indices.map(i => formatMessage(chat, i)).join('\n\n')}`,
    ].filter(Boolean).join('\n\n');

    const data = await callModelForJson(profile, [
        { role: 'system', content: MEMORY_INSTRUCTIONS },
        { role: 'user', content: userContent },
    ], MEMORY_SCHEMA, settings, (d) => Array.isArray(d?.memories) ? null : 'The reply has no "memories" array.');

    // The chat may have changed while the AI was working; only keep results for messages that are unchanged.
    const hashes = new Map(indices.map(i => [i, messageHash(chat[i])]));
    const stillSame = indices.every(i => context().chat[i] && messageHash(context().chat[i]) === hashes.get(i));
    if (!stillSame || context().chatMetadata?.[MEMORY_KEY] !== state) {
        throw new Error('The chat changed while memories were being made. Nothing was saved; it will try again later.');
    }

    const known = [...people, ...storyPeople];
    const validIds = new Set(state.memories.map(m => m.id));
    let added = 0;
    for (const raw of data.memories) {
        const text = String(raw?.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const kind = Object.hasOwn(MEMORY_KINDS, raw.kind) ? raw.kind : 'event';
        let sources = (Array.isArray(raw.source_messages) ? raw.source_messages : []).map(Number).filter(i => indices.includes(i));
        if (!sources.length) sources = [...indices];
        const supersedes = (Array.isArray(raw.supersedes) ? raw.supersedes : []).map(String).filter(id => validIds.has(id));
        const memory = {
            id: `m${state.nextId++}`,
            kind,
            text: text.slice(0, 400),
            characters: cleanNames(raw.characters, known),
            witnesses: cleanNames(raw.witnesses, known),
            learned: [],
            everyone: false,
            loreTerms: cleanNames(raw.lore_terms, []).slice(0, 8),
            sources: sources.map(index => ({ index, hash: hashes.get(index) })),
            supersedes,
            createdAt: Date.now(),
        };
        for (const entry of Array.isArray(raw.learned_by) ? raw.learned_by : []) {
            const name = cleanNames([entry?.name], known)[0];
            if (!name || memory.witnesses.includes(name) || memory.learned.some(l => l.name === name)) continue;
            const at = indices.includes(Number(entry.source_message)) ? Number(entry.source_message) : indices[indices.length - 1];
            memory.learned.push({ name, from: String(entry.told_by ?? '').trim(), atMessage: at, hash: hashes.get(at) });
        }
        for (const id of supersedes) {
            const old = state.memories.find(m => m.id === id);
            if (old) old.superseded = true;
        }
        state.memories.push(memory);
        added++;
    }

    let learned = 0;
    for (const raw of Array.isArray(data.learned) ? data.learned : []) {
        const memory = state.memories.find(m => m.id === String(raw?.memory_id));
        if (!memory) continue;
        const at = indices.includes(Number(raw.source_message)) ? Number(raw.source_message) : indices[indices.length - 1];
        for (const name of cleanNames(raw.learners, known)) {
            if (memory.witnesses.includes(name) || memory.learned.some(l => l.name === name)) continue;
            // The message it was learned in is kept, so changing that message undoes only this (see validate).
            memory.learned.push({ name, from: String(raw.told_by ?? '').trim(), atMessage: at, hash: hashes.get(at) });
            learned++;
        }
    }

    state.processedUpTo = indices[indices.length - 1];
    saveMemoryState();
    return { added, learned, read: indices.length };
}

/** Creates a blank memory for the memory list's "Add" button. */
export function newMemory(state) {
    return { id: `m${state.nextId++}`, kind: 'event', text: '', characters: [], witnesses: [], learned: [], everyone: false, loreTerms: [], sources: [], supersedes: [], edited: true, createdAt: Date.now() };
}

