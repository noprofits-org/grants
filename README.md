# NoProfits Grant Flow Network

Live visualization of federal grant flows, served at **grants.noprofits.org**.

Enter a recipient (organization, agency, or program) and the tool pulls live
award data from [USAspending.gov](https://www.usaspending.gov/), renders the
money flow as a force-directed graph, and enriches the inspector + taxpayer
rings with IRS Form 990 financials from [ProPublica](https://projects.propublica.org/nonprofits/api).

## Architecture

Single page, no build step. `index.html` loads ES modules directly:

```
index.html          # site root — the live tool
├── live-main.js     # app controller: search, render, inspector, state
├── usaspending.js   # USAspending.gov client → {grants, charities, connected}
├── flow-graph.js    # D3 force-directed renderer (the visualization engine)
├── propublica.js    # IRS-990 enrichment client (taxpayer rings + inspector)
└── live.css         # ember-on-bone design system
```

`live.html` is a redirect stub kept only for the canonical `/live.html` URL.

## Data shape

`usaspending.js` emits the graph object every consumer reads:

- **grants** — edges: `{ filer_ein, grant_ein, grant_amt, tax_year }`
- **charities** — nodes: `{ filer_ein, filer_name, receipt_amt, govt_amt, ... }`
  (EIN prefixes namespace node types: `A:` agency, `R:` recipient)
- **connected** — the trimmed set of node ids in the rendered subgraph

## Dependencies

- D3.js v7 — graph rendering (loaded from CDN)
- USAspending.gov API — award data (no key required)
- ProPublica Nonprofit Explorer API — 990 financials (no key required)

## Local development

`setup.py` spins up a venv and a local static server for testing. The
end-to-end tests in `tests/` (`e2e.mjs`, `selection.e2e.mjs`) drive the live
page with Playwright; point them at a running server with
`BASE_URL=http://localhost:8000 node tests/e2e.mjs`.
