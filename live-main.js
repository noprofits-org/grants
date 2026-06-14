import { USASpendingDataManager } from './usaspending.js';
import { NetworkVisualization } from './network.js';

const $ = id => document.getElementById(id);

class LiveApp {
    constructor() {
        this.data = new USASpendingDataManager();
        this.viz = null;
        this.root = null;        // { id, name, kind }
        this.lastData = null;
        this.searchTimer = null;
    }

    initialize() {
        const svg = d3.select('#network');
        this.viz = new NetworkVisualization(svg, window.innerWidth, window.innerHeight);
        this.showWelcome();

        $('orgFilter').addEventListener('input', e => this.onSearch(e.target.value));
        $('matchingOrgs').addEventListener('change', e => {
            const opt = e.target.selectedOptions[0];
            if (opt) {
                this.root = { id: opt.value, name: opt.dataset.name, kind: 'recipient' };
                $('orgFilter').value = opt.dataset.name;
            }
        });
        $('goBtn').addEventListener('click', () => this.render());
        $('colorScheme').addEventListener('change', () => {
            if (this.lastData) this.viz.update(this.lastData, this.lastData.charities, $('colorScheme').value);
        });
        window.addEventListener('resize', () => this.viz.resize(window.innerWidth, window.innerHeight));
    }

    onSearch(text) {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(async () => {
            const matches = await this.data.searchRecipients(text);
            const sel = $('matchingOrgs');
            sel.innerHTML = '';
            for (const m of matches) {
                const o = document.createElement('option');
                o.value = m.id; o.textContent = m.name; o.dataset.name = m.name;
                sel.appendChild(o);
            }
            if (matches.length && !this.root) {
                this.root = matches[0];
            }
        }, 300);
    }

    filters() {
        const years = Array.from($('yearCheckboxes').querySelectorAll('input:checked')).map(c => +c.value);
        return {
            depth: +$('depth').value,
            maxOrgs: +$('maxOrgs').value,
            years: years.length ? years : [2024, 2025],
            perAgencyFanout: 8
        };
    }

    async render() {
        if (!this.root) { this.flash('Type an organization name and pick a match first.'); return; }
        this.loading(true, `Fetching live federal awards for ${this.root.name}…`);
        try {
            const data = await this.data.buildGraph(this.root, this.filters());
            this.lastData = data;
            if (!data.grants.length) {
                this.loading(false);
                this.flash('No federal awards found for that organization / year range.');
                return;
            }
            this.viz.update(data, data.charities, $('colorScheme').value);
            this.stats(data.stats);
            this.loading(false);
        } catch (e) {
            console.error(e);
            this.loading(false);
            this.flash('Live fetch failed: ' + e.message);
        }
    }

    stats(s) {
        $('stats').innerHTML = `
            <strong>${s.orgCount}</strong> entities ·
            <strong>${s.grantCount}</strong> flows<br>
            Total: <strong>${fmt(s.totalAmount)}</strong><br>
            Avg flow: ${fmt(s.averageAmount)}`;
    }

    loading(on, msg) {
        const o = $('loadingOverlay');
        if (msg) o.querySelector('.loading-text').textContent = msg;
        o.classList.toggle('active', on);
    }

    flash(msg) {
        const s = $('stats');
        s.innerHTML = `<span style="color:#fbbf24">${msg}</span>`;
    }

    showWelcome() {
        const svg = d3.select('#network');
        svg.selectAll('*').remove();
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const g = svg.append('g');
        g.append('text').attr('x', cx).attr('y', cy - 40).attr('text-anchor', 'middle')
            .attr('fill', 'white').attr('font-size', '30px').attr('font-weight', 'bold')
            .text('Federal Money Flow — Live');
        g.append('text').attr('x', cx).attr('y', cy).attr('text-anchor', 'middle')
            .attr('fill', '#94a3b8').attr('font-size', '17px')
            .text('Live data from USAspending.gov — agencies → recipients');
        g.append('text').attr('x', cx).attr('y', cy + 40).attr('text-anchor', 'middle')
            .attr('fill', 'white').attr('font-size', '15px')
            .text('Search an organization (e.g. "American Red Cross"), pick a match, press Visualize');
    }
}

function fmt(n) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, notation: 'compact' }).format(n || 0);
}

window.addEventListener('DOMContentLoaded', () => {
    if (!window.d3) { console.error('D3 not loaded'); return; }
    // Populate fiscal-year checkboxes (last 4 FYs).
    const yc = document.getElementById('yearCheckboxes');
    const now = 2025;
    for (let y = now; y > now - 4; y--) {
        const id = 'fy' + y;
        const wrap = document.createElement('label');
        wrap.style.marginRight = '8px';
        wrap.innerHTML = `<input type="checkbox" id="${id}" value="${y}" ${y >= now - 1 ? 'checked' : ''}> FY${y}`;
        yc.appendChild(wrap);
    }
    new LiveApp().initialize();
});
