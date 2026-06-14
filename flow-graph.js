// flow-graph.js
// Design-matched renderer for the live grant-flow network, styled to the
// NoProfits "ember-on-bone" system. Purpose-built for the three-pane app shell.
//
// Consumes the {grants, charities, connected} shape usaspending.js emits.
// Roles are derived for federal data:
//   focus  = the searched org (root)             -> brown / gold
//   govt   = a federal agency (id starts "A:")   -> rust  (the taxpayer source)
//   grantee= any other recipient (id "R:")       -> tan
// (the design's neutral "funder" charcoal isn't used — in federal data every
// funder IS a government agency, so they read in rust instead.)

const PALETTES = {
    light: {
        focus: '#362C17', govt: '#7A3320', grantee: '#C9BfA6', granteeStroke: '#A89B78',
        edge: '#CFC8BA', edgeLabel: '#7C7E80', labelFill: '#16140F',
        canvas: '#EFEADF', selStroke: '#362C17',
    },
    dark: {
        focus: '#C9B48A', govt: '#C98A6E', grantee: '#6E6450', granteeStroke: '#857A63',
        edge: '#3A352B', edgeLabel: '#A8A69C', labelFill: '#F1EDE3',
        canvas: '#100F0C', selStroke: '#C9B48A',
    },
};

export class FlowGraph {
    constructor(svgEl, { onSelect } = {}) {
        this.svg = d3.select(svgEl);
        this.onSelect = onSelect || (() => {});
        this.theme = 'light';
        this.layoutMode = 'hierarchy';
        this.selectedId = null;
        this.nodes = [];
        this.links = [];
        this.focusId = null;

        this.zoom = d3.zoom().scaleExtent([0.15, 6]).on('zoom', e => {
            this.root.attr('transform', e.transform);
        });
        this.svg.call(this.zoom);
        this.defs = this.svg.append('defs');
        this.root = this.svg.append('g');
        this.linkLayer = this.root.append('g');
        this.labelLayer = this.root.append('g');
        this.nodeLayer = this.root.append('g');

        // clear selection on background click
        this.svg.on('click', () => this.select(null));
    }

    pal() { return PALETTES[this.theme]; }

    size() {
        const r = this.svg.node().getBoundingClientRect();
        return { w: r.width || 900, h: r.height || 600 };
    }

    setTheme(theme) {
        this.theme = theme;
        if (this.nodes.length) this.paint();
    }

    roleOf(n) {
        if (n.id === this.focusId) return 'focus';
        return n.kind === 'agency' ? 'govt' : 'grantee';
    }

    fillFor(n) {
        const p = this.pal();
        const role = this.roleOf(n);
        return role === 'focus' ? p.focus : role === 'govt' ? p.govt : p.grantee;
    }

    render(graph, focusId) {
        this.focusId = focusId;
        this.selectedId = focusId;
        this.dim = false;          // show the whole graph until the user clicks

        const byId = new Map(graph.charities.map(c => [c.filer_ein, c]));
        const depth = graph.connected;
        const vols = graph.charities.map(c => c.receipt_amt || 1);
        const maxVol = Math.max(1, ...vols);

        this.nodes = graph.charities.map(c => ({
            id: c.filer_ein,
            name: c.filer_name.replace(/^🏛\s*/, ''),
            kind: c.filer_ein.startsWith('A:') ? 'agency' : 'recipient',
            depth: depth.get(c.filer_ein) ?? 0,
            vol: c.receipt_amt || 1,
            inflow: c.govt_amt || 0,
            outflow: c.grant_amt || 0,
            r: 16 + Math.sqrt((c.receipt_amt || 1) / maxVol) * 30,
        }));
        const nodeById = new Map(this.nodes.map(n => [n.id, n]));

        const maxAmt = Math.max(1, ...graph.grants.map(g => g.grant_amt));
        this.links = graph.grants
            .filter(g => nodeById.has(g.filer_ein) && nodeById.has(g.grant_ein))
            .map(g => ({
                source: g.filer_ein, target: g.grant_ein,
                amt: g.grant_amt,
                w: 1.5 + (g.grant_amt / maxAmt) * 6.5,
            }));

        this.buildSimulation();
        this.draw();
        this.applyLayout(this.layoutMode);
        this.onSelect(nodeById.get(focusId) || null);
    }

