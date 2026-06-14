// End-to-end smoke test for the live (USAspending) visualization.
//
// Drives a real headless browser through the human flow — type a query, press
// Visualize, no manual pick — and asserts that real nodes render. Catches the
// class of bug that unit tests miss: hidden controls, event wiring, CORS, and
// USAspending's fuzzy recipient-name matching (where a typed query must resolve
// to the specific legal entity that actually holds grant awards).
//
// Usage:
//   npm i -D playwright && npx playwright install chromium
//   BASE_URL=https://grants.noprofits.org node tests/e2e.mjs   # against prod
//   BASE_URL=http://localhost:8000        node tests/e2e.mjs   # against a local server
//
// Exit code is non-zero if any query fails to render.

import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'https://grants.noprofits.org').replace(/\/$/, '');
const URL = `${BASE}/live.html`;

// Each is a plain query a normal person would type; none is the exact legal name.
const QUERIES = [
    'american red cross',
    'habitat for humanity',
    'stanford university',
    'salvation army',
];

const browser = await chromium.launch();
let failures = 0;

console.log(`Testing ${URL}\n`);
for (const q of QUERIES) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.fill('#orgFilter', q);
    await page.waitForTimeout(1200);          // allow debounced autocomplete to populate
    await page.click('#goBtn');               // human flow: no manual list pick

    let nodes = 0;
    try {
        await page.waitForFunction(
            () => document.querySelectorAll('#network .node').length > 0,
            { timeout: 25000 });
        nodes = await page.$$eval('#network .node', n => n.length);
    } catch { /* falls through to failure */ }

    const resolved = await page.$eval('#orgFilter', e => e.value).catch(() => '');
    const stats = (await page.$eval('#stats', e => e.textContent).catch(() => '')).replace(/\s+/g, ' ').trim();
    const ok = nodes > 0;
    if (!ok) failures++;

    console.log(`${ok ? 'PASS' : 'FAIL'}  "${q}" -> nodes=${nodes} | resolved="${resolved}"`);
    console.log(`        ${stats}`);
    if (errs.length) console.log(`        errors: ${errs.join(' ; ')}`);
    await page.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
