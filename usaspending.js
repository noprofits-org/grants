// usaspending.js
// Live data adapter for the flow-graph engine.
//
// The visualization engine (flow-graph.js) is data-shape agnostic: it renders
// any directed, weighted, entity->entity flow graph. This adapter pulls that
// graph LIVE from USAspending.gov (federal grants + contracts, no API key) and
// emits the { grants, charities, connected } shape flow-graph.js consumes.
//
// Node id scheme:
//   agency    -> "A:<Awarding Sub Agency>"  (the real funder: NIH, HRSA, CMS…,
//                falling back to the top-tier department when no sub-agency)
//   recipient -> "R:<Recipient Name>"
// Money flows agency -> recipient, so an edge is { filer_ein: agencyId, grant_ein: recipientId }.
// Agency nodes carry the USAspending tier ('subtier'|'toptier') so they expand
// against the correct agencies-filter tier on the next BFS hop.

const API = 'https://api.usaspending.gov';

// USAspending splits award types into groups (grants, loans, contracts, ...)
// and ONE spending_by_award query may only use codes from a single group, else
// it 422s. The "grants" group is exactly these four — the natural identity for
// this app. (Block Grant, Formula Grant, Project Grant, Cooperative Agreement.)
const AWARD_TYPE_CODES = ['02', '03', '04', '05'];

export class USASpendingDataManager {
    constructor() {
        this.awardCache = new Map();   // entity key -> aggregated edge rows
        this.nodeMeta = new Map();     // node id -> { name, kind, inflow, outflow }
        this.lastResult = null;
        // Defaults so the engine's year filter / charity lookups stay happy.
        this.totalGrantsCount = 0;
        this.totalCharitiesCount = 0;
    }

    // The static app preloads everything; the live app has nothing to preload.
    async loadData() { return true; }

    agencyId(name) { return 'A:' + name; }
    recipientId(name) { return 'R:' + name; }

    timePeriod(years) {
        // years: array of fiscal years (e.g. [2024, 2025]). Federal FY starts Oct 1.
        if (!years || years.length === 0) years = [2024, 2025];
        const min = Math.min(...years), max = Math.max(...years);
        return [{ start_date: `${min - 1}-10-01`, end_date: `${max}-09-30` }];
    }

    async post(path, body) {
        const res = await fetch(API + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`USAspending ${path} -> ${res.status}`);
        return res.json();
    }

    // --- search / resolve --------------------------------------------------

    async searchRecipients(text) {
        if (!text || text.length < 3) return [];
        try {
            const d = await this.post('/api/v2/autocomplete/recipient/', {
                search_text: text, limit: 6
            });
            return (d.results || [])
                .map(r => r.recipient_name)
                .filter(Boolean)
                .map(name => ({ id: this.recipientId(name), name, kind: 'recipient' }));
        } catch (e) {
            console.warn('recipient autocomplete failed', e);
            return [];
        }
    }

    // --- edge fetching (one network hop) -----------------------------------

    // A recipient's inbound awards, grouped by the funding SUB-agency (NIH,
    // HRSA, CMS…). Grouping by the top-tier "Awarding Agency" collapses every
    // HHS sub-agency into a single "HHS" inflow, which misrepresents the funding
    // picture (see #30); the sub-agency is the real funder. Awards with no
    // sub-agency fall back to the top-tier department.
    async recipientEdges(name, years) {
        const key = 'R:' + name + '|' + years.join(',');
        if (this.awardCache.has(key)) return this.awardCache.get(key);
        const d = await this.post('/api/v2/search/spending_by_award/', {
            filters: {
                recipient_search_text: [name],
                award_type_codes: AWARD_TYPE_CODES,
                time_period: this.timePeriod(years)
            },
            fields: ['Award Amount', 'Recipient Name', 'Awarding Agency', 'Awarding Sub Agency'],
            limit: 100, sort: 'Award Amount', order: 'desc'
        });
        const byAgency = new Map(); // agency name -> { amount, tier }
        for (const r of (d.results || [])) {
            const sub = r['Awarding Sub Agency'];
            const agency = sub || r['Awarding Agency'];
            const tier = sub ? 'subtier' : 'toptier';
            const amt = Number(r['Award Amount']) || 0;
            if (!agency || amt <= 0) continue;
            const cur = byAgency.get(agency) || { amount: 0, tier };
            cur.amount += amt;
            byAgency.set(agency, cur);
        }
        const edges = Array.from(byAgency, ([agency, { amount, tier }]) => ({
            source: this.agencyId(agency), sourceName: agency, sourceKind: 'agency', sourceTier: tier,
            target: this.recipientId(name), targetName: name, targetKind: 'recipient', targetTier: null,
            amount
        }));
        this.awardCache.set(key, edges);
        return edges;
    }

