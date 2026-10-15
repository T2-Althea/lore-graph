// Graph browser popup: entities, relations, placeholders. Read-only view.

import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { ENTITY_TYPES } from './schema.js';

const MAX_ROWS = 400;

/**
 * @param {{ entities: import('./graph.js').Entity[], edges: import('./graph.js').Edge[] }} graph
 * @param {(chunkId: string) => void} onOpenChunk
 */
export function showGraphBrowser(graph, onOpenChunk) {
    const byId = new Map(graph.entities.map(e => [e.id, e]));
    const outgoing = new Map();
    const incoming = new Map();
    for (const edge of graph.edges) {
        if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
        if (!incoming.has(edge.target)) incoming.set(edge.target, []);
        outgoing.get(edge.source).push(edge);
        incoming.get(edge.target).push(edge);
    }
    const placeholderCount = graph.entities.filter(e => e.placeholder).length;

    const root = $(`
        <div class="lore_graph_popup lore_graph_browser">
            <h3>Lore graph</h3>
            <div class="lore_graph_meta">${graph.entities.length} entities (${placeholderCount} placeholders) · ${graph.edges.length} relations</div>
            <div class="lore_graph_tabs">
                <div class="menu_button lore_graph_tab active" data-tab="entities">Entities</div>
                <div class="menu_button lore_graph_tab" data-tab="relations">Relations</div>
                <div class="menu_button lore_graph_tab" data-tab="placeholders">Placeholders (${placeholderCount})</div>
            </div>
            <div class="lore_graph_filters flex-container">
                <input type="search" class="text_pole lore_graph_search" placeholder="Search names, aliases, descriptions…" />
                <select class="text_pole lore_graph_type_filter">
                    <option value="">All types</option>
                    ${ENTITY_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}
                </select>
            </div>
            <div class="lore_graph_browser_body">
                <div class="lore_graph_list"></div>
                <div class="lore_graph_detail"><small class="lore_graph_empty">Click an entity to see its details.</small></div>
            </div>
        </div>`);

    let tab = 'entities';
    const list = root.find('.lore_graph_list');
    const detail = root.find('.lore_graph_detail');

    const entityLink = (id) => {
        const e = byId.get(id);
        return `<span class="lore_graph_link lore_graph_entity_link ${e?.placeholder ? 'lore_graph_placeholder' : ''}" data-id="${escapeHtml(id)}">${escapeHtml(e?.name ?? id)}</span>`;
    };

    const chunkLinks = (ids) => ids.map(id => `<span class="lore_graph_link lore_graph_chunk_link" data-chunk="${escapeHtml(id)}">${escapeHtml(id)}</span>`).join(', ');

    function matches(entity, query, type) {
        if (type && entity.type !== type) return false;
        if (!query) return true;
        const haystack = [entity.name, ...entity.aliases, entity.description].join(' ').toLowerCase();
        return haystack.includes(query);
    }

    function renderList() {
        const query = String(root.find('.lore_graph_search').val() ?? '').trim().toLowerCase();
        const type = String(root.find('.lore_graph_type_filter').val() ?? '');
        list.empty();

        if (tab === 'relations') {
            const rows = graph.edges.filter(edge => {
                const s = byId.get(edge.source), t = byId.get(edge.target);
                if (type && s?.type !== type && t?.type !== type) return false;
                if (!query) return true;
                return [s?.name, t?.name, edge.type, edge.evidence].join(' ').toLowerCase().includes(query);
            });
            for (const edge of rows.slice(0, MAX_ROWS)) {
                list.append(`
                    <div class="lore_graph_row">
                        ${entityLink(edge.source)} <span class="lore_graph_badge">${escapeHtml(edge.type)}</span> ${entityLink(edge.target)}
                        ${edge.weight > 1 ? `<small>×${edge.weight}</small>` : ''}
                        <div class="lore_graph_row_sub">${escapeHtml(edge.evidence)}</div>
                    </div>`);
            }
            if (rows.length > MAX_ROWS) list.append(`<small class="lore_graph_empty">Showing ${MAX_ROWS} of ${rows.length}. Search to narrow down.</small>`);
            if (!rows.length) list.append('<small class="lore_graph_empty">No relations match.</small>');
            return;
        }

        const rows = graph.entities.filter(e => (tab !== 'placeholders' || e.placeholder) && matches(e, query, type));
        for (const entity of rows.slice(0, MAX_ROWS)) {
            const degree = (outgoing.get(entity.id)?.length ?? 0) + (incoming.get(entity.id)?.length ?? 0);
            list.append(`
                <div class="lore_graph_row lore_graph_entity_row" data-id="${escapeHtml(entity.id)}">
                    <span class="${entity.placeholder ? 'lore_graph_placeholder' : ''}">${escapeHtml(entity.name)}</span>
                    <span class="lore_graph_badge">${escapeHtml(entity.type)}</span>
                    ${entity.placeholder ? '<span class="lore_graph_badge lore_graph_placeholder">placeholder</span>' : ''}
                    <small>${degree} links · ${entity.sourceChunks.length} chunks</small>
                </div>`);
        }
        if (rows.length > MAX_ROWS) list.append(`<small class="lore_graph_empty">Showing ${MAX_ROWS} of ${rows.length}. Search to narrow down.</small>`);
        if (!rows.length) list.append('<small class="lore_graph_empty">No entities match.</small>');
    }

    function renderDetail(id) {
        const entity = byId.get(id);
        if (!entity) return;
        const edgeRow = (edge, otherId, direction) => `
            <li>${direction === 'out' ? '→' : '←'} <span class="lore_graph_badge">${escapeHtml(edge.type)}</span> ${entityLink(otherId)}
                ${edge.weight > 1 ? `<small>×${edge.weight}</small>` : ''}
                <div class="lore_graph_row_sub">${escapeHtml(edge.evidence)} <small>(${chunkLinks(edge.chunkIds)})</small></div>
            </li>`;
        const out = outgoing.get(id) ?? [];
        const inc = incoming.get(id) ?? [];
        detail.html(`
            <h4 class="${entity.placeholder ? 'lore_graph_placeholder' : ''}">${escapeHtml(entity.name)} <span class="lore_graph_badge">${escapeHtml(entity.type)}</span></h4>
            ${entity.placeholder ? '<div class="lore_graph_placeholder">Placeholder: mentioned but not defined in any loaded document.</div>' : ''}
            <div>${escapeHtml(entity.description || '(no description)')}</div>
            ${entity.aliases.length ? `<div class="lore_graph_meta">Also called: ${entity.aliases.map(escapeHtml).join(', ')}</div>` : ''}
            <div class="lore_graph_meta">Defined in: ${entity.definedIn.length ? chunkLinks(entity.definedIn) : '—'}</div>
            <div class="lore_graph_meta">Mentioned in: ${chunkLinks(entity.sourceChunks)}</div>
            <h4>Relations (${out.length + inc.length})</h4>
            <ul class="lore_graph_relations">
                ${out.map(e => edgeRow(e, e.target, 'out')).join('')}
                ${inc.map(e => edgeRow(e, e.source, 'in')).join('')}
            </ul>`);
    }

    root.on('click', '.lore_graph_tab', function () {
        tab = $(this).data('tab');
        root.find('.lore_graph_tab').removeClass('active');
        $(this).addClass('active');
        renderList();
    });
    root.on('input change', '.lore_graph_search, .lore_graph_type_filter', renderList);
    root.on('click', '.lore_graph_entity_row', function () { renderDetail(String($(this).data('id'))); });
    root.on('click', '.lore_graph_entity_link', function (e) { e.stopPropagation(); renderDetail(String($(this).data('id'))); });
    root.on('click', '.lore_graph_chunk_link', function (e) { e.stopPropagation(); onOpenChunk(String($(this).data('chunk'))); });

    renderList();
    callGenericPopup(root, POPUP_TYPE.TEXT, '', { large: true, allowVerticalScrolling: true, leftAlign: true, okButton: 'Close' });
}

