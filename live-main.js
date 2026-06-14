import { USASpendingDataManager } from './usaspending.js';
import { FlowGraph, abbr } from './flow-graph.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

class LiveApp {
    constructor() {
        this.data = new USASpendingDataManager();
        this.graph = null;        // FlowGraph
        this.matches = [];
        this.picked = null;
        this.lastGraph = null;    // {grants, charities, connected}
        this.focusId = null;
        this.searchTimer = null;
        this.theme = 'light';
    }

    init() {
        this.graph = new FlowGraph($('network'), { onSelect: n => this.renderInspector(n) });
        this.buildYearChecks();
        this.paintLegend();

        $('orgFilter').addEventListener('input', e => this.onSearch(e.target.value));
        $('goBtn').addEventListener('click', () => this.render());
        $('orgFilter').addEventListener('keydown', e => { if (e.key === 'Enter') this.render(); });

        $('depth').addEventListener('input', e => $('depthVal').textContent = e.target.value);
        $('maxOrgs').addEventListener('input', e => $('maxOrgsVal').textContent = e.target.value);

        $('layoutSeg').addEventListener('click', e => {
            const btn = e.target.closest('button[data-mode]');
            if (!btn) return;
            [...$('layoutSeg').children].forEach(b => b.classList.toggle('on', b === btn));
            if (this.lastGraph) this.graph.applyLayout(btn.dataset.mode);
        });

        $('zoomIn').addEventListener('click', () => this.graph.zoomBy(1.3));
        $('zoomOut').addEventListener('click', () => this.graph.zoomBy(1 / 1.3));
        $('fitBtn').addEventListener('click', () => this.graph.zoomFit());

        $('themeToggle').addEventListener('click', () => this.toggleTheme());
        window.addEventListener('resize', () => { if (this.lastGraph) this.graph.zoomFit(); });
    }

    buildYearChecks() {
        const yc = $('yearCheckboxes');
        const now = 2025;
        for (let y = now; y > now - 4; y--) {
            const lab = el('label');
            lab.innerHTML = `<input type="checkbox" value="${y}" ${y >= now - 1 ? 'checked' : ''}> FY${y}`;
            yc.appendChild(lab);
        }
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', this.theme);
        this.graph.setTheme(this.theme);
        this.paintLegend();
    }

    paintLegend() {
        // mirror the renderer's role palette so the legend swatches match the canvas
        const p = this.theme === 'dark'
            ? { focus: '#C9B48A', govt: '#C98A6E', grantee: '#6E6450' }
            : { focus: '#362C17', govt: '#7A3320', grantee: '#C9BfA6' };
        $('legFocus').style.background = p.focus;
        $('legGovt').style.background = p.govt;
        $('legGrantee').style.background = p.grantee;
    }

    onSearch(text) {
        this.picked = null;
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(async () => {
            const matches = await this.data.searchRecipients(text);
            this.matches = matches;
            const list = $('matchList');
            list.innerHTML = '';
            for (const m of matches) {
                const li = el('li', null, m.name);
                li.addEventListener('click', () => {
                    this.picked = m;
                    $('orgFilter').value = m.name;
                    list.hidden = true;
                });
                list.appendChild(li);
            }
            list.hidden = matches.length === 0;
        }, 300);
    }

    filters() {
        const years = [...$('yearCheckboxes').querySelectorAll('input:checked')].map(c => +c.value);
        return { depth: +$('depth').value, maxOrgs: +$('maxOrgs').value, years: years.length ? years : [2024, 2025], perAgencyFanout: 8 };
    }

    async resolveRoot(text, years) {
        const tried = new Set();
        const candidates = [];
        if (this.picked) candidates.push(this.picked);
        candidates.push(...this.matches);
        if (!candidates.length) candidates.push(...await this.data.searchRecipients(text));
        for (const c of candidates) {
            if (tried.has(c.id)) continue;
            tried.add(c.id);
            const edges = await this.data.recipientEdges(c.name, years);
            if (edges.length) return c;
        }
        return null;
    }

    async render() {
        const text = $('orgFilter').value.trim();
        if (!text) return;
        const filters = this.filters();
        $('matchList').hidden = true;
        $('goBtn').disabled = true;
        $('goBtn').textContent = 'Loading…';
        try {
            const root = await this.resolveRoot(text, filters.years);
            if (!root) { this.fail(`No federal grant awards for any “${text}” match.`); return; }
            $('orgFilter').value = root.name;
            const data = await this.data.buildGraph(root, filters);
            this.lastGraph = data;
            this.focusId = root.id;

            $('canvasHint').style.display = 'none';
            const mode = $('layoutSeg').querySelector('.on').dataset.mode;
            this.graph.layoutMode = mode;
            this.graph.render(data, root.id);
            this.updateChrome(data, root);
        } catch (e) {
            console.error(e);
            this.fail('Live fetch failed: ' + e.message);
        } finally {
            $('goBtn').disabled = false;
            $('goBtn').textContent = 'Visualize ▶';
        }
    }