    // Total federal grant dollars to a recipient in a SINGLE federal fiscal
    // year. Used to normalize the taxpayer ratio: the graph sums inflow across
    // all selected years, but a 990's revenue is one year, so dividing the two
    // can exceed 100%. Restricting the numerator to the 990's fiscal year makes
    // it apples-to-apples (#28). (Federal FY ~ the 990 tax-period year; an
    // approximation, since a filer's own fiscal year may differ.)
    async recipientYearInflow(name, year) {
        const key = 'RY:' + name + '|' + year;
        if (this.awardCache.has(key)) return this.awardCache.get(key);
        const d = await this.post('/api/v2/search/spending_by_award/', {
            filters: {
                recipient_search_text: [name],
                award_type_codes: AWARD_TYPE_CODES,
                time_period: this.timePeriod([year])
            },
            fields: ['Award Amount', 'Recipient Name'],
            limit: 100, sort: 'Award Amount', order: 'desc'
        });
        let total = 0;
        for (const r of (d.results || [])) total += Number(r['Award Amount']) || 0;
        this.awardCache.set(key, total);
        return total;
    }

    // An agency's top outbound awards, grouped by recipient. `tier` must match
    // how the node was minted in recipientEdges ('subtier' for NIH/HRSA/…,
    // 'toptier' for a bare department) — querying a sub-agency name against the
    // 'toptier' filter matches nothing and silently drops the agency's fan-out.
    async agencyEdges(name, years, fanout = 8, tier = 'toptier') {
        const key = 'A:' + name + '|' + tier + '|' + years.join(',');
        if (this.awardCache.has(key)) return this.awardCache.get(key);
        const d = await this.post('/api/v2/search/spending_by_award/', {
            filters: {
                agencies: [{ type: 'awarding', tier, name }],
                award_type_codes: AWARD_TYPE_CODES,
                time_period: this.timePeriod(years)
            },
            fields: ['Award Amount', 'Recipient Name', 'Awarding Agency'],
            limit: 100, sort: 'Award Amount', order: 'desc'
        });
        const byRecipient = new Map();
        for (const r of (d.results || [])) {
            const rcp = r['Recipient Name'];
            const amt = Number(r['Award Amount']) || 0;
            if (!rcp || amt <= 0) continue;
            byRecipient.set(rcp, (byRecipient.get(rcp) || 0) + amt);
        }
        const top = Array.from(byRecipient).sort((a, b) => b[1] - a[1]).slice(0, fanout);
        const edges = top.map(([rcp, amount]) => ({
            source: this.agencyId(name), sourceName: name, sourceKind: 'agency', sourceTier: tier,
            target: this.recipientId(rcp), targetName: rcp, targetKind: 'recipient', targetTier: null,
            amount
        }));
        this.awardCache.set(key, edges);
        return edges;
    }

    // --- graph build (multi-depth BFS from a root) -------------------------

