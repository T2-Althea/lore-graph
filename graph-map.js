// Milestone 5: a visual map of the lore graph, drawn with Cytoscape.js
// (vendored as lib/cytoscape.min.js, MIT license, v3.30.2 from the official npm package).

import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { ENTITY_TYPES } from './schema.js';

const LIBRARY_URL = '/scripts/extensions/third-party/lore-graph/lib/cytoscape.min.js';

/** Colors per entity type, readable on both dark and light themes. */
const TYPE_COLORS = {
    Organization: '#5c9dff', Role: '#9b8cff', Rank: '#c792ea', Place: '#4caf50', Creature: '#ef5350',
    Species: '#ff8a65', Phenomenon: '#26c6da', Material: '#ffca28', Object: '#a1887f', Credential: '#f06292',
    Procedure: '#7cb342', Rule: '#ab47bc', Event: '#ffa726', Concept: '#90a4ae',
};
const GUARDRAIL_TYPES = new Set(['contrasts_with', 'exception_to']);
/** Entities in more chunks than this are "hubs" that connect to everything. */
const HUB_CHUNKS = 8;
const MAX_WHOLE_NODES = 700;

let libraryPromise = null;

/** Loads Cytoscape once (it's a plain script that defines window.cytoscape). */
function loadCytoscape() {
    if (window.cytoscape) return Promise.resolve(window.cytoscape);
    libraryPromise ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LIBRARY_URL;
        script.onload = () => window.cytoscape ? resolve(window.cytoscape) : reject(new Error('Cytoscape did not load.'));
        script.onerror = () => { libraryPromise = null; reject(new Error(`Could not load ${LIBRARY_URL}.`)); };
        document.head.appendChild(script);
    });
    return libraryPromise;
}

function themeColor(variable, fallback) {
    const value = getComputedStyle(document.body).getPropertyValue(variable).trim();
    return value || fallback;
}

/**
 * Turns a report's paths ("A", "requires:→", "B", …) and seeds into entity/edge ids to highlight.
 * @param {object} report a retrieval report or an expanded lore record
 * @param {Map<string, string>} idByName lowercased name -> entity id
 */
export function highlightFromReport(report, idByName) {
    const id = (name) => idByName.get(String(name).toLowerCase());
    const seeds = new Set(report.seeds.map(s => id(s.name)).filter(Boolean));
    const meaning = new Set([...(report.meaningSeeds ?? [])].sort((a, b) => b.score - a.score).slice(0, 6).map(s => id(s.name)).filter(Boolean));
    const nodes = new Set([...seeds, ...meaning]);
    const edges = new Set();

    // Only the chain that explains what was sent: the entities each sent section was chosen
    // for, and the path from a matched name to each of them.
    const reasonIds = new Set();
    /** Links that aren't graph edges: "section X mentions term Y" (from the definition rule). */
    const mentions = [];
    for (const chunk of report.chunks ?? []) {
        if (chunk.status !== 'full' && chunk.status !== 'tldr') continue;
        for (const reason of chunk.reasons.slice(0, 2)) {
            const defines = /^defines "(.+?)", used in (.+)$/.exec(reason.name);
            const reasonId = id(defines ? defines[1] : reason.name);
            if (!reasonId) continue;
            reasonIds.add(reasonId);
            if (defines) mentions.push({ term: reasonId, fromChunk: defines[2] });
        }
    }
    reasonIds.forEach(x => nodes.add(x));
    for (const reached of report.reached ?? []) {
        if (!reasonIds.has(id(reached.name))) continue;
        const steps = reached.path.filter((_, i) => i % 2 === 0).map(id);
        steps.forEach(x => x && nodes.add(x));
        for (let i = 0; i + 1 < steps.length; i++) {
            if (steps[i] && steps[i + 1]) edges.add(`${steps[i]}|${steps[i + 1]}`);
        }
    }
    return { seeds, meaning, nodes, edges, mentions };
}

/**
 * Opens the graph map.
 * @param {{ entities: import('./graph.js').Entity[], edges: import('./graph.js').Edge[] }} graph
 * @param {object} options
 * @param {(chunkId: string) => void} options.onOpenChunk
 * @param {string} [options.focus] entity id to center on
 * @param {ReturnType<typeof highlightFromReport>} [options.highlight] from a lore report
 * @param {string} [options.title]
 */
