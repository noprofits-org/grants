// propublica.js
// Enriches recipient orgs with IRS-990 data (total revenue, contributions,
// 990 PDF, location) from the ProPublica Nonprofit Explorer API.
//
// ProPublica sends no CORS headers, so every call goes through the org's shared
// Vercel CORS proxy (also used by the search site). All calls are best-effort:
// agencies and government entities aren't nonprofits and simply return null,
// and any network/parse failure resolves to null so the graph never breaks.

const PROXY = 'https://cors-proxy-xi-ten.vercel.app/api/proxy';
const BASE = 'https://projects.propublica.org/nonprofits/api/v2';

export class ProPublica {
    constructor() {
        this.einCache = new Map();   // name -> {ein,name} | null
        this.orgCache = new Map();   // ein  -> profile | null
    }

    async proxied(target) {
        const res = await fetch(`${PROXY}?url=${encodeURIComponent(target)}`);
        if (!res.ok) throw new Error('proxy ' + res.status);
        return res.json();
    }

    // Resolve an org name to its best EIN match (or null). Guards against loose
    // matches: a result is only accepted if its name is similar enough to the
    // query, so a government recipient never picks up an unrelated nonprofit's
    // 990 (which would be misinformation in a taxpayer-impact tool).
    async resolveEin(name) {
        const key = name.toLowerCase();
        if (this.einCache.has(key)) return this.einCache.get(key);
        let result = null;
        try {
            const d = await this.proxied(`${BASE}/search.json?q=${encodeURIComponent(name)}`);
            for (const o of (d.organizations || []).slice(0, 5)) {
                if (o.ein && similar(name, o.name)) { result = { ein: String(o.ein), name: o.name }; break; }
            }
        } catch (e) {
            console.warn('propublica search failed', name, e);
        }
        this.einCache.set(key, result);
        return result;
    }

    // Fetch the latest filing's financials for an EIN (or null).
    async org(ein) {
        if (this.orgCache.has(ein)) return this.orgCache.get(ein);
        let profile = null;
        try {
            const d = await this.proxied(`${BASE}/organizations/${ein}.json`);
            const o = d.organization || {};
            const f = (d.filings_with_data || [])[0];
            profile = {
                ein: String(o.ein || ein),
                name: o.name,
                city: o.city, state: o.state,
                revenue: f ? num(f.totrevenue) : null,
                contributions: f ? num(f.totcntrbgfts) : null,
                expenses: f ? num(f.totfuncexpns) : null,
                year: f ? f.tax_prd_yr : null,
                pdfUrl: f ? f.pdf_url : null,
            };
        } catch (e) {
            console.warn('propublica org failed', ein, e);
        }
        this.orgCache.set(ein, profile);
        return profile;
    }

    // Convenience: name -> full profile (or null).
    async enrich(name) {
        const hit = await this.resolveEin(name);
        if (!hit) return null;
        const profile = await this.org(hit.ein);
        // Guard against a fuzzy mismatch returning a profile with no financials.
        if (!profile || profile.revenue == null) return profile;
        return profile;
    }
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

const STOP = new Set(['the', 'of', 'and', 'inc', 'incorporated', 'a', 'for', 'department', 'dept', 'co', 'company', 'foundation', 'fund']);
function toks(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t));
}
// Accept a match when ≥60% of the smaller token set overlaps.
function similar(a, b) {
    const A = new Set(toks(a)), B = new Set(toks(b));
    if (!A.size || !B.size) return false;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / Math.min(A.size, B.size) >= 0.6;
}