    // root: { id, name, kind }; filters: { depth, maxOrgs, years, perAgencyFanout }
    async buildGraph(root, filters) {
        const { depth = 2, maxOrgs = 14, years = [2024, 2025], perAgencyFanout = 8 } = filters;

        const connected = new Map([[root.id, 0]]);
        const meta = new Map([[root.id, { name: root.name, kind: root.kind, inflow: 0, outflow: 0 }]]);
        const edgeAgg = new Map(); // "src|tgt" -> amount

        let frontier = [{ ...root, depth: 0 }];
        const expanded = new Set();

        while (frontier.length > 0) {
            const expandable = frontier.filter(n => n.depth < depth && !expanded.has(n.id));
            if (expandable.length === 0) break;

            const batches = await Promise.all(expandable.map(async node => {
                expanded.add(node.id);
                try {
                    return node.kind === 'recipient'
                        ? await this.recipientEdges(node.name, years)
                        : await this.agencyEdges(node.name, years, perAgencyFanout, node.tier || 'toptier');
                } catch (e) {
                    console.warn('expand failed for', node.id, e);
                    return [];
                }
            }));

            const next = [];
            for (let i = 0; i < expandable.length; i++) {
                const node = expandable[i];
                for (const e of batches[i]) {
                    // Register both endpoints. `tier` rides along on agency nodes
                    // so they expand against the right agencies-filter tier later.
                    for (const [id, name, kind, tier] of [
                        [e.source, e.sourceName, e.sourceKind, e.sourceTier],
                        [e.target, e.targetName, e.targetKind, e.targetTier]
                    ]) {
                        if (!meta.has(id)) meta.set(id, { name, kind, tier, inflow: 0, outflow: 0 });
                        if (!connected.has(id)) {
                            connected.set(id, node.depth + 1);
                            next.push({ id, name, kind, tier, depth: node.depth + 1 });
                        }
                    }
                    const k = e.source + '|' + e.target;
                    edgeAgg.set(k, (edgeAgg.get(k) || 0) + e.amount);
                }
            }
            frontier = next;
        }

        // Tally flows for node sizing / coloring.
        for (const [k, amount] of edgeAgg) {
            const [src, tgt] = k.split('|');
            if (meta.has(src)) meta.get(src).outflow += amount;
            if (meta.has(tgt)) meta.get(tgt).inflow += amount;
        }

        // Trim to maxOrgs by total volume, always keeping the root.
        let keep = new Set(meta.keys());
        if (keep.size > maxOrgs) {
            const ranked = Array.from(meta.entries())
                .filter(([id]) => id !== root.id)
                .sort((a, b) => (b[1].inflow + b[1].outflow) - (a[1].inflow + a[1].outflow))
                .slice(0, Math.max(0, maxOrgs - 1))
                .map(([id]) => id);
            keep = new Set([root.id, ...ranked]);
        }

        // Emit the engine's shape.
        const grants = [];
        for (const [k, amount] of edgeAgg) {
            const [src, tgt] = k.split('|');
            if (keep.has(src) && keep.has(tgt)) {
                grants.push({ filer_ein: src, grant_ein: tgt, grant_amt: amount, tax_year: Math.max(...years) });
            }
        }
        const charities = [];
        const connectedTrim = new Map();
        for (const id of keep) {
            const m = meta.get(id);
            connectedTrim.set(id, connected.get(id));
            charities.push({
                filer_ein: id,
                filer_name: (m.kind === 'agency' ? '🏛 ' : '') + m.name,
                receipt_amt: Math.max(m.inflow, m.outflow),   // revenue color scheme
                govt_amt: m.kind === 'recipient' ? m.inflow : 0, // govt% scheme: recipients are 100% federal
                contrib_amt: 0,
                grant_amt: m.outflow                          // total-grants color scheme
            });
        }

        const total = grants.reduce((s, g) => s + g.grant_amt, 0);
        this.lastResult = {
            grants, charities, connected: connectedTrim,
            stats: {
                orgCount: keep.size,
                grantCount: grants.length,
                totalAmount: total,
                averageAmount: grants.length ? total / grants.length : 0,
                totalGrants: grants.length
            }
        };
        return this.lastResult;
    }
}
