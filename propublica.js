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

    // enrichAll fires ~1-2 dozen of these concurrently per Visualize, so a
    // single hung proxy connection used to strand that node's ring 'loading'
    // forever and waste the proxy budget (#22). Cap each call with an
    // AbortController; a timeout throws like any other failure, which the
    // callers treat as a transient (best-effort null, not cached — see #24).
    async proxied(target, { timeout = 10000 } = {}) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeout);
        try {
            const res = await fetch(`${PROXY}?url=${encodeURIComponent(target)}`, { signal: ctl.signal });
            if (!res.ok) throw new Error('proxy ' + res.status);
            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('proxy timeout');
            throw e;
        } finally {
            clearTimeout(t);
        }
    }

    // Resolve an org name to its best EIN match (or null). Guards against loose
    // matches so a recipient never picks up an unrelated — or related-but-wrong
    // (chapter/parent) — nonprofit's 990, which would be misinformation in a
    // taxpayer-impact tool. See bestMatch() for the gate + ranking.
    //
    // Caching: a deterministic result (a match, or a genuine "nothing matched"
    // from a successful search) is cached. A transient failure (proxy/network
    // throw) returns null WITHOUT caching, so a later re-search retries instead
    // of being stuck on a momentary blip.
    async resolveEin(name) {
        const key = name.trim().toLowerCase();
        if (this.einCache.has(key)) return this.einCache.get(key);
        let d;
        try {
            d = await this.proxied(`${BASE}/search.json?q=${encodeURIComponent(name)}`);
        } catch (e) {
            console.warn('propublica search failed', name, e);
            return null; // transient — do not cache
        }
        const result = bestMatch(name, d.organizations || []);
        this.einCache.set(key, result);
        return result;
    }

    // Fetch the latest filing's financials for an EIN (or null). Same caching
    // rule as resolveEin: a successful fetch is cached (even when the org has no
    // filings on record), a transient failure is not.
    async org(ein) {
        if (this.orgCache.has(ein)) return this.orgCache.get(ein);
        let d;
        try {
            d = await this.proxied(`${BASE}/organizations/${ein}.json`);
        } catch (e) {
            console.warn('propublica org failed', ein, e);
            return null; // transient — do not cache
        }
        const o = d.organization || {};
        const f = (d.filings_with_data || [])[0];
        const profile = {
            ein: String(o.ein || ein),
            name: o.name,
            city: o.city, state: o.state,
            revenue: f ? num(f.totrevenue) : null,
            contributions: f ? num(f.totcntrbgfts) : null,
            expenses: f ? num(f.totfuncexpns) : null,
            year: f ? f.tax_prd_yr : null,
            pdfUrl: f ? f.pdf_url : null,
        };
        this.orgCache.set(ein, profile);
        return profile;
    }

    // Convenience: name -> full profile (or null). The profile is returned even
    // when it has no financials (revenue == null) — its EIN + matched name still
    // let the inspector show, and flag, which 990 was attached (see #23).
    async enrich(name) {
        const hit = await this.resolveEin(name);
        if (!hit) return null;
        return this.org(hit.ein);
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

// Pick the best 990 match for a query name from the search results, or null.
//
// Gate (per candidate, both STOP-stripped): keep only candidates that
//   (a) overlap ≥60% of the smaller token set, AND
//   (b) contain the query's MOST DISTINCTIVE token (longest, as a rare-token
//       proxy) — this kills cross-domain false accepts that share only a common
//       word, which the bare 60% ratio let through.
// Ranking among survivors (the old code took the first passer, so a small
// same-named chapter that outranked the real org won): prefer an exact
// token-set match, then the most shared tokens, then the FEWEST extra tokens in
// the candidate name (favours the parent org over a "…of Anytown Chapter"
// variant), then ProPublica's own relevance order. The matched name rides back
// out so the inspector can flag a name that differs from the recipient (#23).
function bestMatch(query, orgs) {
    const Q = new Set(toks(query));
    if (!Q.size) return null;
    const distinctive = [...Q].reduce((a, b) => (b.length > a.length ? b : a));

    const passers = [];
    (orgs || []).slice(0, 5).forEach((o, rank) => {
        if (!o.ein || !o.name) return;
        const C = new Set(toks(o.name));
        if (!C.size || !C.has(distinctive)) return;
        let inter = 0;
        for (const t of Q) if (C.has(t)) inter++;
        if (inter / Math.min(Q.size, C.size) < 0.6) return;
        passers.push({
            ein: String(o.ein), name: o.name, rank, inter,
            exact: C.size === Q.size && inter === Q.size,
            extras: C.size - inter,
        });
    });
    if (!passers.length) return null;

    passers.sort((a, b) =>
        (b.exact - a.exact) ||      // exact token-set match wins
        (b.inter - a.inter) ||      // most shared tokens
        (a.extras - b.extras) ||    // fewest extra tokens (parent over chapter)
        (a.rank - b.rank));         // else ProPublica's relevance order
    return { ein: passers[0].ein, name: passers[0].name };
}