/**
 * Lets the user approve or reject suggested duplicates.
 * @param {{ a: string, b: string, reason: string }[]} pending
 * @param {(index: number, approve: boolean) => Promise<void>} onDecide
 */
export function showDuplicateReview(pending, onDecide) {
    const root = $('<div class="lore_graph_popup"><h3>Possible duplicates</h3><div class="lore_graph_meta">Approve to merge the two into one entity. Reject to keep them separate. Your answers are remembered.</div><div class="lore_graph_dupes"></div></div>');
    const container = root.find('.lore_graph_dupes');
    const items = pending.map((p, i) => ({ ...p, originalIndex: i, decided: false }));

    function render() {
        container.empty();
        const open = items.filter(x => !x.decided);
        if (!open.length) {
            container.append('<small class="lore_graph_empty">Nothing left to review.</small>');
            return;
        }
        for (const item of open) {
            const row = $(`
                <div class="lore_graph_row">
                    <b>${escapeHtml(item.a)}</b> ⇄ <b>${escapeHtml(item.b)}</b>
                    <div class="lore_graph_row_sub">${escapeHtml(item.reason)}</div>
                    <div class="flex-container">
                        <div class="menu_button" data-act="approve"><i class="fa-solid fa-check"></i> Merge</div>
                        <div class="menu_button" data-act="reject"><i class="fa-solid fa-xmark"></i> Keep separate</div>
                    </div>
                </div>`);
            row.find('[data-act]').on('click', async function () {
                // Indexes shift as items are removed from the saved list, so count earlier undecided ones.
                const index = items.filter(x => !x.decided && x.originalIndex < item.originalIndex).length;
                item.decided = true;
                await onDecide(index, $(this).data('act') === 'approve');
                render();
            });
            container.append(row);
        }
    }

    render();
    return callGenericPopup(root, POPUP_TYPE.TEXT, '', { wider: true, allowVerticalScrolling: true, leftAlign: true, okButton: 'Done' });
}
