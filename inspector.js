// Milestone 4: a lore record on every AI reply. A compact copy of the retrieval report is
// stored in the message's `extra` (and its swipe's), and a "Lore" button in the message's
// action menu shows it. The lore text itself isn't stored (it would bloat chat files);
// it's rebuilt from the current chunks when the report is opened.

import { chat, saveChatDebounced, substituteParamsExtended } from '../../../../script.js';
import { formatChunk } from './parser.js';

export const RECORD_KEY = 'lore_graph';
const RECORD_VERSION = 1;
/** A report older than this isn't attached to an incoming message (e.g. a stopped generation). */
const PENDING_MAX_AGE_MS = 15 * 60 * 1000;

/** @type {{ report: object, at: number }|null} report from the last interceptor run, waiting for its reply */
let pending = null;

/** Called by the generation interceptor with the report it just used. */
export function setPendingReport(report) {
    pending = report ? { report, at: Date.now() } : null;
}

/**
 * Shrinks a report to what's needed to explain it later (a few KB).
 * @param {object} report from runRetrieval
 * @param {Map<string, import('./parser.js').LoreChunk>} chunkById
 */
export function compactReport(report, chunkById) {
    const round = (n) => Math.round(n * 1000) / 1000;
    return {
        v: RECORD_VERSION,
        at: report.at ?? Date.now(),
        type: report.type ?? null,
        tokens: report.tokens,
        seeds: report.seeds.map(s => ({ name: s.name, via: s.via, message: s.message, score: round(s.score), mode: s.mode })),
        meaningEnabled: !!report.meaningEnabled,
        meaningError: report.meaningError ?? null,
        meaningHits: report.meaningHits ? { chunks: report.meaningHits.chunks.map(c => ({ id: c.id, rank: c.rank, weak: !!c.weak })) } : null,
        meaningSeeds: (report.meaningSeeds ?? []).map(s => ({ name: s.name, via: s.via, score: round(s.score) })),
        meaningSkipped: report.meaningSkipped ?? null,
        ignored: report.ignored.map(i => ({ name: i.name, via: i.via, reason: i.reason })),
        reached: report.reached.slice(0, 10).map(r => ({ name: r.name, score: round(r.score), path: r.path })),
        // Everything that was sent, plus the 5 closest near-misses (what got cut, and why).
        chunks: [
            ...report.chunks.filter(c => c.status === 'full' || c.status === 'tldr'),
            ...report.chunks.filter(c => c.status !== 'full' && c.status !== 'tldr').slice(0, 5),
        ].map(c => ({
            id: c.id,
            score: round(c.score),
            status: c.status,
            tokens: c.tokens,
            direct: !!c.direct,
            pinned: !!c.pinned,
            hash: chunkById.get(c.id)?.hash ?? null,
            reasons: c.reasons.slice(0, 2).map(r => ({ name: r.name, amount: round(r.amount), defined: !!r.defined })),
            sharedWords: (c.sharedWords ?? []).slice(0, 3),
        })),
        scannedMessages: (report.scannedMessages ?? []).map(m => String(m).slice(0, 200)),
        memory: report.memory ? {
            mode: report.memory.mode,
            character: report.memory.character,
            tokens: report.memory.tokens,
            selected: report.memory.selected.map(x => ({ id: x.memory.id, line: x.line, reasons: x.reasons })),
            hidden: report.memory.hidden.slice(0, 10).map(m => ({ id: m.id, text: m.text })),
            cutCount: report.memory.cut.length,
        } : null,
    };
}

/**
 * Attaches the waiting report to a newly received AI message, and to its current swipe.
 * @param {number} messageId
 * @param {string} type generation type
 * @param {Map<string, import('./parser.js').LoreChunk>} chunkById
 * @returns {boolean} whether a record was attached
 */
export function attachPendingReport(messageId, type, chunkById) {
    if (!pending || type === 'quiet' || type === 'impersonate') return false;
    if (Date.now() - pending.at > PENDING_MAX_AGE_MS) {
        pending = null;
        return false;
    }
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return false;

    const record = compactReport(pending.report, chunkById);
    pending = null;
    message.extra ??= {};
    message.extra[RECORD_KEY] = record;
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id ?? 0] : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra ??= {};
        swipeInfo.extra[RECORD_KEY] = structuredClone(record);
    }
    saveChatDebounced();
    return true;
}

/** @param {number} messageId */
export function getRecord(messageId) {
    return chat[messageId]?.extra?.[RECORD_KEY] ?? null;
}

/**
 * Turns a stored record back into a report the report window can show, rebuilding the
 * injected text from the current chunks and noting any that changed or disappeared since.
 * @param {object} record
 * @param {Map<string, import('./parser.js').LoreChunk>} chunkById
 * @param {string} template injection template
 */
export function expandRecord(record, chunkById, template) {
    const changed = [];
    const missing = [];
    const parts = [];
    const sectionsWithTldr = new Set();
    for (const c of record.chunks) {
        if (c.status !== 'full' && c.status !== 'tldr') continue;
        const chunk = chunkById.get(c.id);
        if (!chunk) {
            missing.push(c.id);
            continue;
        }
        if (c.hash && chunk.hash !== c.hash) changed.push(c.id);
        const sectionKey = `${chunk.docId}|${chunk.sectionNumber}`;
        if (c.status === 'tldr') {
            parts.push(formatChunk(chunk, { tldrOnly: true }));
        } else {
            parts.push(formatChunk(sectionsWithTldr.has(sectionKey) ? { ...chunk, tldr: '' } : chunk));
        }
        sectionsWithTldr.add(sectionKey);
    }
    const notices = [];
    if (changed.length) notices.push(`These sections were edited after this reply, so the text below is the current version, not exactly what was sent: ${changed.join(', ')}.`);
    if (missing.length) notices.push(`These sections no longer exist in the loaded lore: ${missing.join(', ')}.`);
    return {
        ...record,
        chunks: record.chunks.map(c => ({ ...c, reasons: c.reasons.map(r => ({ entityId: '', ...r })) })),
        promptText: parts.length ? substituteParamsExtended(template || '{{text}}', { text: parts.join('\n\n') }) : '',
        notice: notices.join(' '),
    };
}

const BUTTON_HTML = '<div title="Lore Graph: what lore was sent for this reply, and why" class="mes_button lore_graph_mes_button fa-solid fa-book-atlas"></div>';

/**
 * Adds the "Lore" button to the message template (for future messages) and to messages
 * already on screen. Only SillyTavern's page is changed at runtime, never its files.
 */
export function addMessageButtons() {
    const template = $('#message_template .extraMesButtons');
    if (template.length && !template.find('.lore_graph_mes_button').length) {
        template.prepend(BUTTON_HTML);
    }
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.lore_graph_mes_button').length) $(this).prepend(BUTTON_HTML);
    });
}
