// Popup that explains one retrieval: what matched, what was ignored, the paths taken,
// every chunk's score and whether it was included, and the exact injected text.

import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';

const STATUS_LABELS = {
    full: 'included',
    tldr: 'TL;DR only (budget)',
    cut: 'cut (budget)',
    'below threshold': 'too weak',
};

/** The "Matched by meaning" part of a report (Milestone 3b). */
function renderMeaningSection(report) {
    if (!report.meaningEnabled) {
        return '<h4>Matched by meaning</h4><div class="lore_graph_meta">Meaning search is off.</div>';
    }
    if (report.meaningError) {
        return `<h4>Matched by meaning</h4><div class="lore_graph_status_warning">Not available this time: ${escapeHtml(report.meaningError)} Names were still used.</div>`;
    }
    const chunks = report.meaningHits?.chunks ?? [];
    const seeds = report.meaningSeeds ?? [];
    if (report.meaningSkipped) {
        return `<h4>Matched by meaning</h4><div class="lore_graph_meta">${escapeHtml(report.meaningSkipped)}</div>
            ${chunks.length ? `<ul>${chunks.map(c => `<li>#${c.rank + 1} ${escapeHtml(c.id)} <small>(weak, not used)</small></li>`).join('')}</ul>` : ''}`;
    }
    if (!chunks.length && !seeds.length) {
        return '<h4>Matched by meaning</h4><div class="lore_graph_meta">Nothing was close enough in meaning (above the similarity threshold).</div>';
    }
    return `<h4>Matched by meaning</h4>
        ${chunks.length ? `<div class="lore_graph_meta">Closest chunks (rank only; SillyTavern doesn't return similarity numbers):</div>
            <ul>${chunks.map(c => `<li>#${c.rank + 1} <span class="lore_graph_link lore_graph_report_chunk" data-chunk="${escapeHtml(c.id)}">${escapeHtml(c.id)}</span>${c.weak ? ' <small>(just above the threshold, counts half)</small>' : ''}</li>`).join('')}</ul>` : ''}
        ${seeds.length ? `<div class="lore_graph_meta">Entities seeded by meaning:</div>
            <ul>${seeds.map(s => `<li><b>${escapeHtml(s.name)}</b> · ${escapeHtml(s.via)} · start score ${s.score.toFixed(2)}</li>`).join('')}</ul>` : ''}`;
}

function ageLabel(age) {
    return age === 0 ? 'newest message' : `${age} message${age === 1 ? '' : 's'} back`;
}

/**
 * @param {object} report from runRetrieval / interceptGeneration
 * @param {string} title
 * @param {(chunkId: string) => void} onOpenChunk
 */
export function showRetrievalReport(report, title, onOpenChunk) {
    const included = report.chunks.filter(c => c.status === 'full' || c.status === 'tldr');
    const notIncluded = report.chunks.filter(c => c.status === 'cut' || c.status === 'below threshold');

    const chunkRow = (c) => `
        <tr>
            <td><span class="lore_graph_badge lore_graph_chunkstatus_${c.status.replace(/\s/g, '_')}">${escapeHtml(STATUS_LABELS[c.status] ?? c.status)}</span></td>
            <td>${c.score.toFixed(2)}</td>
            <td><span class="lore_graph_link lore_graph_report_chunk" data-chunk="${escapeHtml(c.id)}">${escapeHtml(c.id)}</span>${c.direct ? ' <small title="Mentions a matched entity directly">★</small>' : ''}
                <div class="lore_graph_row_sub">via ${c.reasons.slice(0, 3).map(r => `${escapeHtml(r.name)}${r.defined ? '' : ' (mention)'}`).join(', ')}${c.sharedWords?.length ? ` · shared words: ${c.sharedWords.slice(0, 5).map(escapeHtml).join(', ')}` : ''}</div></td>
            <td>${c.tokens || ''}</td>
        </tr>`;

    const root = $(`
        <div class="lore_graph_popup lore_graph_report">
            <h3>${escapeHtml(title)}</h3>
            <div class="lore_graph_meta">${included.length} chunk(s) injected · ${report.tokens} tokens${report.type ? ` · generation type: ${escapeHtml(report.type)}` : ''}${report.at ? ` · ${new Date(report.at).toLocaleTimeString()}` : ''}</div>

            <h4>Matched by name</h4>
            ${report.seeds.length ? `<ul>${report.seeds.map(s => `<li><b>${escapeHtml(s.name)}</b>${s.via !== s.name ? ` (as "${escapeHtml(s.via)}")` : ''} · ${ageLabel(s.message)} · start score ${s.score.toFixed(2)}${s.mode === 'context' ? ' · everyday word, allowed because a lore term is nearby' : ''}</li>`).join('')}</ul>` : '<div class="lore_graph_meta">No lore names found in the scanned messages.</div>'}

            ${renderMeaningSection(report)}

            ${report.ignored.length ? `<h4>Ignored</h4><ul>${report.ignored.map(i => `<li>${escapeHtml(i.name)}${i.via !== i.name ? ` (as "${escapeHtml(i.via)}")` : ''}: ${escapeHtml(i.reason)}</li>`).join('')}</ul>` : ''}

            ${report.reached.length ? `<details><summary>Reached through relationships (${report.reached.length})</summary><ul>${report.reached.slice(0, 40).map(r => `<li>${r.score.toFixed(2)} · ${r.path.map(escapeHtml).join(' ')}</li>`).join('')}</ul></details>` : ''}

            <h4>Chunks</h4>
            ${report.chunks.length ? `<table class="lore_graph_table"><thead><tr><th>Status</th><th>Score</th><th>Chunk</th><th>Tokens</th></tr></thead><tbody>${included.map(chunkRow).join('')}</tbody></table>` : '<div class="lore_graph_meta">None.</div>'}
            ${notIncluded.length ? `<details><summary>Not included (${notIncluded.length})</summary><table class="lore_graph_table"><tbody>${notIncluded.slice(0, 40).map(chunkRow).join('')}</tbody></table></details>` : ''}

            <h4>Injected text</h4>
            ${report.notice ? `<div class="lore_graph_status_warning">${escapeHtml(report.notice)}</div>` : ''}
            <div class="lore_graph_popup_block lore_graph_meta">${report.promptText ? escapeHtml(report.promptText) : '(nothing)'}</div>

            ${report.scannedMessages?.length ? `<details><summary>Scanned messages (${report.scannedMessages.length})</summary>${report.scannedMessages.map((m, i) => `<div class="lore_graph_popup_block lore_graph_meta"><b>${escapeHtml(ageLabel(report.scannedMessages.length - 1 - i))}:</b> ${escapeHtml(String(m).slice(0, 600))}${String(m).length > 600 ? '…' : ''}</div>`).join('')}</details>` : ''}
        </div>`);

    root.on('click', '.lore_graph_report_chunk', function () { onOpenChunk(String($(this).data('chunk'))); });
    return callGenericPopup(root, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true, okButton: 'Close' });
}
