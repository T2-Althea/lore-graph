// Milestone 5: a visual map of the lore graph, drawn with Cytoscape.js
// (vendored as lib/cytoscape.min.js, MIT license, v3.30.2 from the official npm package).

import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { ENTITY_TYPES } from './schema.js';
import { canDraw3D, documentColors, draw3D } from './graph-map-3d.js';

const LIBRARY_URL = '/scripts/extensions/third-party/lore-graph/lib/cytoscape.min.js';

/** Colors per entity type, readable on both dark and light themes. */
const TYPE_COLORS = {
    Organization: '#5c9dff', Role: '#9b8cff', Rank: '#c792ea', Place: '#4caf50', Creature: '#ef5350',
    Species: '#ff8a65', Phenomenon: '#26c6da', Material: '#ffca28', Object: '#a1887f', Credential: '#f06292',
    Procedure: '#7cb342', Rule: '#ab47bc', Event: '#ffa726', Concept: '#90a4ae',
    Story: '#ff79c6', // people/places from this chat's memories
};
const GUARDRAIL_TYPES = new Set(['contrasts_with', 'exception_to']);
/** Entities in more chunks than this are "hubs" that connect to everything. */
const HUB_CHUNKS = 8;
const MAX_WHOLE_NODES = 700;
/** In the whole-graph view, only this many of the best-connected dots are labelled until you zoom in. */
const WHOLE_LABELS = 30;

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
 * @param {Map<string, string>} [options.docTitles] document id -> title, for the group boxes
 * @param {object} [options.saved] map options remembered from last time (see MAP_SAVED_KEYS)
 * @param {(saved: object) => void} [options.onSave] called with the options whenever one changes
 */
