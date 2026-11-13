// The 3D view of the lore map, drawn with 3d-force-graph
// (vendored as lib/3d-force-graph.min.js, MIT license, v1.80.1, which bundles three.js).
// graph-map.js decides what to show; this file only draws it and reports clicks.

const LIBRARY_URL = '/scripts/extensions/third-party/lore-graph/lib/3d-force-graph.min.js';

let libraryPromise = null;

/** Loads 3d-force-graph once (a plain script that defines window.ForceGraph3D). */
export function load3D() {
    if (window.ForceGraph3D) return Promise.resolve(window.ForceGraph3D);
    libraryPromise ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LIBRARY_URL;
        script.onload = () => window.ForceGraph3D ? resolve(window.ForceGraph3D) : reject(new Error('The 3D map library did not load.'));
        script.onerror = () => { libraryPromise = null; reject(new Error(`Could not load ${LIBRARY_URL}.`)); };
        document.head.appendChild(script);
    });
    return libraryPromise;
}

/** Whether this browser can draw 3D (WebGL). */
export function canDraw3D() {
    try {
        const canvas = document.createElement('canvas');
        return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
        return false;
    }
}

/** A distinct colour per document, spread around the colour wheel. */
export function documentColors(docs) {
    const golden = 137.508;
    return new Map(docs.map((doc, i) => [doc, `hsl(${Math.round((i * golden) % 360)}, 70%, 60%)`]));
}

/** Points spread evenly over a sphere (one cluster centre per document). */
function sphereCentres(count, radius) {
    const centres = [];
    const offset = 2 / Math.max(1, count);
    const increment = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
        const y = count === 1 ? 0 : ((i * offset) - 1) + (offset / 2);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const phi = i * increment;
        centres.push({ x: Math.cos(phi) * r * radius, y: y * radius, z: Math.sin(phi) * r * radius });
    }
    return centres;
}

/**
 * Draws a 3D graph in a container.
 * @param {HTMLElement} container
 * @param {object} options
 * @param {{ id: string, name: string, color: string, docColor: string, doc: string, size: number, placeholder: boolean, story: boolean }[]} options.nodes
 * @param {{ source: string, target: string, type: string, guardrail: boolean, crossdoc: boolean, path: boolean }[]} options.links
 * @param {'type'|'document'} options.colorBy
 * @param {boolean} options.cluster pull each document's things together
 * @param {string} options.background
 * @param {(id: string) => void} options.onPick a dot was clicked
 * @param {() => void} options.onClear empty space was clicked
 * @param {(text: string) => string} options.escape
 * @returns {Promise<{ destroy: () => void, highlight: (id: string|null) => void, setColorBy: (by: string) => void }>}
 */