    fail(msg) {
        const insp = $('inspector');
        insp.innerHTML = '';
        insp.appendChild(el('div', 'insp-empty', `<span style="color:var(--alert)">${msg}</span>`));
    }

    updateChrome(data, root) {
        $('focusChip').textContent = trunc(root.name, 34);
        const total = data.grants.reduce((s, g) => s + g.grant_amt, 0);
        const agencies = data.charities.filter(c => c.filer_ein.startsWith('A:')).length;
        $('stOrgs').textContent = data.charities.length;
        $('stFlows').textContent = data.grants.length;
        $('stTotal').textContent = abbr(total);
        $('stImpact').textContent = `● ${agencies} FEDERAL SOURCES`;
        $('impactTotal').textContent = abbr(total);
        $('impactPill').style.visibility = 'visible';
    }

    renderInspector(n) {
        const insp = $('inspector');
        insp.innerHTML = '';
        if (!n || !this.lastGraph) { insp.appendChild(el('div', 'insp-empty', 'Select a node to inspect an organization.')); return; }

        const byId = new Map(this.lastGraph.charities.map(c => [c.filer_ein, c]));
        const nameOf = id => (byId.get(id)?.filer_name || id).replace(/^🏛\s*/, '');
        const isAgency = n.id.startsWith('A:');
        const role = n.id === this.focusId ? 'Focus Organization' : isAgency ? 'Federal Agency' : 'Recipient';

        const inbound = this.lastGraph.grants.filter(g => g.grant_ein === n.id);
        const outbound = this.lastGraph.grants.filter(g => g.filer_ein === n.id);
        const inTotal = inbound.reduce((s, g) => s + g.grant_amt, 0);
        const outTotal = outbound.reduce((s, g) => s + g.grant_amt, 0);

        // header
        const head = el('div', 'insp-head');
        head.appendChild(el('span', 'role-chip', role));
        head.appendChild(el('h2', 'insp-name', trunc(n.name, 60)));
        head.appendChild(el('div', 'insp-sub', isAgency ? 'Federal awarding agency' : 'Federal grant recipient'));
        insp.appendChild(head);

        // taxpayer note (federal source)
        if (isAgency) {
            const a = el('div', 'alert-box');
            a.innerHTML = `<div class="ah"><span class="sq"></span><span class="t">Taxpayer source</span></div>
                <div class="body">Federal agency — every dollar shown flowing out is taxpayer money. ${abbr(outTotal)} awarded across ${outbound.length} grants in view.</div>`;
            insp.appendChild(a);
        }

        // stats
        const stats = el('div', 'stats');
        const stat = (k, field, v) => `<div class="stat"><span class="k">${k}${field ? ` <span class="field">${field}</span>` : ''}</span><span class="v">${v}</span></div>`;
        stats.innerHTML =
            stat('Grants received (in view)', '', inTotal ? abbr(inTotal) : '—') +
            stat('Grants awarded (in view)', '', outTotal ? abbr(outTotal) : '—') +
            stat('Connections', '', String(inbound.length + outbound.length));
        insp.appendChild(stats);

        // grants in / out
        const group = (title, rows) => {
            if (!rows.length) return;
            const g = el('div', 'flow-group');
            g.appendChild(el('div', 'gh', `<span class="t">${title}</span>`));
            for (const r of rows.sort((a, b) => b.grant_amt - a.grant_amt).slice(0, 8)) {
                const otherId = title === 'Grants In' ? r.filer_ein : r.grant_ein;
                const row = el('div', 'flow-row');
                const dotColor = otherId.startsWith('A:') ? (this.theme === 'dark' ? '#C98A6E' : '#7A3320') : (this.theme === 'dark' ? '#6E6450' : '#C9BfA6');
                const name = el('span', 'n', `<span class="dot" style="background:${dotColor}"></span>${trunc(nameOf(otherId), 30)}`);
                name.addEventListener('click', () => this.graph.select(otherId));
                row.appendChild(name);
                row.appendChild(el('span', 'a', abbr(r.grant_amt)));
                g.appendChild(row);
            }
            insp.appendChild(g);
        };
        group('Grants In', inbound);
        group('Grants Out', outbound);

        // action
        const act = el('div', 'insp-actions');
        const url = isAgency
            ? 'https://www.usaspending.gov/agency'
            : 'https://www.usaspending.gov/search/?hash=' + encodeURIComponent(n.name);
        act.innerHTML = `<a class="btn-ghost" href="${url}" target="_blank" rel="noopener">View on USAspending ↗</a>`;
        insp.appendChild(act);
    }
}

function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); }

window.addEventListener('DOMContentLoaded', () => {
    if (!window.d3) { console.error('D3 not loaded'); return; }
    new LiveApp().init();
});
