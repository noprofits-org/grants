import { USASpendingDataManager } from './usaspending.js';
import { FlowGraph, abbr } from './flow-graph.js';
import { ProPublica } from './propublica.js';

const TAXPAYER_THRESHOLD = 0.05;   // federal grants / total revenue → rust ring + alert

const $ = id => document.getElementById(id);
// el() sets TEXT — safe for API-sourced strings (org names). elHTML() is for the
// few spots that need literal markup interpolating only already-safe values
// (numbers from abbr(), fixed labels) — never raw name fields.
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const elHTML = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

class LiveApp {
    constructor() {
        this.data = new USASpendingDataManager();
        this.pp = new ProPublica();
        this.graph = null;        // FlowGraph
        this.matches = [];
        this.picked = null;
        this.lastGraph = null;    // {grants, charities, connected}
        this.focusId = null;
        this.profiles = new Map();// nodeId -> 990 profile | null (fetched) | undefined (not yet)
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

    // Returns { root, picked }. An explicit dropdown pick is HONORED EXACTLY —
    // never substituted for a sibling — so the org you select is the org that
    // renders. Only the type-and-Visualize path (no pick) auto-resolves to the
    // first candidate that actually has grant data.
    async resolveRoot(text, years) {
        if (this.picked) {
            const edges = await this.data.recipientEdges(this.picked.name, years);
            return { root: edges.length ? this.picked : null, picked: this.picked };
        }
        const tried = new Set();
        const candidates = [...this.matches];
        if (!candidates.length) candidates.push(...await this.data.searchRecipients(text));
        for (const c of candidates) {
            if (tried.has(c.id)) continue;
            tried.add(c.id);
            const edges = await this.data.recipientEdges(c.name, years);
            if (edges.length) return { root: c, picked: null };
        }
        return { root: null, picked: null };
    }

    async render() {
        const text = $('orgFilter').value.trim();
        if (!text) return;
        const filters = this.filters();
        $('matchList').hidden = true;
        $('goBtn').disabled = true;
        $('goBtn').textContent = 'Loading…';
        try {
            const { root, picked } = await this.resolveRoot(text, filters.years);
            if (!root) {
                this.fail(picked
                    ? `“${picked.name}” has no federal grant awards in the selected years. Pick another match or add fiscal years.`
                    : `No federal grant awards for any “${text}” match.`);
                return;
            }
            $('orgFilter').value = root.name;
            const data = await this.data.buildGraph(root, filters);
            this.lastGraph = data;
            this.focusId = root.id;

            $('canvasHint').style.display = 'none';
            const mode = $('layoutSeg').querySelector('.on').dataset.mode;
            this.graph.layoutMode = mode;
            this.graph.render(data, root.id);
            this.updateChrome(data, root);
            this.profiles = new Map();
            this.enrichAll(data);   // background: 990 data → rings + inspector

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
        const div = el('div', 'insp-empty');
        div.style.color = 'var(--alert)';
        div.textContent = msg;
        insp.appendChild(div);
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

    // Federal grant dollars this node receives within the current view.
    federalInflow(id) {
        return this.lastGraph.grants.filter(g => g.grant_ein === id).reduce((s, g) => s + g.grant_amt, 0);
    }

    // Fetch 990 data for one recipient node (cached). Agencies are skipped.
    async enrichOne(id, name) {
        if (this.profiles.has(id)) return this.profiles.get(id);
        if (id.startsWith('A:')) { this.profiles.set(id, null); return null; }
        let profile = null;
        try { profile = await this.pp.enrich(name); } catch { /* best-effort */ }
        this.profiles.set(id, profile || null);
        return this.profiles.get(id);
    }

    // Background pass over all recipient nodes → light up taxpayer rings.
    async enrichAll(data) {
        const recipients = data.charities.filter(c => c.filer_ein.startsWith('R:'));
        await Promise.all(recipients.map(c => this.enrichOne(c.filer_ein, c.filer_name.replace(/^🏛\s*/, ''))));
        if (this.lastGraph !== data) return;   // a newer query superseded this one
        const flagged = new Set();
        for (const c of recipients) {
            const p = this.profiles.get(c.filer_ein);
            if (p && p.revenue) {
                const share = this.federalInflow(c.filer_ein) / p.revenue;
                if (share > TAXPAYER_THRESHOLD) flagged.add(c.filer_ein);
            }
        }
        this.graph.setTaxpayerFlags(flagged);
        // refresh the inspector if the selected node just got enriched
        if (this.graph.selectedId) {
            const n = this.graph.nodes.find(x => x.id === this.graph.selectedId);
            if (n) this.renderInspector(n);
        }
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

        // 990 enrichment: undefined = not fetched, null = none on file, obj = data
        const profile = isAgency ? null : this.profiles.get(n.id);
        if (!isAgency && profile === undefined) {
            this.enrichOne(n.id, n.name).then(() => { if (this.graph.selectedId === n.id) this.renderInspector(n); });
        }
        const share = (profile && profile.revenue) ? inTotal / profile.revenue : null;

        // header
        const head = el('div', 'insp-head');
        head.appendChild(el('span', 'role-chip', role));
        head.appendChild(el('h2', 'insp-name', trunc(n.name, 60)));
        const sub = isAgency ? 'Federal awarding agency'
            : (profile && profile.ein) ? `EIN ${profile.ein}${profile.city ? ` · ${profile.city}, ${profile.state}` : ''}`
            : 'Federal grant recipient';
        head.appendChild(el('div', 'insp-sub', sub));
        // Flag when the attached 990 belongs to a differently-named org, so a
        // chapter/parent mismatch is human-verifiable rather than silent (#23).
        if (!isAgency && profile && profile.name && normName(profile.name) !== normName(n.name)) {
            head.appendChild(el('div', 'insp-sub insp-match', `990 matched to “${trunc(profile.name, 48)}” — verify`));
        }
        insp.appendChild(head);

        // taxpayer alert
        if (isAgency) {
            insp.appendChild(elHTML('div', 'alert-box',
                `<div class="ah"><span class="sq"></span><span class="t">Taxpayer source</span></div>
                <div class="body">Federal agency — every dollar shown flowing out is taxpayer money. ${abbr(outTotal)} awarded across ${outbound.length} grants in view.</div>`));
        } else if (share != null && share > TAXPAYER_THRESHOLD) {
            insp.appendChild(elHTML('div', 'alert-box',
                `<div class="ah"><span class="sq"></span><span class="t">Taxpayer impact</span></div>
                <div class="body">${(share * 100).toFixed(1)}% of total revenue is federal grant money (${abbr(inTotal)} of ${abbr(profile.revenue)}).</div>`));
        }

        // stats (USAspending + IRS-990 when available)
        const stats = el('div', 'stats');
        const stat = (k, field, v) => `<div class="stat"><span class="k">${k}${field ? ` <span class="field">${field}</span>` : ''}</span><span class="v">${v}</span></div>`;
        let rows = stat('Grants received (in view)', '', inTotal ? abbr(inTotal) : '—')
            + stat('Grants awarded (in view)', '', outTotal ? abbr(outTotal) : '—');
        if (!isAgency && profile && profile.revenue != null) {
            rows += stat('Total revenue', 'IRS 990 · FY' + (profile.year || ''), abbr(profile.revenue))
                + stat('Contributions', 'totcntrbgfts', profile.contributions != null ? abbr(profile.contributions) : '—');
        }
        rows += stat('Connections', '', String(inbound.length + outbound.length));
        if (!isAgency && profile === undefined) rows += stat('IRS-990 data', '', 'loading…');
        if (!isAgency && profile === null) rows += stat('IRS-990 data', '', 'none on file');
        stats.innerHTML = rows;
        insp.appendChild(stats);

        // grants in / out
        const group = (title, rows) => {
            if (!rows.length) return;
            const g = el('div', 'flow-group');
            g.appendChild(elHTML('div', 'gh', `<span class="t">${title}</span>`));
            for (const r of rows.sort((a, b) => b.grant_amt - a.grant_amt).slice(0, 8)) {
                const otherId = title === 'Grants In' ? r.filer_ein : r.grant_ein;
                const row = el('div', 'flow-row');
                const dotColor = otherId.startsWith('A:') ? (this.theme === 'dark' ? '#C98A6E' : '#7A3320') : (this.theme === 'dark' ? '#6E6450' : '#C9BfA6');
                const name = el('span', 'n');
                const dot = el('span', 'dot');
                dot.style.background = dotColor;
                name.appendChild(dot);
                name.appendChild(document.createTextNode(trunc(nameOf(otherId), 30)));  // name via text node — no innerHTML
                name.addEventListener('click', () => this.graph.select(otherId));
                row.appendChild(name);
                row.appendChild(el('span', 'a', abbr(r.grant_amt)));
                g.appendChild(row);
            }
            insp.appendChild(g);
        };
        group('Grants In', inbound);
        group('Grants Out', outbound);

        // actions — built via DOM so external URLs never touch innerHTML
        const act = el('div', 'insp-actions');
        const mkLink = (href, label) => {
            const a = el('a', 'btn-ghost', label);
            a.href = href; a.target = '_blank'; a.rel = 'noopener';
            return a;
        };
        const usa = isAgency
            ? 'https://www.usaspending.gov/'
            : 'https://www.usaspending.gov/search/?hash=' + encodeURIComponent(n.name);
        act.appendChild(mkLink(usa, 'View on USAspending ↗'));
        if (!isAgency && profile && profile.pdfUrl && /^https:\/\//.test(profile.pdfUrl)) {
            act.appendChild(mkLink(profile.pdfUrl, 'View 990 PDF ↗'));
        }
        insp.appendChild(act);
    }
}

function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); }
// Loose name equality for "is this the same org?" — case/punctuation-insensitive.
const normName = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

window.addEventListener('DOMContentLoaded', () => {
    if (!window.d3) { console.error('D3 not loaded'); return; }
    new LiveApp().init();
});
