// Selection-fidelity e2e: the org you pick from the dropdown must be the org
// that renders — never a silently-substituted sibling. Regression test for the
// resolveRoot auto-substitution bug.
//
//   BASE_URL=http://localhost:8000 node tests/selection.e2e.mjs

import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'https://grants.noprofits.org').replace(/\/$/, '');
const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

async function pick(page, query, optionText) {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.fill('#orgFilter', query);
    await page.waitForFunction(() => document.querySelectorAll('#matchList li').length > 0, { timeout: 8000 });
    // click the exact dropdown item by text
    const li = page.locator('#matchList li', { hasText: optionText }).first();
    await li.click();
    await page.click('#goBtn');
}

// 1. Pick the variant that HAS grant data → it must render as focus.
{
    const page = await browser.newPage();
    await pick(page, 'american red cross', 'AMERICAN NATIONAL RED CROSS');
    let rendered = false;
    try {
        await page.waitForFunction(() => document.querySelectorAll('#network .gnode').length > 0, { timeout: 25000 });
        rendered = true;
    } catch {}
    const focus = await page.$eval('#focusChip', e => e.textContent).catch(() => '');
    const inputVal = await page.$eval('#orgFilter', e => e.value).catch(() => '');
    check('picked org with data renders that exact org',
        rendered && focus === 'AMERICAN NATIONAL RED CROSS' && inputVal === 'AMERICAN NATIONAL RED CROSS',
        `focus="${focus}" input="${inputVal}" rendered=${rendered}`);
    await page.close();
}

// 2. Pick a variant with NO grant data → must NOT substitute a different org;
//    show a message and render nothing.
{
    const page = await browser.newPage();
    await pick(page, 'american red cross', 'AMERICAN RED CROSS, THE');
    await page.waitForTimeout(6000); // let resolveRoot finish (it checks for edges)
    const nodes = await page.$$eval('#network .gnode', n => n.length).catch(() => 0);
    const inspText = (await page.$eval('#inspector', e => e.textContent).catch(() => '')).replace(/\s+/g, ' ');
    const focus = await page.$eval('#focusChip', e => e.textContent).catch(() => '');
    check('picked org without data does NOT substitute a sibling',
        nodes === 0 && /no federal grant awards/i.test(inspText) && focus !== 'AMERICAN NATIONAL RED CROSS',
        `nodes=${nodes} focus="${focus}" msg="${inspText.slice(0, 80)}"`);
    await page.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
