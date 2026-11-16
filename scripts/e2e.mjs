// End-to-end smoke test: opens the app in headless Chromium and clicks through every feature.
// Usage: node scripts/e2e.mjs [url]   (default: the live GitHub Pages site)
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const url =
  process.argv[2] ?? process.env.FRAMEFORGE_URL ?? 'https://wrucebayne29.github.io/frameforge/';
const tmp = mkdtempSync(join(tmpdir(), 'frameforge-e2e-'));
const results = [];
const errors = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const status = () => page.locator('.statusbar').innerText();
const canvas = page.locator('.canvas');
const box = async () => (await canvas.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
/** Page coordinates of the k-th node (in creation order). */
async function nodeAt(k) {
  const b = await box();
  const c = page.locator('.node circle').nth(k);
  return {
    x: b.x + Number(await c.getAttribute('cx')),
    y: b.y + Number(await c.getAttribute('cy')),
  };
}
const clickNode = async (k) => {
  const p = await nodeAt(k);
  await page.mouse.click(p.x, p.y);
};
const midpoint = async (i, j) => {
  const a = await nodeAt(i);
  const c = await nodeAt(j);
  return { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
};

try {
  // ---- 1. Load ----
  await page.goto(url, { waitUntil: 'networkidle' });
  check('page loads with the right title', (await page.title()).includes('FrameForge'));
  await page.waitForSelector('.canvas svg .member');
  check('default example renders members', (await page.locator('.member').count()) >= 3);
  check('results are shown on load', /DOF/.test(await status()), await status());
  check('bending moment diagram is drawn', (await page.locator('.diagram-M').count()) > 0);
  check('deflected shape is drawn', (await page.locator('.deformed').count()) > 0);
  check('reactions are drawn', (await page.locator('.reaction').count()) > 0);

  // ---- 2. Examples ----
  const options = await page
    .locator('.example-picker option')
    .evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
  check('example library has 6+ structures', options.length >= 6, `${options.length} examples`);
  for (const id of options) {
    await page.selectOption('.example-picker', id);
    await page.waitForTimeout(150);
    const ok = /DOF/.test(await status()) && (await page.locator('.error-banner').count()) === 0;
    check(`example "${id}" solves`, ok);
  }
  check('transmission tower is included', options.includes('transmission-tower'));

  // ---- 3. Results view ----
  await page.selectOption('.example-picker', 'portal-frame');
  for (const [label, cls] of [
    ['Axial', '.diagram-N'],
    ['Shear', '.diagram-V'],
    ['Moment', '.diagram-M'],
  ]) {
    await page.locator('.viewbar .segmented button', { hasText: label }).click();
    check(`${label} diagram shows`, (await page.locator(cls).count()) > 0);
  }
  await page.locator('.viewbar .segmented button', { hasText: 'None' }).click();
  check('diagrams can be hidden', (await page.locator('.diagram').count()) === 0);
  await page.locator('.viewbar .segmented button', { hasText: 'Moment' }).click();

  const before = await page.locator('.deformed').first().getAttribute('points');
  await page.locator('input[aria-label="Deformation scale"]').fill('3');
  const after = await page.locator('.deformed').first().getAttribute('points');
  check('deformation scale slider changes the deflected shape', before !== after);

  await page.locator('.viewbar .chip', { hasText: 'Utilisation' }).click();
  check('utilisation labels appear', (await page.locator('.util-label').count()) > 0);
  const stroke = await page
    .locator('.member line')
    .first()
    .evaluate((el) => el.style.stroke);
  check('members are coloured by utilisation', stroke.startsWith('rgb'), stroke);
  await page.locator('.viewbar .chip', { hasText: 'Utilisation' }).click();

  // Hover tooltip on the beam (midpoint between its two end nodes).
  const beam = await page.locator('.member line').nth(1).boundingBox();
  await page.mouse.move(beam.x + beam.width / 2, beam.y + beam.height / 2);
  await page.waitForSelector('.tooltip');
  const tip = await page.locator('.tooltip').innerText();
  check(
    'hover tooltip shows member forces',
    /M = .*kN·m/.test(tip) && /N = /.test(tip),
    tip.replace(/\n/g, ' | '),
  );

  // ---- 4. Panels ----
  await page.locator('.tabs button', { hasText: 'Results' }).click();
  check(
    'results tab lists reactions',
    (await page.locator('.panel-body table').first().innerText()).includes('Rx'),
  );
  await page.locator('.tabs button', { hasText: 'Design' }).click();
  check(
    'design tab shows IS 800 table',
    (await page.locator('.panel-body').innerText()).includes('IS 800:2007'),
  );
  await page.locator('.panel-body table tbody tr').first().click();
  await page.locator('.tabs button', { hasText: 'Properties' }).click();
  check(
    'clicking a design row selects the member',
    (await page.locator('.panel-body h3').innerText()).startsWith('Member'),
  );
  check(
    'member properties show check breakdown',
    (await page.locator('.panel-body').innerText()).includes('Capacity'),
  );

  // Advanced: natural frequencies with an animated mode shape, and influence lines.
  await page.locator('.tabs button', { hasText: 'Advanced' }).click();
  await page.locator('.panel-body button', { hasText: 'Compute natural frequencies' }).click();
  await page.waitForSelector('.mode-shape');
  const modeRows = await page.locator('.panel-body table tbody tr').count();
  check('modal analysis lists natural frequencies', modeRows >= 3, `${modeRows} modes`);
  const f1 = Number(
    await page.locator('.panel-body table tbody tr').first().locator('td').nth(1).innerText(),
  );
  check('fundamental frequency is plausible', f1 > 1 && f1 < 100, `${f1} Hz`);
  const frameA = await page.locator('.mode-shape').first().getAttribute('points');
  await page.waitForTimeout(250);
  const frameB = await page.locator('.mode-shape').first().getAttribute('points');
  check('mode shape is animated', frameA !== frameB);
  await page.locator('.panel-body button', { hasText: 'Show influence line' }).click();
  await page.waitForSelector('.influence-line');
  check('influence line is drawn', (await page.locator('.influence-line').count()) > 0);
  check('influence line hides the normal diagrams', (await page.locator('.diagram').count()) === 0);
  await page.locator('.panel-body button', { hasText: 'Clear' }).click();
  check(
    'clearing the influence line restores the diagrams',
    (await page.locator('.diagram').count()) > 0,
  );

  // Edit by table: move node N3 and check the model re-solves.
  await page.locator('.tabs button', { hasText: 'Tables' }).click();
  const statusBefore = await status();
  const xField = page.locator('.panel-body table tbody tr').nth(2).locator('input[aria-label="X"]');
  await xField.fill('10');
  await xField.press('Enter');
  await page.waitForTimeout(100);
  check('editing a table cell re-solves the model', (await status()) !== statusBefore);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  check('undo restores the previous model', (await status()) === statusBefore);
  await page.keyboard.press('Control+Shift+z');
  check('redo re-applies the edit', (await status()) !== statusBefore);
  await page.keyboard.press('Control+z');

  // ---- 5. Draw a structure from scratch ----
  await page.locator('.file-actions button', { hasText: 'New' }).click();
  check('new model is empty', (await page.locator('.empty-hint').count()) === 1);
  const b = await box();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.keyboard.press('m');
  await page.mouse.click(cx - 200, cy + 100);
  await page.mouse.click(cx - 200, cy - 100);
  await page.mouse.click(cx + 200, cy - 100);
  await page.mouse.click(cx + 200, cy + 100);
  await page.keyboard.press('Escape');
  check('member tool draws three members', (await page.locator('.member').count()) === 3);
  const xs = await page.evaluate(() =>
    [...document.querySelectorAll('.node circle')].map((c) => Number(c.getAttribute('cx'))),
  );
  check(
    'nodes snap to the grid (columns are vertical)',
    Math.abs(xs[0] - xs[1]) < 0.01 && Math.abs(xs[2] - xs[3]) < 0.01,
  );
  check(
    'unsupported structure reports a clear error',
    (await page.locator('.error-banner').innerText()).includes('no supports'),
  );

  await page.keyboard.press('s');
  await page.locator('.tool-options select').first().selectOption('fixed');
  await clickNode(0);
  await clickNode(3);
  check('support tool adds supports', (await page.locator('.support').count()) === 2);
  check('structure solves once supported', (await page.locator('.error-banner').count()) === 0);

  await page.keyboard.press('l');
  await page.locator('.tool-options select').first().selectOption('udl');
  const beamMid = await midpoint(1, 2);
  await page.mouse.click(beamMid.x, beamMid.y);
  await page.locator('.tool-options select').first().selectOption('nodal');
  await clickNode(1);
  check('load tool adds a UDL and a nodal load', (await page.locator('.load').count()) === 2);
  check('new structure has results', /max deflection/.test(await status()), await status());

  await page.keyboard.press('n');
  await page.mouse.click(beamMid.x, beamMid.y);
  check('node tool splits a member', (await page.locator('.member').count()) === 4);
  check('splitting keeps the UDL on both halves', (await page.locator('.load').count()) === 3);

  // Drag a node with the select tool.
  await page.keyboard.press('v');
  const s1 = await status();
  const mid = await nodeAt(4);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y - 70, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  check('dragging a node changes the results', (await status()) !== s1);

  // Delete tool + release creating a mechanism.
  await page.keyboard.press('x');
  const column = await midpoint(2, 3);
  await page.mouse.click(column.x, column.y);
  check('delete tool removes a member', (await page.locator('.member').count()) === 3);
  await page.keyboard.press('Control+z');
  check('undo brings it back', (await page.locator('.member').count()) === 4);

  // ---- 6. Save / open / share / PDF ----
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.file-actions button', { hasText: 'Save' }).click(),
  ]);
  const jsonPath = join(tmp, 'model.json');
  await jsonDownload.saveAs(jsonPath);
  const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
  check(
    'JSON save downloads the model',
    saved.format === 'frameforge-project' && saved.members.length === 4,
  );

  await page.selectOption('.example-picker', 'pratt-truss');
  await page.setInputFiles('input[type="file"]', jsonPath);
  await page.waitForTimeout(200);
  check('JSON open restores the model', (await page.locator('.member').count()) === 4);

  const badPath = join(tmp, 'bad.json');
  writeFileSync(badPath, '{"nodes": "oops"}');
  await page.setInputFiles('input[type="file"]', badPath);
  await page.waitForSelector('.toast.error');
  check(
    'invalid files are rejected with a message',
    (await page.locator('.toast.error').innerText()).includes('must be a list'),
  );

  await page.locator('.file-actions button', { hasText: 'Share' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#m='));
  const shared = page.url();
  check('share puts the model in the URL', shared.includes('#m=1.'), `${shared.length} characters`);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check('share copies the link to the clipboard', clip === shared);

  const page2 = await context.newPage();
  page2.on('pageerror', (e) => errors.push(String(e)));
  await page2.goto(shared, { waitUntil: 'networkidle' });
  await page2.waitForSelector('.member');
  await page2.waitForTimeout(300);
  check('opening a share link restores the model', (await page2.locator('.member').count()) === 4);
  await page2.close();

  await page.selectOption('.example-picker', 'transmission-tower');
  const [pdfDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.file-actions button', { hasText: 'PDF report' }).click(),
  ]);
  const pdfPath = join(tmp, 'report.pdf');
  await pdfDownload.saveAs(pdfPath);
  const pdf = readFileSync(pdfPath);
  check(
    'PDF report downloads',
    pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 20000,
    `${pdf.length} bytes`,
  );
  check(
    'PDF file is named after the model',
    pdfDownload.suggestedFilename() === 'transmission-tower-report.pdf',
  );

  // ---- 7. Polish ----
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.locator('.topbar button', { hasText: /^(Light|Dark)$/ }).click();
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  check(
    'theme toggles between dark and light',
    themeBefore !== themeAfter,
    `${themeBefore} -> ${themeAfter}`,
  );

  await page.keyboard.press('?');
  check(
    'help dialog opens with shortcuts',
    (await page.locator('.modal').innerText()).includes('Keyboard shortcuts'.toUpperCase()) ||
      (await page.locator('.modal').innerText()).includes('Keyboard shortcuts'),
  );
  await page.locator('.modal button', { hasText: 'Take the tour' }).click();
  check('onboarding tour starts', (await page.locator('.tour-card').innerText()).includes('1 / 6'));
  for (let k = 0; k < 5; k++) await page.locator('.tour-card button.primary').click();
  check(
    'tour reaches the last step',
    (await page.locator('.tour-card').innerText()).includes('6 / 6'),
  );
  await page.locator('.tour-card button.primary').click();
  check('tour closes', (await page.locator('.tour').count()) === 0);

  await page.keyboard.press('1');
  check(
    'keyboard shortcut 1 shows the axial diagram',
    (await page.locator('.diagram-N').count()) > 0,
  );
  await page.keyboard.press('f');

  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check('mobile layout has no horizontal page scroll', !overflow);
  check(
    'canvas is still visible on mobile',
    (await box()).height > 150,
    `${Math.round((await box()).height)} px tall`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.member');
  check(
    'the last model is restored after a reload',
    (await page.locator('.project-name').innerText()).length > 0,
  );
} catch (e) {
  check('script ran to completion', false, String(e));
}

check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed on ${url}`);
process.exit(failed.length === 0 ? 0 : 1);