    buildSimulation() {
        if (this.simulation) this.simulation.stop();
        this.simulation = d3.forceSimulation(this.nodes)
            .force('link', d3.forceLink(this.links).id(d => d.id).distance(150).strength(0.15))
            .force('charge', d3.forceManyBody().strength(-900))
            .force('collide', d3.forceCollide().radius(d => d.r + 26).strength(1))
            .velocityDecay(0.45).alphaDecay(0.025)
            .on('tick', () => this.tick());
    }

    setupMarkers() {
        const p = this.pal();
        this.defs.selectAll('*').remove();
        for (const [id, color] of [['fg-arrow', p.edge], ['fg-arrow-sel', p.focus]]) {
            this.defs.append('marker')
                .attr('id', id).attr('viewBox', '0 0 10 10')
                .attr('refX', 9).attr('refY', 5)
                .attr('markerWidth', 6).attr('markerHeight', 6)
                .attr('orient', 'auto')
                .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('fill', color);
        }
    }

    draw() {
        this.setupMarkers();

        this.linkSel = this.linkLayer.selectAll('path').data(this.links).join('path')
            .attr('fill', 'none').attr('stroke-linecap', 'round');

        const lg = this.labelLayer.selectAll('g.elabel').data(this.links).join('g').attr('class', 'elabel');
        lg.selectAll('*').remove();
        lg.append('rect').attr('height', 16).attr('rx', 2);
        lg.append('text').attr('text-anchor', 'middle')
            .attr('font-family', "'JetBrains Mono', monospace").attr('font-size', 10.5).attr('font-weight', 500)
            .text(d => abbr(d.amt));
        this.elabelSel = lg;

        const ng = this.nodeLayer.selectAll('g.gnode').data(this.nodes).join('g')
            .attr('class', 'gnode').style('cursor', 'pointer')
            .on('click', (e, d) => { e.stopPropagation(); this.select(d.id); })
            .call(d3.drag()
                .on('start', (e, d) => { if (!e.active) this.simulation.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
                .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
                .on('end', (e, d) => { if (!e.active) this.simulation.alphaTarget(0); }));
        ng.selectAll('*').remove();
        ng.append('circle').attr('class', 'ring').attr('fill', 'none');
        ng.append('circle').attr('class', 'hit');
        ng.append('text').attr('class', 'nlabel').attr('text-anchor', 'middle')
            .attr('font-family', "'Barlow Condensed', sans-serif").attr('font-weight', 700)
            .attr('font-size', 14).attr('letter-spacing', '0.02em')
            .text(d => truncate(d.name, 26));
        this.nodeSel = ng;

        this.paint();
    }

    // Colors/strokes/opacity — re-run on theme change and selection change.
    // Dimming (focus+context) only kicks in once the user actively selects a
    // node; the initial view shows the whole graph at full opacity.
    paint() {
        const p = this.pal();
        this.setupMarkers();
        const sel = this.dim ? this.selectedId : null;
        const nbr = this.neighbors(sel);

        this.nodeSel.attr('opacity', d => (!sel || nbr.has(d.id)) ? 1 : 0.22);
        this.nodeSel.select('circle.hit')
            .attr('r', d => d.r)
            .attr('fill', d => this.fillFor(d))
            .attr('stroke', d => d.id === sel ? p.selStroke : 'transparent')
            .attr('stroke-width', d => d.id === sel ? 4 : 0);
        const ringed = d => this.roleOf(d) === 'govt' || d.taxpayerFunded;
        this.nodeSel.select('circle.ring')
            .attr('r', d => d.r + 6)
            .attr('stroke', d => ringed(d) ? p.govt : 'transparent')
            .attr('stroke-width', d => ringed(d) ? 2 : 0)
            .attr('stroke-dasharray', d => this.roleOf(d) === 'govt' ? '0' : '4 3');
        this.nodeSel.select('text.nlabel').attr('fill', p.labelFill);

        this.linkSel
            .attr('stroke', p.edge)
            .attr('stroke-width', d => d.w)
            .attr('marker-end', d => incident(d, sel) ? 'url(#fg-arrow-sel)' : 'url(#fg-arrow)')
            .attr('opacity', d => (!sel || incident(d, sel)) ? 0.95 : 0.18);
        this.linkSel.attr('stroke', d => incident(d, sel) ? p.focus : p.edge);

        this.elabelSel.attr('opacity', d => (!sel || incident(d, sel)) ? 1 : 0.12);
        this.elabelSel.select('rect').attr('fill', p.canvas);
        this.elabelSel.select('text').attr('fill', p.edgeLabel);
    }

    neighbors(id) {
        const s = new Set();
        if (!id) return s;
        s.add(id);
        for (const l of this.links) {
            const a = idof(l.source), b = idof(l.target);
            if (a === id) s.add(b);
            if (b === id) s.add(a);
        }
        return s;
    }

    select(id) {
        this.selectedId = id;
        this.dim = !!id;           // dim others only when something is selected
        this.paint();
        const n = id ? this.nodes.find(x => x.id === id) : null;
        this.onSelect(n);
    }

    // Flag nodes (by id) whose federal share of revenue is high enough to ring
    // in rust. Called after async 990 enrichment; repaints in place.
    setTaxpayerFlags(idSet) {
        for (const n of this.nodes) n.taxpayerFunded = idSet.has(n.id);
        if (this.nodeSel) this.paint();
    }

    applyLayout(mode) {
        this.layoutMode = mode;
        if (!this.simulation) return;
        const { w, h } = this.size();
        this.nodes.forEach(n => { n.fx = null; n.fy = null; });

        if (mode === 'hierarchy') {
            const maxDepth = d3.max(this.nodes, d => d.depth) || 1;
            const margin = Math.min(180, w * 0.16);
            const colW = (w - margin * 2) / Math.max(1, maxDepth);
            this.simulation
                .force('x', d3.forceX(d => margin + d.depth * colW).strength(1))
                .force('y', d3.forceY(h / 2).strength(0.06))
                .force('charge', d3.forceManyBody().strength(-500));
            this.simulation.force('link').distance(colW * 0.8).strength(0.1);
        } else {
            this.simulation
                .force('x', d3.forceX(w / 2).strength(0.04))
                .force('y', d3.forceY(h / 2).strength(0.04))
                .force('charge', d3.forceManyBody().strength(-1100));
            this.simulation.force('link').distance(150).strength(0.15);
        }
        this.simulation.alpha(0.9).restart();
        clearTimeout(this._fit);
        this._fit = setTimeout(() => this.zoomFit(), 1200);
    }

    tick() {
        if (!this.nodeSel) return;
        this.nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
        this.nodeSel.select('text.nlabel').attr('y', d => d.r + 17);

        this.linkSel.attr('d', d => {
            const a = d.source, b = d.target;
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
            const sx = a.x + dx / len * (a.r + 2), sy = a.y + dy / len * (a.r + 2);
            const ex = b.x - dx / len * (b.r + 9), ey = b.y - dy / len * (b.r + 9);
            const mx = (sx + ex) / 2;
            return `M${sx.toFixed(1)},${sy.toFixed(1)} C${mx.toFixed(1)},${sy.toFixed(1)} ${mx.toFixed(1)},${ey.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
        });

        this.elabelSel.each(function (d) {
            const a = d.source, b = d.target;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const g = d3.select(this);
            const txt = g.select('text');
            const wpx = abbr(d.amt).length * 7 + 8;
            g.select('rect').attr('x', mx - wpx / 2).attr('y', my - 8).attr('width', wpx);
            txt.attr('x', mx).attr('y', my + 4);
        });
    }

    zoomFit(pad = 0.86) {
        if (!this.root.node().childNodes.length) return;
        const b = this.root.node().getBBox();
        if (!b.width || !b.height) return;
        const { w, h } = this.size();
        const scale = Math.min(2, pad / Math.max(b.width / w, b.height / h));
        const tx = w / 2 - scale * (b.x + b.width / 2);
        const ty = h / 2 - scale * (b.y + b.height / 2);
        this.svg.transition().duration(500)
            .call(this.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }

    zoomBy(k) {
        this.svg.transition().duration(250).call(this.zoom.scaleBy, k);
    }
}

function idof(x) { return typeof x === 'object' ? x.id : x; }
function incident(l, id) { return id && (idof(l.source) === id || idof(l.target) === id); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function abbr(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + n;
}
export { abbr };
