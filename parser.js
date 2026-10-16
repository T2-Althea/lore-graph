// Lore document parser. Pure JavaScript with no SillyTavern imports, so it can be
// tested directly in Node. See CLAUDE.md "Lore document format" and "Chunking".

export const PARSER_VERSION = 1;
export const DEFAULT_MAX_CHUNK_TOKENS = 800;

const SECTION_SEPARATOR_RE = /^-{3,}$/;
const SECTION_HEADING_RE = /^(\d+)\.\s+(\S.*)$/;
const SUBSECTION_HEADING_RE = /^#+\s+(\S.*)$/;
const TLDR_RE = /^TL;DR:\s*(.*)$/i;
const DOC_ID_RE = /^Doc\s*ID:\s*(\S.*)$/i;
const GUARDRAIL_RE = /^[✕✖×X]\s*Not\s+This\s*:?$/i;

/**
 * @typedef {object} ParseWarning
 * @property {number|null} line 1-based line number in the source file, if known
 * @property {string} message
 */

/**
 * @typedef {object} LoreChunk
 * @property {string} id e.g. "COS-006 §7 The Rank Plate"
 * @property {string} docId
 * @property {string} docTitle
 * @property {number|null} sectionNumber
 * @property {string} sectionTitle
 * @property {string|null} subsectionTitle null for intro and whole-section chunks
 * @property {'intro'|'section'|'subsection'} kind
 * @property {number} part 1-based part number when a chunk was split
 * @property {number} partCount
 * @property {string} text body text, without the TL;DR and guardrail
 * @property {string} tldr the section's TL;DR
 * @property {string} guardrail guardrail text, empty if none
 * @property {number} tokens token estimate of the formatted chunk
 * @property {string} hash content hash
 * @property {number} lineStart
 * @property {number} lineEnd
 */

/**
 * @typedef {object} ParsedDocument
 * @property {string} docId
 * @property {string} title
 * @property {string} preamble header text that is not the title or Doc ID (normally empty)
 * @property {LoreChunk[]} chunks
 * @property {ParseWarning[]} warnings
 * @property {string|null} error fatal problem; when set, chunks is empty
 */

/**
 * Quick check used to tell lore files apart from other Data Bank files.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeLoreDocument(text) {
    const lines = normalizeText(text).split('\n').map(line => line.trim());
    if (lines.slice(0, 15).some(line => DOC_ID_RE.test(line))) return true;
    // No Doc ID: still a lore file if a numbered heading is followed by a TL;DR line near the top.
    const top = lines.slice(0, 60).filter(Boolean);
    return top.some((line, i) => SECTION_HEADING_RE.test(line) && TLDR_RE.test(top[i + 1] ?? ''));
}

/**
 * The text that represents a chunk in the prompt. Token estimates are based on it.
 * @param {LoreChunk} chunk
 * @param {{ tldrOnly?: boolean }} [options]
 * @returns {string}
 */
export function formatChunk(chunk, { tldrOnly = false } = {}) {
    const location = chunk.subsectionTitle
        ? `${chunk.sectionNumber ?? '?'}. ${chunk.sectionTitle} > ${chunk.subsectionTitle}`
        : `${chunk.sectionNumber ?? '?'}. ${chunk.sectionTitle}`;
    const lines = [`[${chunk.id}]`, `${chunk.docTitle} > ${location}`];
    if (chunk.tldr) {
        lines.push(`TL;DR: ${chunk.tldr}`);
    }
    if (!tldrOnly && chunk.text) {
        lines.push(chunk.text);
    }
    if (chunk.guardrail) {
        lines.push(`✕ Not This: ${chunk.guardrail}`);
    }
    return lines.join('\n');
}

/**
 * Small, stable string hash (FNV-1a). Used when no hash function is supplied.
 * @param {string} str
 * @returns {string}
 */
function defaultHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

/**
 * Rough token estimate used when no tokenizer is supplied.
 * @param {string} str
 * @returns {number}
 */
function defaultCountTokens(str) {
    return Math.ceil(str.length / 4);
}

function normalizeText(text) {
    return String(text ?? '')
        .replace(/^﻿/, '')
        .replace(/\r\n?/g, '\n');
}

/**
 * Joins collected lines into text, keeping paragraph breaks but collapsing runs of blank lines.
 * @param {{ text: string }[]} lines
 * @returns {string}
 */