export async function showGraphMap(graph, { onOpenChunk, focus, highlight, story = null, title = 'Lore map', docTitles = new Map(), saved = {}, onSave = null }) {
    // Story people/places from the open chat's memories, drawn alongside the lore.
    if (story?.entities.length) {
        graph = { entities: [...graph.entities, ...story.entities], edges: [...graph.edges, ...story.edges] };
    }
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
    /** The document an entity belongs to for grouping: where it's defined, else where it's mentioned most. */
    const homeDoc = (entity) => {
        if (entity.story) return '';
        const from = entity.definedIn.length ? entity.definedIn : entity.sourceChunks;
        const counts = new Map();
        for (const chunkId of from) {
            const doc = chunkId.split(' ')[0];
            counts.set(doc, (counts.get(doc) ?? 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    };
    const allDocs = [...new Set(graph.entities.flatMap(e => [...docsOf(e)]))].sort();
    const sorted = [...graph.entities].sort((a, b) => a.name.localeCompare(b.name));
    /** "COS-025 The Ocean": the document code plus the start of its title, short enough for a box. */
    const shortDocLabel = (doc) => {
        const title = String(docTitles.get(doc) ?? '').split(/\s[—–-]\s|:/)[0].trim();
        return title ? `${doc} ${title.length > 22 ? `${title.slice(0, 21)}…` : title}` : doc;
    };

    const view = {
        mode: highlight ? 'highlight' : focus ? 'around' : 'around',
        // Start on the best-connected entity that isn't a hub: usually a meaningful centre.
        focus: focus ?? [...graph.entities].filter(e => !e.placeholder && !isHub(e.id)).sort((a, b) => neighbors.get(b.id).size - neighbors.get(a.id).size)[0]?.id ?? sorted[0]?.id,
        steps: 1,
        type: '',
        doc: '',
        section: '', // one chunk of the chosen document: what extraction got from it
        placeholders: 'hide', // hide | show | only
        hideHubs: true,
        group: true,
        threeD: false,
        colorBy: 'type', // 3D only: type | document
        showStory: true,
    };
    // Options remembered from last time (filters by type/document aren't, so the map never opens empty).
    const valid = {
        mode: (v) => v === 'around' || v === 'whole',
        steps: (v) => v === 1 || v === 2,
        placeholders: (v) => ['hide', 'show', 'only'].includes(v),
        hideHubs: (v) => typeof v === 'boolean',
        group: (v) => typeof v === 'boolean',
        threeD: (v) => v === false || (v === true && canDraw3D()),
        colorBy: (v) => v === 'type' || v === 'document',
        showStory: (v) => typeof v === 'boolean',
    };
    for (const [key, ok] of Object.entries(valid)) {
        if (key === 'mode' && (highlight || focus)) continue; // a report or "show on map" picks its own view
        if (saved && Object.hasOwn(saved, key) && ok(saved[key])) view[key] = saved[key];
    }
    const persist = () => {
        if (!onSave) return;
        const out = {};
        for (const key of Object.keys(valid)) {
            if (key === 'mode' && view.mode === 'highlight') continue;
            out[key] = view[key];
        }
        onSave(out);
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
                <select class="text_pole lore_graph_map_section" title="Only the things extraction found in one section of this document" style="display: none;"><option value="">All sections</option></select>
                <select class="text_pole lore_graph_map_placeholders" title="Placeholders are things your lore mentions but never explains (dashed yellow dots)">
                    <option value="hide">Hide placeholders</option><option value="show">Show placeholders</option><option value="only">Only placeholders</option>
                </select>
                <label class="checkbox_label" title="Hubs are very common things (in more than ${HUB_CHUNKS} sections) that connect to almost everything. Hiding them keeps the map readable. Click a dot to see any links that were hidden."><input type="checkbox" class="lore_graph_map_hubs" checked /> <span>Hide hubs</span></label>
                <label class="checkbox_label" title="Whole graph: put each document's things in its own box"><input type="checkbox" class="lore_graph_map_group" checked /> <span>Group by document</span></label>
                ${story?.entities.length ? '<label class="checkbox_label"><input type="checkbox" class="lore_graph_map_story" checked /> <span>Story (this chat)</span></label>' : ''}
                <label class="checkbox_label" title="${canDraw3D() ? 'Show the map in 3D. Drag to turn it, scroll to zoom, right-drag to move. Hover a dot for its name; click it to fly there.' : 'Your browser can\'t draw 3D (WebGL is off or unavailable).'}"><input type="checkbox" class="lore_graph_map_3d" ${canDraw3D() ? '' : 'disabled'} /> <span>3D</span></label>
                <select class="text_pole lore_graph_map_color" title="3D: colour the dots by what kind of thing they are, or by which document they come from" style="display: none;">
                    <option value="type">Colour by type</option><option value="document">Colour by document</option>
                </select>
                <div class="menu_button lore_graph_map_fit" title="Fit to screen"><i class="fa-solid fa-expand"></i></div>
            </div>
            <div class="lore_graph_map_body">
                <div class="lore_graph_map_canvas"></div>
                <div class="lore_graph_map_canvas3d" style="display: none;"></div>
                <div class="lore_graph_map_side"><small class="lore_graph_empty">Click a dot to spotlight it and see details. Click empty space to undo. Scroll to zoom: more names appear as you zoom in.</small></div>
            </div>
            <div class="lore_graph_map_legend"></div>
        </div>`);

    root.find('.lore_graph_map_mode').val(view.mode);
    root.find('.lore_graph_map_steps').val(String(view.steps));
    root.find('.lore_graph_map_placeholders').val(view.placeholders);
    root.find('.lore_graph_map_hubs').prop('checked', view.hideHubs);
    root.find('.lore_graph_map_group').prop('checked', view.group);
    root.find('.lore_graph_map_story').prop('checked', view.showStory);
    root.find('.lore_graph_map_3d').prop('checked', view.threeD);
    root.find('.lore_graph_map_color').val(view.colorBy).toggle(view.threeD);
    root.find('.lore_graph_map_focus').val(view.mode === 'highlight' ? '' : (byId.get(view.focus)?.name ?? ''));
    root.find('.lore_graph_map_legend').html(
        Object.entries(TYPE_COLORS).map(([type, color]) => `<span class="lore_graph_map_key"><i style="background:${color}"></i>${type}</span>`).join('')
        + '<span class="lore_graph_map_key"><i class="lore_graph_map_key_placeholder"></i>Placeholder</span>'
        + '<span class="lore_graph_map_key"><i class="lore_graph_map_key_guardrail"></i>Guardrail link</span>'
        + (story?.entities.length ? '<span class="lore_graph_map_key"><i class="lore_graph_map_key_story"></i>Story link (from memories)</span>' : '')
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
            if (!view.showStory && entity.story) return false;
            if (view.hideHubs && view.mode !== 'highlight' && isHub(id)) return false;
            if (view.placeholders === 'hide' && entity.placeholder && view.mode !== 'highlight' && id !== view.focus) return false;
            if (view.type && entity.type !== view.type) return false;
            if (view.doc && !docsOf(entity).has(view.doc)) return false;
            if (view.section && !entity.sourceChunks.includes(view.section)) return false;
            return true;
        };
        ids = new Set([...ids].filter(keep));
        if (view.placeholders === 'only') {
            // Placeholders plus what refers to them, so you can see where the gap is.
            const placeholders = [...ids].filter(id => byId.get(id).placeholder);
            ids = new Set(placeholders.flatMap(id => [id, ...[...(neighbors.get(id) ?? [])].filter(n => ids.has(n))]));
        }
        return ids;
    }

    function buildElements(ids) {
        const whole = view.mode === 'whole';
        // Whole graph: only the best-connected dots keep their names until you zoom in.
        const visibleDegree = (id) => [...(neighbors.get(id) ?? [])].filter(n => ids.has(n)).length;
        const major = new Set(whole ? [...ids].sort((a, b) => visibleDegree(b) - visibleDegree(a)).slice(0, WHOLE_LABELS) : ids);
        const grouped = whole && view.group;
        const parents = new Map();
        const nodes = [...ids].map(id => {
            const e = byId.get(id);
            const classes = [e.placeholder ? 'placeholder' : '', e.story ? 'story' : '', id === view.focus && view.mode === 'around' ? 'focus' : '', major.has(id) ? (whole ? 'major' : '') : 'minor'];
            // Every link goes to a hidden hub: mark it, so it doesn't look unconnected.
            if (view.hideHubs && !visibleDegree(id) && [...(neighbors.get(id) ?? [])].some(isHub)) classes.push('hubonly');
            const doc = grouped ? homeDoc(e) : '';
            if (doc && !parents.has(doc)) {
                parents.set(doc, { data: { id: `doc:${doc}`, label: shortDocLabel(doc) }, classes: 'docgroup' });
            }
            if (highlight && view.mode === 'highlight') {
                if (highlight.seeds.has(id)) classes.push('seed');
                else if (highlight.meaning.has(id)) classes.push('meaning');
                else classes.push('reached');
            }
            return { data: { id, label: e.name, color: TYPE_COLORS[e.type] ?? TYPE_COLORS.Concept, size: Math.min(e.sourceChunks.length, 12), ...(doc ? { parent: `doc:${doc}` } : {}) }, classes: classes.filter(Boolean).join(' ') };
        });
        nodes.unshift(...parents.values());
        const edges = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => {
            const classes = [GUARDRAIL_TYPES.has(e.type) ? 'guardrail' : '', e.type === 'related_to' ? 'vague' : '', e.type === 'story' ? 'storylink' : ''];
            if (highlight && view.mode === 'highlight' && (highlight.edges.has(`${e.source}|${e.target}`) || highlight.edges.has(`${e.target}|${e.source}`))) classes.push('path');
            if (grouped && homeDoc(byId.get(e.source)) !== homeDoc(byId.get(e.target))) classes.push('crossdoc');
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

    let three = null;
    let threeToken = 0;

    /** The 3D view of the same dots and lines the 2D map would show. */
    async function drawThree(ids) {
        const token = ++threeToken;
        three?.destroy();
        three = null;
        root.find('.lore_graph_map_canvas').hide();
        const box = root.find('.lore_graph_map_canvas3d').show()[0];
        const docs = [...new Set([...ids].map(id => homeDoc(byId.get(id))).filter(Boolean))].sort();
        const docColor = documentColors(docs);
        const nodes = [...ids].map(id => {
            const e = byId.get(id);
            const doc = homeDoc(e);
            return {
                id, name: e.name, color: TYPE_COLORS[e.type] ?? TYPE_COLORS.Concept, docColor: e.story ? TYPE_COLORS.Story : (docColor.get(doc) ?? TYPE_COLORS.Concept),
                doc: doc ? shortDocLabel(doc) : '', size: Math.min(e.sourceChunks.length, 12), placeholder: !!e.placeholder, story: !!e.story,
            };
        });
        const links = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => ({
            source: e.source, target: e.target, type: e.type, guardrail: GUARDRAIL_TYPES.has(e.type),
            crossdoc: homeDoc(byId.get(e.source)) !== homeDoc(byId.get(e.target)),
            path: !!(highlight && view.mode === 'highlight' && (highlight.edges.has(`${e.source}|${e.target}`) || highlight.edges.has(`${e.target}|${e.source}`))),
        }));
        root.find('.lore_graph_map_side').html('<small class="lore_graph_empty">Building the 3D map…</small>');
        let drawn;
        try {
            drawn = await draw3D(box, {
                nodes, links, colorBy: view.colorBy, cluster: view.group && view.mode !== 'around',
                background: backgroundColor, escape: escapeHtml,
                onPick: (id) => showEntity(id),
                onClear: () => root.find('.lore_graph_map_side').html(threeHint(ids.size, links.length)),
            });
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Lore Graph');
            view.threeD = false;
            root.find('.lore_graph_map_3d').prop('checked', false);
            root.find('.lore_graph_map_color').hide();
            draw();
            return;
        }
        if (token !== threeToken || !view.threeD) {
            drawn.destroy();
            return;
        }
        three = drawn;
        root.find('.lore_graph_map_side').html(threeHint(ids.size, links.length));
        if (view.mode === 'around' && view.focus) {
            three.highlight(view.focus);
            showEntity(view.focus);
        }
    }

    const threeHint = (dots, lines) => `<small class="lore_graph_empty">${dots} entities, ${lines} relationships in 3D. Drag to turn, scroll to zoom, right-drag to move. Hover a dot for its name; click it to fly there and see details. Click empty space to undo.</small>`;

    /** Back to the flat map. */
    function leaveThree() {
        threeToken++;
        three?.destroy();
        three = null;
        root.find('.lore_graph_map_canvas3d').hide();
        root.find('.lore_graph_map_canvas').show();
    }

    function draw() {
        const ids = visibleIds();
        if (view.threeD) {
            drawThree(new Set([...ids].slice(0, MAX_WHOLE_NODES)));
            return;
        }
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
                nodeRepulsion: () => (limited.size < 60 ? 40000 : 14000), idealEdgeLength: () => (limited.size < 60 ? 140 : 110),
                nestingFactor: 0.1, gravity: 0.6, edgeElasticity: () => 60 };
        if (view.mode === 'whole' && view.group && cy.nodes('.docgroup').length) {
            layoutGroups();
        } else {
            cy.layout(layout).run();
        }
        fitView();
        const zoomHint = view.mode === 'whole' ? ' Only the most connected names are shown until you zoom in.' : '';
        root.find('.lore_graph_map_side').html(`<small class="lore_graph_empty">${limited.size} entities, ${cy.edges().length} relationships shown. Click a dot to spotlight it and see details. Click empty space to undo.${zoomHint}</small>`);
    }

    /** "Links to common things hidden by Hide hubs: …" for a clicked dot. */
    function hiddenHubNote(id, links) {
        if (!view.hideHubs || isHub(id)) return '';
        const hidden = [...new Set(links.map(edge => edge.source === id ? edge.target : edge.source).filter(isHub))];
        if (!hidden.length) return '';
        return `<div class="lore_graph_meta">Also linked to common things hidden by "Hide hubs": ${hidden.map(h => escapeHtml(byId.get(h)?.name ?? h)).join(', ')}</div>`;
    }

    /**
     * Whole graph, grouped: each document's island is laid out on its own (with only its own
     * links), then the islands are arranged in rows, biggest first. Laying everything out at once
     * with group boxes makes the built-in layout blow up, and it can't run on part of a group, so
     * each island is laid out in a hidden scratch copy and the real dots are moved to match.
     */
    function layoutGroups() {
        const groups = cy.nodes('.docgroup').sort((a, b) => b.children().length - a.children().length);
        const loose = cy.nodes().filter(n => !n.hasClass('docgroup') && !n.isChild());
        const islands = [...groups.map(g => g.children()), ...(loose.length ? [loose] : [])];
        const gap = 200;
        const rowWidth = Math.max(1600, Math.sqrt(cy.nodes().length) * 260);
        let x = 0;
        let y = 0;
        let rowHeight = 0;
        for (const kids of islands) {
            const scratch = cytoscape({
                headless: true,
                styleEnabled: true,
                style: [{ selector: 'node', style: { width: 30, height: 30 } }],
                elements: [
                    ...kids.map(n => ({ data: { id: n.id() } })),
                    ...kids.edgesWith(kids).map(e => ({ data: { id: e.id(), source: e.source().id(), target: e.target().id() } })),
                ],
            });
            scratch.layout({
                name: kids.length > 2 ? 'cose' : 'grid', animate: false, randomize: true, fit: false, numIter: 800,
                nodeRepulsion: () => 9000, idealEdgeLength: () => 70, nodeOverlap: 20, gravity: 1, componentSpacing: 40,
            }).run();
            kids.positions(node => ({ ...scratch.getElementById(node.id()).position() }));
            scratch.destroy();
            const box = kids.boundingBox({ includeLabels: false });
            if (x > 0 && x + box.w > rowWidth) {
                x = 0;
                y += rowHeight + gap;
                rowHeight = 0;
            }
            const dx = x - box.x1;
            const dy = y - box.y1;
            kids.positions(node => ({ x: node.position('x') + dx, y: node.position('y') + dy }));
            x += box.w + gap;
            rowHeight = Math.max(rowHeight, box.h);
        }
    }

    function showEntity(id) {
        const e = byId.get(id);
        if (!e) return;
        const links = graph.edges.filter(edge => edge.source === id || edge.target === id);
        const chunkLinks = (ids) => ids.map(c => `<span class="lore_graph_link lore_graph_map_chunk" data-chunk="${escapeHtml(c)}">${escapeHtml(c)}</span>`).join(', ');
        root.find('.lore_graph_map_side').html(`
            <h4 class="${e.placeholder ? 'lore_graph_placeholder' : ''}">${escapeHtml(e.name)} <span class="lore_graph_badge">${escapeHtml(e.type)}</span></h4>
            ${e.placeholder ? '<div class="lore_graph_placeholder">Placeholder: mentioned but not defined in any loaded document.</div>' : ''}
            ${e.story
                ? `<div class="lore_graph_meta">From this chat's memories (${e.memories.length}):</div><ul>${e.memories.slice(-5).map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
                : `<div>${escapeHtml(e.description || '(no description)')}</div>
            ${e.aliases.length ? `<div class="lore_graph_meta">Also called: ${e.aliases.map(escapeHtml).join(', ')}</div>` : ''}
            <div class="lore_graph_meta">Defined in: ${e.definedIn.length ? chunkLinks(e.definedIn) : '—'}</div>
            <div class="lore_graph_meta">Mentioned in: ${chunkLinks(e.sourceChunks)}</div>`}
            ${hiddenHubNote(id, links)}
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
        if (edge.type === 'story') {
            root.find('.lore_graph_map_side').html(`
                <h4>${escapeHtml(byId.get(edge.source)?.name ?? edge.source)} ⇄ ${escapeHtml(byId.get(edge.target)?.name ?? edge.target)}</h4>
                <div class="lore_graph_meta">From this chat's memories:</div>
                <ul>${edge.memories.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`);
            return;
        }
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
    /** The section list for the chosen document, in document order ("§2" before "§10"). */
    const fillSections = () => {
        const box = root.find('.lore_graph_map_section');
        view.section = '';
        if (!view.doc) {
            box.hide().html('<option value="">All sections</option>');
            return;
        }
        const number = (id) => Number(/§(\d+)/.exec(id)?.[1] ?? 0);
        const ids = [...new Set(graph.entities.flatMap(e => e.sourceChunks).filter(c => c.split(' ')[0] === view.doc))]
            .sort((a, b) => number(a) - number(b) || a.localeCompare(b));
        box.html(`<option value="">All sections</option>${ids.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id.slice(view.doc.length + 1))}</option>`).join('')}`).show();
    };
    root.on('change', '.lore_graph_map_doc', function () { view.doc = String($(this).val()); fillSections(); draw(); });
    root.on('change', '.lore_graph_map_section', function () { view.section = String($(this).val()); draw(); });
    root.on('change', '.lore_graph_map_placeholders', function () { view.placeholders = String($(this).val()); draw(); });
    root.on('change', '.lore_graph_map_group', function () { view.group = $(this).prop('checked'); draw(); });
    root.on('change', '.lore_graph_map_hubs', function () { view.hideHubs = $(this).prop('checked'); draw(); });
    root.on('change', '.lore_graph_map_story', function () { view.showStory = $(this).prop('checked'); draw(); });
    root.on('change', '.lore_graph_map_focus', function () {
        const name = String($(this).val()).trim().toLowerCase();
        const match = graph.entities.find(e => e.name.toLowerCase() === name) ?? graph.entities.find(e => e.aliases.some(a => a.toLowerCase() === name));
        if (match) focusOn(match.id);
        else if (name) toastr.info('No entity with that name. Pick one from the suggestions.', 'Lore Graph');
    });
    root.on('click', '.lore_graph_map_fit', () => (view.threeD ? three?.fit() : fitView()));
    const typeLegend = root.find('.lore_graph_map_legend').html();
    /** The colour key matches what the dots are coloured by. */
    const updateLegend = () => root.find('.lore_graph_map_legend').html(view.threeD && view.colorBy === 'document'
        ? '<span class="lore_graph_map_key">Colours show which document each dot comes from. Hover a dot to see its document.</span>'
        : typeLegend);
    root.on('change', '.lore_graph_map_3d', function () {
        view.threeD = $(this).prop('checked');
        root.find('.lore_graph_map_color').toggle(view.threeD);
        updateLegend();
        if (!view.threeD) leaveThree();
        draw();
    });
    root.on('change', '.lore_graph_map_color', function () {
        view.colorBy = String($(this).val());
        three?.setColorBy(view.colorBy);
        updateLegend();
    });
    updateLegend();
    // Bound after the handlers above, so the view is already updated when it's saved.
    root.on('change', '.lore_graph_map_toolbar select, .lore_graph_map_toolbar input[type="checkbox"]', persist);
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
                // Unlabelled until zoomed in (11px text only shows once it's at least 16px on screen).
                { selector: 'node.minor', style: { 'min-zoomed-font-size': 16 } },
                // Whole graph: the best-connected names stay readable when zoomed out.
                { selector: 'node.major', style: { 'font-size': 34, 'font-weight': 'bold', 'min-zoomed-font-size': 5, 'text-outline-width': 4 } },
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
                { selector: 'node.story', style: { 'shape': 'diamond', 'color': '#ff79c6', 'width': 26, 'height': 26 } },
                { selector: 'edge.storylink', style: { 'line-color': '#ff79c6', 'target-arrow-shape': 'none', 'line-style': 'dotted', 'width': 2, 'opacity': 0.8 } },
                { selector: 'edge.guardrail', style: { 'line-color': '#e53935', 'target-arrow-color': '#e53935', 'line-style': 'dashed', 'opacity': 0.9 } },
                { selector: 'edge.path', style: { 'line-color': '#4caf50', 'target-arrow-color': '#4caf50', 'width': 4, 'opacity': 1 } },
                {
                    selector: 'edge.mention',
                    style: {
                        'line-color': '#4caf50', 'target-arrow-color': '#4caf50', 'line-style': 'dotted', 'width': 3, 'opacity': 1,
                        'label': 'data(label)', 'font-size': 9, 'color': textColor, 'text-outline-color': backgroundColor, 'text-outline-width': 2,
                    },
                },
                { selector: 'edge.crossdoc', style: { 'opacity': 0.12 } },
                { selector: 'node.hubonly', style: { 'border-width': 2, 'border-style': 'dotted', 'border-color': '#8a8a8a' } },
                {
                    selector: 'node.docgroup',
                    style: {
                        'background-opacity': 0.05, 'background-color': textColor, 'border-width': 1, 'border-color': '#8a8a8a', 'border-opacity': 0.5,
                        'shape': 'round-rectangle', 'label': 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'font-size': 40, 'text-wrap': 'wrap', 'text-max-width': '280px',
                        'font-weight': 'bold', 'min-zoomed-font-size': 5, 'padding': '18px', 'color': textColor, 'text-opacity': 0.7,
                    },
                },
                // Spotlight: a clicked dot, its links and neighbours stay; everything else fades.
                { selector: '.faded', style: { 'opacity': 0.08, 'text-opacity': 0 } },
                { selector: 'node.docgroup.faded', style: { 'opacity': 0.25, 'text-opacity': 0.4 } },
                { selector: 'node.lit', style: { 'min-zoomed-font-size': 0 } },
                { selector: 'edge.lit', style: { 'opacity': 1, 'width': 2.5 } },
            ],
        });
        const clearSpotlight = () => cy.elements().removeClass('faded lit');
        cy.on('tap', 'node', (event) => {
            const node = event.target;
            if (node.hasClass('docgroup')) return;
            const near = node.closedNeighborhood();
            cy.elements().removeClass('lit').addClass('faded');
            near.union(near.nodes().ancestors()).removeClass('faded').addClass('lit');
            showEntity(node.id());
        });
        cy.on('tap', (event) => { if (event.target === cy) clearSpotlight(); });
        cy.on('tap', 'edge', (event) => showEdge(event.target.id()));
        cy.on('dbltap', 'node', (event) => focusOn(event.target.id()));
        draw();
        if (view.mode === 'around' && view.focus) showEntity(view.focus);
    };

    return callGenericPopup(root, POPUP_TYPE.TEXT, '', {
        large: true, leftAlign: true, okButton: 'Close',
        onOpen: () => setTimeout(init, 50),
        onClose: () => { threeToken++; three?.destroy(); three = null; cy?.destroy(); cy = null; },
    });
}