export async function showGraphMap(graph, { onOpenChunk, focus, highlight, title = 'Lore map' }) {
    let cytoscape;
    try {
        cytoscape = await loadCytoscape();
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Lore Graph');
        return;
    }

    const byId = new Map(graph.entities.map(e => [e.id, e]));
    const neighbors = new Map(graph.entities.map(e => [e.id, new Set()]));
    for (const edge of graph.edges) {
        neighbors.get(edge.source)?.add(edge.target);
        neighbors.get(edge.target)?.add(edge.source);
    }
    const isHub = (id) => (byId.get(id)?.sourceChunks.length ?? 0) > HUB_CHUNKS;
    const docsOf = (entity) => new Set(entity.sourceChunks.map(c => c.split(' ')[0]));
    const allDocs = [...new Set(graph.entities.flatMap(e => [...docsOf(e)]))].sort();
    const sorted = [...graph.entities].sort((a, b) => a.name.localeCompare(b.name));

    const view = {
        mode: highlight ? 'highlight' : focus ? 'around' : 'around',
        // Start on the best-connected entity that isn't a hub: usually a meaningful centre.
        focus: focus ?? [...graph.entities].filter(e => !e.placeholder && !isHub(e.id)).sort((a, b) => neighbors.get(b.id).size - neighbors.get(a.id).size)[0]?.id ?? sorted[0]?.id,
        steps: 1,
        type: '',
        doc: '',
        placeholdersOnly: false,
        hideHubs: true,
    };

    const root = $(`
        <div class="lore_graph_popup lore_graph_map">
            <div class="lore_graph_map_toolbar">
                <b>${escapeHtml(title)}</b>
                <select class="text_pole lore_graph_map_mode">
                    ${highlight ? '<option value="highlight">This reply\'s lore</option>' : ''}
                    <option value="around">Around one thing</option>
                    <option value="whole">Whole graph</option>
                </select>
                <input class="text_pole lore_graph_map_focus" list="lore_graph_map_names" placeholder="Find an entity…" />
                <datalist id="lore_graph_map_names">${sorted.map(e => `<option value="${escapeHtml(e.name)}"></option>`).join('')}</datalist>
                <select class="text_pole lore_graph_map_steps" title="How many relationship steps to show">
                    <option value="1">1 step</option><option value="2">2 steps</option>
                </select>
                <select class="text_pole lore_graph_map_type"><option value="">All types</option>${ENTITY_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select>
                <select class="text_pole lore_graph_map_doc"><option value="">All documents</option>${allDocs.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')}</select>
                <label class="checkbox_label"><input type="checkbox" class="lore_graph_map_placeholders" /> <span>Placeholders only</span></label>
                <label class="checkbox_label"><input type="checkbox" class="lore_graph_map_hubs" checked /> <span>Hide hubs</span></label>
                <div class="menu_button lore_graph_map_fit" title="Fit to screen"><i class="fa-solid fa-expand"></i></div>
            </div>
            <div class="lore_graph_map_body">
                <div class="lore_graph_map_canvas"></div>
                <div class="lore_graph_map_side"><small class="lore_graph_empty">Click a dot or a line for details. Drag to move things, scroll to zoom.</small></div>
            </div>
            <div class="lore_graph_map_legend"></div>
        </div>`);

    root.find('.lore_graph_map_mode').val(view.mode);
    root.find('.lore_graph_map_focus').val(view.mode === 'highlight' ? '' : (byId.get(view.focus)?.name ?? ''));
    root.find('.lore_graph_map_legend').html(
        Object.entries(TYPE_COLORS).map(([type, color]) => `<span class="lore_graph_map_key"><i style="background:${color}"></i>${type}</span>`).join('')
        + '<span class="lore_graph_map_key"><i class="lore_graph_map_key_placeholder"></i>Placeholder</span>'
        + '<span class="lore_graph_map_key"><i class="lore_graph_map_key_guardrail"></i>Guardrail link</span>'
        + (highlight ? '<span class="lore_graph_map_key"><i style="background:#4caf50"></i>Matched / path</span>' : ''));

    /** Which entities to draw for the current view. */
    function visibleIds() {
        let ids;
        if (view.mode === 'highlight') {
            ids = new Set(highlight.nodes);
        } else if (view.mode === 'whole') {
            ids = new Set(graph.entities.map(e => e.id));
        } else {
            ids = new Set(view.focus ? [view.focus] : []);
            let frontier = [...ids];
            for (let step = 0; step < view.steps; step++) {
                const next = [];
                for (const id of frontier) {
                    for (const other of neighbors.get(id) ?? []) {
                        if (ids.has(other) || (view.hideHubs && isHub(other))) continue;
                        ids.add(other);
                        next.push(other);
                    }
                }
                frontier = next;
            }
        }
        const keep = (id) => {
            const entity = byId.get(id);
            if (!entity) return false;
            if (id === view.focus && view.mode === 'around') return true;
            if (view.mode === 'highlight' && (highlight.seeds.has(id) || highlight.meaning.has(id))) return true;
            if (view.hideHubs && view.mode !== 'highlight' && isHub(id)) return false;
            if (view.type && entity.type !== view.type) return false;
            if (view.doc && !docsOf(entity).has(view.doc)) return false;
            return true;
        };
        ids = new Set([...ids].filter(keep));
        if (view.placeholdersOnly) {
            // Placeholders plus what refers to them, so you can see where the gap is.
            const placeholders = [...ids].filter(id => byId.get(id).placeholder);
            ids = new Set(placeholders.flatMap(id => [id, ...[...(neighbors.get(id) ?? [])].filter(n => ids.has(n))]));
        }
        return ids;
    }

    function buildElements(ids) {
        const nodes = [...ids].map(id => {
            const e = byId.get(id);
            const classes = [e.placeholder ? 'placeholder' : '', id === view.focus && view.mode === 'around' ? 'focus' : ''];
            if (highlight && view.mode === 'highlight') {
                if (highlight.seeds.has(id)) classes.push('seed');
                else if (highlight.meaning.has(id)) classes.push('meaning');
                else classes.push('reached');
            }
            return { data: { id, label: e.name, color: TYPE_COLORS[e.type] ?? TYPE_COLORS.Concept, size: Math.min(e.sourceChunks.length, 12) }, classes: classes.filter(Boolean).join(' ') };
        });
        const edges = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => {
            const classes = [GUARDRAIL_TYPES.has(e.type) ? 'guardrail' : '', e.type === 'related_to' ? 'vague' : ''];
            if (highlight && view.mode === 'highlight' && (highlight.edges.has(`${e.source}|${e.target}`) || highlight.edges.has(`${e.target}|${e.source}`))) classes.push('path');
            return { data: { id: e.id, source: e.source, target: e.target, type: e.type, weight: e.weight }, classes: classes.filter(Boolean).join(' ') };
        });
        // "Section mentions term" links: from a shown entity defined in that section to the term.
        const mentionEdges = [];
        if (highlight && view.mode === 'highlight') {
            for (const { term, fromChunk } of highlight.mentions ?? []) {
                const from = [...ids].find(id => id !== term && byId.get(id)?.definedIn.includes(fromChunk));
                if (from && ids.has(term)) {
                    mentionEdges.push({ data: { id: `mention|${from}|${term}`, source: from, target: term, label: `${fromChunk.replace(/^\S+ /, '')} mentions it` }, classes: 'mention' });
                }
            }
        }
        return [...nodes, ...edges, ...mentionEdges];
    }

    let cy = null;
    /** Fits everything on screen, but never zooms in so far that labels get huge. */
    const fitView = () => {
        if (!cy) return;
        cy.fit(undefined, 30);
        if (cy.zoom() > 1.2) {
            cy.zoom(1.2);
            cy.center();
        }
    };
    const textColor = themeColor('--SmartThemeBodyColor', '#dddddd');
    const backgroundColor = themeColor('--SmartThemeBlurTintColor', '#222222');

    function draw() {
        const ids = visibleIds();
        if (view.mode === 'whole' && ids.size > MAX_WHOLE_NODES) {
            toastr.info(`Showing the first ${MAX_WHOLE_NODES} of ${ids.size} entities. Use the filters to narrow it down.`, 'Lore Graph');
        }
        const limited = new Set([...ids].slice(0, MAX_WHOLE_NODES));
        cy.elements().remove();
        cy.add(buildElements(limited));
        const ring = (n) => n.hasClass('seed') ? 3 : n.hasClass('meaning') ? 2 : 1;
        const layout = view.mode === 'highlight'
            ? { name: 'concentric', concentric: ring, levelWidth: () => 1, minNodeSpacing: 60, spacingFactor: 1.2, animate: false }
            : view.mode === 'around' && view.focus
            ? { name: 'concentric', concentric: (n) => n.id() === view.focus ? 2 : 1, levelWidth: () => 1, minNodeSpacing: 30, animate: false }
            // Small maps get more room so labels don't overlap; big ones stay compact.
            : { name: 'cose', animate: false, randomize: true, numIter: 1500, nodeOverlap: 30, componentSpacing: 80,
                nodeRepulsion: () => (limited.size < 60 ? 40000 : 9000), idealEdgeLength: () => (limited.size < 60 ? 140 : 90) };
        cy.layout(layout).run();
        fitView();
        root.find('.lore_graph_map_side').html(`<small class="lore_graph_empty">${limited.size} entities, ${cy.edges().length} relationships shown. Click a dot or a line for details.</small>`);
    }

    function showEntity(id) {
        const e = byId.get(id);
        if (!e) return;
        const links = graph.edges.filter(edge => edge.source === id || edge.target === id);
        const chunkLinks = (ids) => ids.map(c => `<span class="lore_graph_link lore_graph_map_chunk" data-chunk="${escapeHtml(c)}">${escapeHtml(c)}</span>`).join(', ');
        root.find('.lore_graph_map_side').html(`
            <h4 class="${e.placeholder ? 'lore_graph_placeholder' : ''}">${escapeHtml(e.name)} <span class="lore_graph_badge">${escapeHtml(e.type)}</span></h4>
            ${e.placeholder ? '<div class="lore_graph_placeholder">Placeholder: mentioned but not defined in any loaded document.</div>' : ''}
            <div>${escapeHtml(e.description || '(no description)')}</div>
            ${e.aliases.length ? `<div class="lore_graph_meta">Also called: ${e.aliases.map(escapeHtml).join(', ')}</div>` : ''}
            <div class="lore_graph_meta">Defined in: ${e.definedIn.length ? chunkLinks(e.definedIn) : '—'}</div>
            <div class="lore_graph_meta">Mentioned in: ${chunkLinks(e.sourceChunks)}</div>
            <div class="menu_button lore_graph_map_center" data-id="${escapeHtml(id)}">Show around this</div>
            <h4>Relations (${links.length})</h4>
            <ul class="lore_graph_relations">${links.slice(0, 40).map(edge => {
        const otherId = edge.source === id ? edge.target : edge.source;
        return `<li>${edge.source === id ? '→' : '←'} <span class="lore_graph_badge">${escapeHtml(edge.type)}</span> <span class="lore_graph_link lore_graph_map_entity" data-id="${escapeHtml(otherId)}">${escapeHtml(byId.get(otherId)?.name ?? otherId)}</span><div class="lore_graph_row_sub">${escapeHtml(edge.evidence)}</div></li>`;
    }).join('')}</ul>`);
    }

    function showEdge(edgeId) {
        if (edgeId.startsWith('mention|')) {
            const [, from, term] = edgeId.split('|');
            root.find('.lore_graph_map_side').html(`<h4>${escapeHtml(byId.get(term)?.name ?? term)}</h4><div>A section sent for this reply mentions this term, so the section that defines it was pulled in too.</div><div class="lore_graph_meta">Defined in: ${(byId.get(term)?.definedIn ?? []).map(c => `<span class="lore_graph_link lore_graph_map_chunk" data-chunk="${escapeHtml(c)}">${escapeHtml(c)}</span>`).join(', ')}</div>`);
            return;
        }
        const edge = graph.edges.find(e => e.id === edgeId);
        if (!edge) return;
        root.find('.lore_graph_map_side').html(`
            <h4>${escapeHtml(byId.get(edge.source)?.name ?? edge.source)} <span class="lore_graph_badge">${escapeHtml(edge.type)}</span> ${escapeHtml(byId.get(edge.target)?.name ?? edge.target)}</h4>
            <div>${escapeHtml(edge.evidence)}</div>
            <div class="lore_graph_meta">Found in ${edge.weight} chunk(s): ${edge.chunkIds.map(c => `<span class="lore_graph_link lore_graph_map_chunk" data-chunk="${escapeHtml(c)}">${escapeHtml(c)}</span>`).join(', ')}</div>`);
    }

    function focusOn(id) {
        if (!byId.has(id)) return;
        view.focus = id;
        view.mode = 'around';
        root.find('.lore_graph_map_mode').val('around');
        root.find('.lore_graph_map_focus').val(byId.get(id).name);
        draw();
        showEntity(id);
    }

    root.on('change', '.lore_graph_map_mode', function () { view.mode = String($(this).val()); draw(); });
    root.on('change', '.lore_graph_map_steps', function () { view.steps = Number($(this).val()); draw(); });
    root.on('change', '.lore_graph_map_type', function () { view.type = String($(this).val()); draw(); });
    root.on('change', '.lore_graph_map_doc', function () { view.doc = String($(this).val()); draw(); });
    root.on('change', '.lore_graph_map_placeholders', function () { view.placeholdersOnly = $(this).prop('checked'); draw(); });
    root.on('change', '.lore_graph_map_hubs', function () { view.hideHubs = $(this).prop('checked'); draw(); });
    root.on('change', '.lore_graph_map_focus', function () {
        const name = String($(this).val()).trim().toLowerCase();
        const match = graph.entities.find(e => e.name.toLowerCase() === name) ?? graph.entities.find(e => e.aliases.some(a => a.toLowerCase() === name));
        if (match) focusOn(match.id);
        else if (name) toastr.info('No entity with that name. Pick one from the suggestions.', 'Lore Graph');
    });
    root.on('click', '.lore_graph_map_fit', () => fitView());
    root.on('click', '.lore_graph_map_center', function () { focusOn(String($(this).data('id'))); });
    root.on('click', '.lore_graph_map_entity', function () { focusOn(String($(this).data('id'))); });
    root.on('click', '.lore_graph_map_chunk', function () { onOpenChunk(String($(this).data('chunk'))); });

    const init = () => {
        cy = cytoscape({
            container: root.find('.lore_graph_map_canvas')[0],
            wheelSensitivity: 0.3,
            minZoom: 0.05,
            maxZoom: 4,
            style: [
                {
                    selector: 'node',
                    style: {
                        'background-color': 'data(color)',
                        'label': 'data(label)',
                        'color': textColor,
                        'font-size': 11,
                        'min-zoomed-font-size': 7,
                        'text-valign': 'bottom',
                        'text-margin-y': 3,
                        'text-outline-color': backgroundColor,
                        'text-outline-width': 2,
                        'width': 'mapData(size, 1, 12, 16, 44)',
                        'height': 'mapData(size, 1, 12, 16, 44)',
                    },
                },
                { selector: 'node.placeholder', style: { 'background-opacity': 0.15, 'border-width': 2, 'border-style': 'dashed', 'border-color': '#e5a50a', 'color': '#e5a50a' } },
                { selector: 'node.focus', style: { 'border-width': 4, 'border-color': textColor, 'font-weight': 'bold', 'font-size': 13 } },
                { selector: 'node.seed', style: { 'border-width': 5, 'border-color': '#4caf50', 'font-weight': 'bold', 'font-size': 13 } },
                { selector: 'node.meaning', style: { 'border-width': 4, 'border-color': '#26c6da', 'border-style': 'double' } },
                { selector: 'node.reached', style: { 'opacity': 0.85 } },
                { selector: 'node:selected', style: { 'border-width': 4, 'border-color': '#ffffff' } },
                {
                    selector: 'edge',
                    style: {
                        'width': 'mapData(weight, 1, 4, 1.5, 4)',
                        'line-color': '#8a8a8a',
                        'target-arrow-color': '#8a8a8a',
                        'target-arrow-shape': 'triangle',
                        'arrow-scale': 0.8,
                        'curve-style': 'bezier',
                        'opacity': 0.6,
                    },
                },
                { selector: 'edge.vague', style: { 'width': 1, 'opacity': 0.3 } },
                { selector: 'edge.guardrail', style: { 'line-color': '#e53935', 'target-arrow-color': '#e53935', 'line-style': 'dashed', 'opacity': 0.9 } },
                { selector: 'edge.path', style: { 'line-color': '#4caf50', 'target-arrow-color': '#4caf50', 'width': 4, 'opacity': 1 } },
                {
                    selector: 'edge.mention',
                    style: {
                        'line-color': '#4caf50', 'target-arrow-color': '#4caf50', 'line-style': 'dotted', 'width': 3, 'opacity': 1,
                        'label': 'data(label)', 'font-size': 9, 'color': textColor, 'text-outline-color': backgroundColor, 'text-outline-width': 2,
                    },
                },
            ],
        });
        cy.on('tap', 'node', (event) => showEntity(event.target.id()));
        cy.on('tap', 'edge', (event) => showEdge(event.target.id()));
        cy.on('dbltap', 'node', (event) => focusOn(event.target.id()));
        draw();
        if (view.mode === 'around' && view.focus) showEntity(view.focus);
    };

    return callGenericPopup(root, POPUP_TYPE.TEXT, '', {
        large: true, leftAlign: true, okButton: 'Close',
        onOpen: () => setTimeout(init, 50),
        onClose: () => { cy?.destroy(); cy = null; },
    });
}
