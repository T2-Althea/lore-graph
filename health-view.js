// The Health check popup (the checks themselves are in health.js).

import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';

/**
 * @param {ReturnType<import('./health.js').computeHealth>} health
 * @param {object} handlers
 * @param {(chunkId: string) => void} handlers.onOpenChunk
 * @param {() => void} handlers.onOpenSnapshots
 */
export function showHealthReport(health, { onOpenChunk, onOpenSnapshots }) {
    const esc = escapeHtml;
    const link = (id) => id ? `<span class="lore_graph_link lore_graph_health_chunk" data-chunk="${esc(id)}">${esc(id)}</span>` : '';
    const block = (title, hint, items, render, limit = 40) => items.length
        ? `<details${items.length <= 8 ? ' open' : ''}><summary><b>${esc(title)}</b> (${items.length})</summary><div class="lore_graph_meta">${hint}</div><ul>${items.slice(0, limit).map(i => `<li>${render(i)}</li>`).join('')}${items.length > limit ? `<li>…and ${items.length - limit} more</li>` : ''}</ul></details>`
        : '';

    const html = `
        <div class="lore_graph_popup lore_graph_health">
            <h3>Health check</h3>
            <div class="lore_graph_meta">${health.sections} section(s) in ${health.documents} document(s) for this chat. ${health.problems ? `${health.problems} thing(s) worth fixing first (top of the list), then suggestions.` : 'Nothing serious found. The suggestions below are optional.'}</div>
            ${block('Not extracted yet', 'Run "Extract new &amp; changed".', health.notExtracted, link)}
            ${block('Failed extraction', 'Run "Extract new &amp; changed" to retry, or open the section to see the error.', health.failed, f => `${link(f.id)} <small>${esc(f.error.slice(0, 120))}</small>`)}
            ${block('Text changed since extraction', 'Run "Extract new &amp; changed" so the graph matches the new text.', health.outdated, link)}
            ${block('Sections bigger than the token budget', `These are longer than your lore budget (${health.budget} tokens), usually because of one very long paragraph, so only their TL;DR can ever be sent. Split the long paragraph with blank lines, or raise the budget.`, health.tooBig, b => `${link(b.id)} <small>(~${b.tokens} tokens)</small>`)}
            ${block('Documents nothing links to', 'No relationship or shared term connects these to any other document, so their lore is only found when the chat names their own terms (or by meaning search). Add a sentence that names a term from another document, the way the "field exception report" sentence links the Dungeon and Guild codices, then extract again.', health.isolatedDocs, d => esc(d))}
            ${block('One name, several entities', 'These names belong to more than one entity, so a mention may light up the wrong one. Merge them in Browse graph if they are the same thing, or set the shared name to Never on one of them.', health.sharedNames, s => `<b>${esc(s.name)}</b>: ${s.entities.map(esc).join(', ')}`)}
            ${block('Placeholders', 'Mentioned in the lore but defined in no loaded document. If one matters, define it in a lore file; it connects automatically when extracted.', health.placeholders, p => `<b>${esc(p.name)}</b> <small>(mentioned in ${p.mentions} section(s), e.g. ${link(p.chunk)})</small>`)}
            ${block('Entities with no relationships', 'These are found by their own name, but graph links never lead to them or from them.', health.isolated, e => `<b>${esc(e.name)}</b> <small>${esc(e.type)} · ${link(e.chunk)}</small>`)}
            ${block('Sections with nothing extracted', 'The AI found no entities here. They can still be found by meaning search, but never through names or links. Re-extract the section if that looks wrong.', health.empty, link)}
            ${block('Names too short to match', 'Names under 4 letters are ignored so they don\'t match by accident. Mark one as safe in Browse graph, or set it to "Capital letter only", if it should count.', health.tooShort, t => `<b>${esc(t.name)}</b> <small>(${esc(t.entity)})</small>`)}
            ${health.leftover ? `<div class="lore_graph_meta">${health.leftover} saved result(s) belong to sections that are in no lore file the extension knows about. <span class="lore_graph_link lore_graph_health_snapshots">Open Snapshots &amp; cleanup</span> to clear them (a snapshot is saved first).</div>` : ''}
        </div>`;
    const root = $(html);
    root.on('click', '.lore_graph_health_chunk', function () { onOpenChunk(String($(this).data('chunk'))); });
    root.on('click', '.lore_graph_health_snapshots', () => onOpenSnapshots());
    return callGenericPopup(root, POPUP_TYPE.TEXT, '', { wider: true, leftAlign: true, allowVerticalScrolling: true, okButton: 'Close' });
}