function joinLines(lines) {
    return lines.map(x => x.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parses one lore document into chunks.
 * @param {string} rawText File contents
 * @param {object} [options]
 * @param {string} [options.fileName] Used for messages and as a fallback Doc ID
 * @param {(text: string) => number|Promise<number>} [options.countTokens]
 * @param {(text: string) => string|number} [options.hash]
 * @param {number} [options.maxChunkTokens]
 * @returns {Promise<ParsedDocument>}
 */
export async function parseLoreDocument(rawText, options = {}) {
    const fileName = options.fileName ?? 'unknown file';
    const countTokens = options.countTokens ?? defaultCountTokens;
    const hash = options.hash ?? defaultHash;
    const maxChunkTokens = options.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;

    /** @type {ParseWarning[]} */
    const warnings = [];
    const warn = (line, message) => warnings.push({ line, message });

    // Every non-blank line must end up somewhere; this set proves it at the end.
    const accounted = new Set();

    const lines = normalizeText(rawText).split('\n').map((text, i) => ({ text: text.replace(/\s+$/, ''), line: i + 1 }));

    // ---- Header: title, Doc ID, anything else before the first section ----
    let title = '';
    let docId = '';
    const preambleLines = [];
    let cursor = 0;

    for (; cursor < lines.length; cursor++) {
        const { text, line } = lines[cursor];
        const trimmed = text.trim();
        if (!trimmed) {
            continue;
        }
        if (SECTION_SEPARATOR_RE.test(trimmed)) {
            accounted.add(line);
            cursor++;
            break;
        }
        // A numbered heading after the title starts the first section.
        if (title && SECTION_HEADING_RE.test(trimmed)) {
            break;
        }
        if (!title) {
            title = trimmed;
            accounted.add(line);
            continue;
        }
        const docIdMatch = trimmed.match(DOC_ID_RE);
        if (docIdMatch && !docId) {
            docId = docIdMatch[1].trim();
            accounted.add(line);
            continue;
        }
        preambleLines.push(lines[cursor]);
        accounted.add(line);
        warn(line, 'Text in the document header (between the title and the first section) is not part of any chunk.');
    }

    if (!title) {
        return { docId: '', title: '', preamble: '', chunks: [], warnings, error: `${fileName}: the file is empty.` };
    }

    if (!docId) {
        docId = fileName.replace(/\.[^.]+$/, '').trim() || 'UNKNOWN';
        warn(null, `No "Doc ID:" line found. Using "${docId}" as the document ID.`);
    }

    // ---- Split the rest into section blocks at --- lines ----
    /** @type {{ text: string, line: number }[][]} */
    const blocks = [];
    let current = [];
    for (; cursor < lines.length; cursor++) {
        const entry = lines[cursor];
        if (SECTION_SEPARATOR_RE.test(entry.text.trim())) {
            accounted.add(entry.line);
            blocks.push(current);
            current = [];
        } else {
            current.push(entry);
        }
    }
    blocks.push(current);

    /** @type {Omit<LoreChunk, 'tokens'|'hash'|'part'|'partCount'|'id'>[]} */
    const rawChunks = [];

    for (const block of blocks) {
        const firstIndex = block.findIndex(x => x.text.trim());
        if (firstIndex === -1) {
            continue; // empty block, e.g. two --- in a row or a trailing ---
        }

        const headingEntry = block[firstIndex];
        const headingMatch = headingEntry.text.trim().match(SECTION_HEADING_RE);
        let sectionNumber = null;
        let sectionTitle;
        let bodyStart;

        if (headingMatch) {
            sectionNumber = Number(headingMatch[1]);
            sectionTitle = headingMatch[2].trim();
            accounted.add(headingEntry.line);
            bodyStart = firstIndex + 1;
        } else {
            sectionTitle = `Untitled section (line ${headingEntry.line})`;
            warn(headingEntry.line, 'Section does not start with a numbered heading like "7. Ranks". Its text was kept under an untitled section.');
            bodyStart = firstIndex;
        }

        let tldr = '';
        let tldrFound = false;
        /** @type {{ title: string|null, line: number, body: {text:string,line:number}[], guardrail: {text:string,line:number}[] }[]} */
        const units = [{ title: null, line: headingEntry.line, body: [], guardrail: [] }];
        let mode = 'body';

        for (let i = bodyStart; i < block.length; i++) {
            const entry = block[i];
            const trimmed = entry.text.trim();
            const unit = units[units.length - 1];

            if (!trimmed) {
                (mode === 'guardrail' ? unit.guardrail : unit.body).push(entry);
                continue;
            }

            const tldrMatch = !tldrFound ? trimmed.match(TLDR_RE) : null;
            if (tldrMatch) {
                tldr = tldrMatch[1].trim();
                tldrFound = true;
                accounted.add(entry.line);
                if (!tldr) {
                    warn(entry.line, 'TL;DR line is empty.');
                }
                continue;
            }

            const subMatch = trimmed.match(SUBSECTION_HEADING_RE);
            if (subMatch) {
                units.push({ title: subMatch[1].trim(), line: entry.line, body: [], guardrail: [] });
                mode = 'body';
                accounted.add(entry.line);
                continue;
            }

            if (GUARDRAIL_RE.test(trimmed)) {
                if (unit.guardrail.some(x => x.text.trim())) {
                    unit.guardrail.push({ text: '', line: entry.line });
                }
                mode = 'guardrail';
                accounted.add(entry.line);
                continue;
            }

            (mode === 'guardrail' ? unit.guardrail : unit.body).push(entry);
            accounted.add(entry.line);
        }

        if (!tldrFound) {
            warn(headingEntry.line, `Section "${sectionTitle}" has no TL;DR line.`);
        }

        const hasSubsections = units.length > 1;
        const lastLine = block[block.length - 1].line;

        units.forEach((unit, index) => {
            const text = joinLines(unit.body);
            const guardrail = joinLines(unit.guardrail);
            const isIntro = index === 0;

            if (isIntro && hasSubsections && !text && !guardrail) {
                return; // nothing between the TL;DR and the first subsection
            }
            if (!isIntro && !text && !guardrail) {
                warn(unit.line, `Subsection "${unit.title}" is empty.`);
            }
            if (unit.guardrail.length && !guardrail) {
                warn(unit.line, `A "✕ Not This" block in "${unit.title ?? sectionTitle}" is empty.`);
            }

            const nextUnit = units[index + 1];
            rawChunks.push({
                docId,
                docTitle: title,
                sectionNumber,
                sectionTitle,
                subsectionTitle: isIntro ? null : unit.title,
                kind: isIntro ? (hasSubsections ? 'intro' : 'section') : 'subsection',
                text,
                tldr,
                guardrail,
                lineStart: unit.line,
                lineEnd: nextUnit ? nextUnit.line - 1 : lastLine,
            });
        });
    }

    // ---- Make sure nothing was dropped ----
    for (const { text, line } of lines) {
        if (text.trim() && !accounted.has(line)) {
            warn(line, `Line was not assigned to any chunk: "${text.trim().slice(0, 80)}"`);
        }
    }

    if (rawChunks.length === 0) {
        return { docId, title, preamble: joinLines(preambleLines), chunks: [], warnings, error: `${fileName}: no sections found. Sections must be separated by lines containing only "---" and start with a numbered heading like "1. Title".` };
    }

    // ---- IDs, splitting, token counts, hashes ----
    const usedIds = new Set();
    /** @type {LoreChunk[]} */
    const chunks = [];

    for (const raw of rawChunks) {
        const label = raw.subsectionTitle ?? raw.sectionTitle;
        let baseId = `${docId} §${raw.sectionNumber ?? '?'} ${label}`;
        if (usedIds.has(baseId)) {
            let n = 2;
            while (usedIds.has(`${baseId} (${n})`)) n++;
            warn(raw.lineStart, `Duplicate chunk name "${baseId}"; renamed to "${baseId} (${n})".`);
            baseId = `${baseId} (${n})`;
        }
        usedIds.add(baseId);

        const pieces = await splitText(raw, baseId, countTokens, maxChunkTokens, warn);
        for (let i = 0; i < pieces.length; i++) {
            const chunk = {
                ...raw,
                id: pieces.length > 1 ? `${baseId} (part ${i + 1}/${pieces.length})` : baseId,
                text: pieces[i],
                part: i + 1,
                partCount: pieces.length,
                tokens: 0,
                hash: '',
            };
            const formatted = formatChunk(chunk);
            chunk.tokens = await countTokens(formatted);
            chunk.hash = String(hash(formatted));
            chunks.push(chunk);
        }
    }

    return { docId, title, preamble: joinLines(preambleLines), chunks, warnings, error: null };
}

/**
 * Splits a chunk's body at paragraph boundaries if the formatted chunk is too long.
 * Every piece keeps the same headers, TL;DR and guardrail.
 * @returns {Promise<string[]>}
 */
async function splitText(raw, baseId, countTokens, maxChunkTokens, warn) {
    const probe = { ...raw, id: `${baseId} (part 9/9)` };
    const fullTokens = await countTokens(formatChunk({ ...probe, text: raw.text }));
    if (fullTokens <= maxChunkTokens || !raw.text) {
        return [raw.text];
    }

    const overhead = await countTokens(formatChunk({ ...probe, text: '' }));
    const budget = Math.max(1, maxChunkTokens - overhead);
    const paragraphs = raw.text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);

    const pieces = [];
    let currentPiece = [];
    let currentTokens = 0;

    for (const paragraph of paragraphs) {
        const tokens = await countTokens(paragraph);
        if (tokens > budget) {
            warn(raw.lineStart, `A paragraph in "${baseId}" is longer than the chunk limit by itself (${tokens} tokens). It was kept whole.`);
        }
        if (currentPiece.length && currentTokens + tokens > budget) {
            pieces.push(currentPiece.join('\n\n'));
            currentPiece = [];
            currentTokens = 0;
        }
        currentPiece.push(paragraph);
        currentTokens += tokens;
    }
    if (currentPiece.length) {
        pieces.push(currentPiece.join('\n\n'));
    }

    return pieces;
}