export async function draw3D(container, { nodes, links, colorBy, cluster, background, onPick, onClear, escape }) {
    const ForceGraph3D = await load3D();
    const state = { colorBy, focus: null, lit: new Set(), litLinks: new Set() };
    const neighbours = new Map(nodes.map(n => [n.id, new Set()]));
    for (const link of links) {
        neighbours.get(link.source)?.add(link.target);
        neighbours.get(link.target)?.add(link.source);
    }
    const linkKey = (link) => `${typeof link.source === 'object' ? link.source.id : link.source}|${typeof link.target === 'object' ? link.target.id : link.target}`;

    /** The same colour, almost transparent (the 3D engine reads rgba() and hsla()). */
    const dim = (color) => {
        const hex = /^#([0-9a-f]{6})$/i.exec(color);
        if (hex) {
            const n = parseInt(hex[1], 16);
            return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, 0.12)`;
        }
        return color.startsWith('hsl(') ? color.replace('hsl(', 'hsla(').replace(/\)$/, ', 0.12)') : 'rgba(128,128,128,0.12)';
    };
    const baseColor = (node) => (state.colorBy === 'document' ? node.docColor : node.color);
    const nodeColor = (node) => {
        if (node.placeholder) return state.focus && !state.lit.has(node.id) ? 'rgba(229,165,10,0.08)' : 'rgba(229,165,10,0.55)';
        if (state.focus && !state.lit.has(node.id)) return dim(baseColor(node));
        return baseColor(node);
    };
    const linkColor = (link) => {
        if (state.focus && !state.litLinks.has(linkKey(link))) return 'rgba(140,140,140,0.04)';
        if (state.focus || link.path) return link.path ? '#4caf50' : link.guardrail ? '#ef5350' : '#dddddd';
        if (link.guardrail) return 'rgba(229,57,53,0.6)';
        return link.crossdoc ? 'rgba(160,160,160,0.12)' : 'rgba(160,160,160,0.35)';
    };

    const graph = ForceGraph3D({ controlType: 'orbit' })(container)
        .width(container.clientWidth)
        .height(container.clientHeight)
        .backgroundColor(background)
        .showNavInfo(false)
        .graphData({ nodes: nodes.map(n => ({ ...n })), links: links.map(l => ({ ...l })) })
        .nodeId('id')
        .nodeVal(node => 1 + node.size)
        .nodeRelSize(3)
        .nodeOpacity(0.92)
        .nodeResolution(12)
        .nodeColor(nodeColor)
        .nodeLabel(node => `<div class="lore_graph_3d_tip"><b>${escape(node.name)}</b>${node.doc ? `<br><small>${escape(node.doc)}</small>` : ''}</div>`)
        .linkColor(linkColor)
        .linkOpacity(1)
        .linkWidth(link => (state.litLinks.has(linkKey(link)) || link.path ? 1.6 : 0))
        .linkDirectionalArrowLength(link => (state.litLinks.has(linkKey(link)) ? 4 : 0))
        .linkDirectionalArrowRelPos(1)
        .linkDirectionalParticles(link => (state.litLinks.has(linkKey(link)) || link.path ? 2 : 0))
        .linkDirectionalParticleWidth(1.6)
        .onNodeClick(node => {
            highlight(node.id);
            // Fly the camera to the clicked dot.
            const distance = 140;
            const ratio = 1 + distance / Math.max(1, Math.hypot(node.x, node.y, node.z));
            graph.cameraPosition({ x: node.x * ratio, y: node.y * ratio, z: node.z * ratio }, node, 900);
            onPick(node.id);
        })
        .onBackgroundClick(() => {
            highlight(null);
            onClear();
        });

    // Pull each document's things toward their own spot on a sphere, so codices form clusters.
    if (cluster) {
        const docs = [...new Set(nodes.map(n => n.doc).filter(Boolean))];
        const radius = Math.max(150, Math.sqrt(nodes.length) * 22);
        const centres = new Map(sphereCentres(docs.length, radius).map((c, i) => [docs[i], c]));
        let simNodes = [];
        const clusterForce = (alpha) => {
            for (const node of simNodes) {
                const centre = centres.get(node.doc);
                if (!centre) continue;
                node.vx += (centre.x - node.x) * 0.15 * alpha;
                node.vy += (centre.y - node.y) * 0.15 * alpha;
                node.vz += (centre.z - node.z) * 0.15 * alpha;
            }
        };
        clusterForce.initialize = (all) => { simNodes = all; };
        graph.d3Force('cluster', clusterForce);
        graph.d3Force('charge')?.strength(-40);
    }

    function refresh() {
        graph.nodeColor(graph.nodeColor())
            .linkColor(graph.linkColor())
            .linkWidth(graph.linkWidth())
            .linkDirectionalArrowLength(graph.linkDirectionalArrowLength())
            .linkDirectionalParticles(graph.linkDirectionalParticles());
    }

    /** Spotlight one dot and its links (null clears it). */
    function highlight(id) {
        state.focus = id;
        state.lit = new Set(id ? [id, ...(neighbours.get(id) ?? [])] : []);
        state.litLinks = new Set(id ? links.filter(l => l.source === id || l.target === id).map(l => `${l.source}|${l.target}`) : []);
        refresh();
    }

    // Keep the drawing the size of its box (the popup can be resized with the window).
    const resize = new ResizeObserver(() => {
        if (container.clientWidth && container.clientHeight) graph.width(container.clientWidth).height(container.clientHeight);
    });
    resize.observe(container);
    // Frame everything once the layout has settled (and once early, so it doesn't start too close).
    let fitted = false;
    graph.cooldownTicks(250).onEngineStop(() => {
        if (!fitted) graph.zoomToFit(800, 40);
        fitted = true;
    });
    setTimeout(() => { if (!fitted) graph.zoomToFit(600, 40); }, 1200);

    return {
        destroy() {
            resize.disconnect();
            graph.pauseAnimation();
            graph._destructor?.();
            container.innerHTML = '';
        },
        highlight(id) {
            const node = graph.graphData().nodes.find(n => n.id === id);
            highlight(node ? id : null);
            if (node && Number.isFinite(node.x)) {
                const ratio = 1 + 140 / Math.max(1, Math.hypot(node.x, node.y, node.z));
                graph.cameraPosition({ x: node.x * ratio, y: node.y * ratio, z: node.z * ratio }, node, 900);
            }
        },
        setColorBy(by) {
            state.colorBy = by;
            refresh();
        },
        fit() {
            graph.zoomToFit(600, 40);
        },
    };
}
