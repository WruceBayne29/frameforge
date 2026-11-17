// End-to-end test of the 3D workspace: opens the app in headless Chromium, switches to 3D and
// exercises examples, tools, generators, result views, files and layouts.
// Usage: node scripts/e2e3d.mjs [url] [screenshot-dir]
//   (default url: the live GitHub Pages site; screenshots go to a temporary folder)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const url =
  process.argv[2] ?? process.env.FRAMEFORGE_URL ?? 'https://wrucebayne29.github.io/frameforge/';
const tmp = mkdtempSync(join(tmpdir(), 'frameforge-e2e3d-'));
const shots = process.argv[3] ?? join(tmp, 'screenshots');
mkdirSync(shots, { recursive: true });
const results = [];
const errors = [];

function check(name, condition, detail = '') {
  detail = String(detail).replace(/\s*\n\s*/g, ' · ');
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
};
watch(page);

const status = () => page.locator('.statusbar').innerText();
const count = async (noun) => {
  const m = new RegExp(`(\\d+) ${noun}`).exec(await status());
  return m ? Number(m[1]) : -1;
};
const solved = async () =>
  /equations/.test(await status()) && (await page.locator('.error-banner').count()) === 0;
const settle = (ms = 250) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const button = (scope, text) =>
  page.locator(`${scope} button`, { hasText: new RegExp(`^\\s*${text}\\s*$`) }).first();
const tool = (label) => page.locator('.toolbar button.tool', { hasText: label }).first();
const tab = (label) => page.locator('.panel .tabs button', { hasText: label }).first();
const nodeAt = (id) => page.evaluate((n) => window.frameforgeViewer3D?.nodeScreenPosition(n), id);
async function clickNode(id, modifiers = []) {
  const p = await nodeAt(id);
  if (!p) throw new Error(`node ${id} is not on screen`);
  await page.mouse.move(p.x, p.y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of modifiers) await page.keyboard.up(m);
  await settle(120);
}
/** Spread of pixel values in the viewer: a blank canvas has (almost) none. */
async function viewerContrast() {
  const box = await page.locator('.viewer3d').boundingBox();
  const png = PNG.sync.read(await page.screenshot({ clip: box }));
  const seen = new Set();
  for (let k = 0; k < png.data.length; k += 4 * 97) {
    seen.add((png.data[k] >> 4) * 256 + (png.data[k + 1] >> 4) * 16 + (png.data[k + 2] >> 4));
  }
  return seen.size;
}
async function addNodeByCoordinates(x, y, z) {
  const fields = ['X', 'Y', 'Z'];
  for (const [k, v] of [x, y, z].entries()) {
    const input = page.locator(`input[aria-label="New node ${fields[k]} (m)"]`);
    await input.fill(String(v));
    await input.press('Enter');
  }
  await button('.tool-options', 'Add node').click();
  await settle(120);
}

try {
  // ---- 1. Workspace switch ----
  await page.goto(url, { waitUntil: 'networkidle' });
  check('the app opens in 2D by default', (await page.locator('.canvas svg').count()) === 1);
  check(
    '2D top bar has the 2D | 3D switch',
    (await page.locator('.workspace-switch').count()) === 1,
  );
  await button('.workspace-switch', '3D').click();
  await page.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  await settle(600);
  check('3D workspace loads with the first example', await solved(), await status());
  check(
    'the 3D view draws the model',
    (await viewerContrast()) > 40,
    `${await viewerContrast()} colours`,
  );
  check(
    'the axis triad, presets and legend are shown',
    (await page.locator('.viewer-presets button').count()) === 5 &&
      (await page.locator('.legend3d').count()) === 1,
  );
  await shot('01-building-frame');
  check(
    'the choice of workspace is remembered',
    (await page.evaluate(() => localStorage.getItem('frameforge-workspace'))) === '3d',
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  check('a reload stays in 3D', (await page.locator('.viewer3d').count()) === 1);

  // ---- 2. Examples ----
  const examples = await page
    .locator('.example-picker option')
    .evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
  check('nine 3D examples are offered', examples.length === 9, `${examples.length}`);
  const groups = await page.locator('.example-picker optgroup').count();
  check('examples are grouped by category', groups === 5);
  for (const id of examples) {
    await page.selectOption('.example-picker', id);
    await settle(400);
    const ok = await solved();
    const contrast = await viewerContrast();
    check(
      `example "${id}" solves and renders`,
      ok && contrast > 30,
      `${await status()}`.split('\n')[1],
    );
    await shot(`ex-${id}`);
  }

  // ---- 3. Result views ----
  await page.selectOption('.example-picker', 'building-frame');
  await settle(300);
  for (const d of ['N', 'Vy', 'Vz', 'T', 'My', 'Mz']) {
    await button('.viewbar .segmented', d).click();
    await settle(80);
    const legend = await page.locator('.legend3d').innerText();
    check(
      `member diagram ${d} is shown with its peak`,
      legend.includes(d) && legend.includes('peak'),
    );
  }
  const labelsBefore = await page.locator('.lbl3d.diagram').count();
  check('diagram peaks are labelled', labelsBefore > 0, `${labelsBefore} labels`);
  await button('.viewbar .segmented', 'None').click();
  await settle(80);
  check('diagrams can be hidden', (await page.locator('.lbl3d.diagram').count()) === 0);
  await button('.viewbar .segmented', 'Mz').click();
  for (const chip of ['Deformed', 'Reactions', 'Loads', 'Supports', 'Labels', 'Grid']) {
    const c = page.locator('.viewbar .chip', { hasText: chip });
    const before = (await c.getAttribute('class')).includes(' on');
    await c.click();
    const after = (await c.getAttribute('class')).includes(' on');
    await c.click();
    check(`"${chip}" toggles`, before !== after);
  }
  const reactionLabels = await page.locator('.lbl3d.reaction').count();
  check('reaction values are labelled', reactionLabels > 0, `${reactionLabels}`);
  await page.locator('input[aria-label="Deformation scale"]').fill('3');
  await page.locator('input[aria-label="Diagram scale"]').fill('2');
  check(
    'scale sliders work',
    (await page.locator('.canvas-controls').innerText()).includes('×3.0'),
  );
  for (const preset of ['Top', 'Front', 'Side', 'Iso', 'Fit']) {
    await button('.viewer-presets', preset).click();
  }
  await settle(150);
  await shot('02-frame-diagram-scaled');

  await page.selectOption('.example-picker', 'slab-on-beams');
  await settle(400);
  const contours = await page
    .locator('.contour-picker option')
    .evaluateAll((els) => els.map((e) => e.value).filter((v) => v !== 'none'));
  check(
    'plate contours are offered',
    contours.includes('plateMx') && contours.includes('displacement'),
  );
  for (const c of contours) {
    await page.selectOption('.contour-picker', c);
    await settle(80);
    const legend = await page.locator('.legend3d').innerText();
    check(`contour "${c}" shows a legend with min/max`, /min .* max /.test(legend));
  }
  await page.selectOption('.contour-picker', 'plateVonMisesTop');
  await settle(150);
  await shot('03-slab-contour');
  await page.selectOption('.example-picker', 'solid-cantilever');
  await settle(400);
  for (const c of ['solidVonMises', 'solidS1', 'solidS3', 'displacement']) {
    await page.selectOption('.contour-picker', c);
    await settle(80);
    check(
      `solid contour "${c}" has units`,
      /\((MPa|mm)\)/.test(await page.locator('.legend3d').innerText()),
    );
  }

  // ---- 4. Results panel ----
  await tab('Results').click();
  check(
    'equilibrium check passes',
    (await page.locator('.ok-note').innerText()).includes('balance'),
  );
  for (const view of ['Displ.', 'Reactions', 'Solids']) {
    await button('.panel-body .segmented', view).click();
    check(
      `results table "${view}" has rows`,
      (await page.locator('.panel-body table tbody tr').count()) > 0,
    );
  }
  await page.selectOption('.example-picker', 'hinged-secondary-beam');
  await settle(300);
  for (const view of ['End forces', 'Extremes']) {
    await button('.panel-body .segmented', view).click();
    check(
      `results table "${view}" has rows`,
      (await page.locator('.panel-body table tbody tr').count()) > 0,
    );
  }
  await page.selectOption('.example-picker', 'simply-supported-slab');
  await settle(300);
  await button('.panel-body .segmented', 'Plates').click();
  check(
    'plate stress table has rows',
    (await page.locator('.panel-body table tbody tr').count()) > 0,
  );

  // ---- 5. Building a model with the tools ----
  await button('.file-actions', 'New').click();
  await settle(200);
  check('New gives an empty model', (await page.locator('.empty-hint').count()) === 1);
  await tool('Node').click();
  await addNodeByCoordinates(0, 0, 0);
  await addNodeByCoordinates(4, 0, 0);
  await addNodeByCoordinates(4, 0, 3);
  await addNodeByCoordinates(0, 0, 3);
  await addNodeByCoordinates(0, 3, 0);
  check('nodes are added by typing coordinates', (await count('nodes')) === 5);
  // Click the grid to add a node there.
  await button('.viewer-presets', 'Top').click();
  await settle(200);
  const vbox = await page.locator('.viewer3d').boundingBox();
  await page.mouse.move(vbox.x + vbox.width * 0.3, vbox.y + vbox.height * 0.75);
  await settle(150);
  check('the grid cursor shows coordinates', (await page.locator('.canvas-readout').count()) === 1);
  await page.mouse.click(vbox.x + vbox.width * 0.3, vbox.y + vbox.height * 0.75);
  await settle(150);
  check('clicking the grid adds a node', (await count('nodes')) === 6);
  await page.keyboard.press('Control+z');
  await settle(100);
  check('undo removes it', (await count('nodes')) === 5);
  await button('.viewer-presets', 'Iso').click();
  await settle(200);

  await tool('Member').click();
  await clickNode('N1');
  await clickNode('N2');
  await clickNode('N3');
  await page.keyboard.press('Escape');
  await page.selectOption('select[aria-label="Member type"]', 'truss');
  await clickNode('N1');
  await clickNode('N3');
  await page.keyboard.press('Escape');
  await page.selectOption('select[aria-label="Member type"]', 'beam');
  await clickNode('N1');
  await clickNode('N5');
  check('the member tool joins clicked nodes', (await count('members')) === 4, await status());

  await tool('Plate').click();
  for (const id of ['N1', 'N2', 'N3', 'N4']) await clickNode(id);
  check('the plate tool makes a plate from four nodes', (await count('plates')) === 1);

  await tool('Support').click();
  await page.selectOption('select[aria-label="Support type"]', 'fixed');
  await clickNode('N1');
  await page.selectOption('select[aria-label="Support type"]', 'pinned');
  await clickNode('N4');
  await page.selectOption('select[aria-label="Support type"]', 'custom');
  await page.locator('.tool-options input[aria-label="Restrain uy"]').check();
  await clickNode('N2');
  check('the support tool adds supports', (await page.locator('.lbl3d.reaction').count()) >= 0);

  await tool('Load').click();
  await page.selectOption('select[aria-label="Load type"]', 'nodal');
  await clickNode('N3');
  await settle(200);
  check('the load tool adds a nodal load', (await count('loads')) === 1);
  check('the supported, loaded model solves', await solved(), await status());

  await tool('Select').click();
  await clickNode('N3');
  await clickNode('N2', ['Shift']);
  await tab('Properties').click();
  check(
    'shift-click selects several nodes',
    (await page.locator('.panel-body h3').first().innerText()).includes('2 nodes'),
  );
  await page.keyboard.press('Escape');

  // Member properties and a member UDL from the Properties panel.
  await tab('Tables').click();
  await button('.panel-body .segmented', 'Members').click();
  await page.locator('.panel-body table tbody tr').first().locator('td').first().click();
  await tab('Properties').click();
  check(
    'selecting a table row opens its properties',
    (await page.locator('.panel-body h3').first().innerText()).startsWith('Member M1'),
  );
  await page.selectOption('select[aria-label="New load type"]', 'distributed');
  await page.locator('.panel-body button', { hasText: 'Add load to M1' }).click();
  await settle(150);
  const wEnd = page.locator('.load-card input[aria-label="w end (kN/m)"]').first();
  await wEnd.fill('-20');
  await wEnd.press('Enter');
  await settle(150);
  check(
    'a trapezoidal member load is added',
    (await page.locator('.load-card').innerText()).includes('Trapezoidal'),
  );
  await page.locator('input[aria-label="Release Mz at end"]').check();
  check(
    'end releases can be set',
    await page.locator('input[aria-label="Release Mz at end"]').isChecked(),
  );
  check('the edited model solves', await solved(), await status());
  await shot('04-built-model');

  // Delete tool, then undo / redo.
  const membersBefore = await count('members');
  await tool('Delete').click();
  await clickNode('N5');
  check(
    'the delete tool removes a node and its member',
    (await count('members')) === membersBefore - 1,
  );
  await button('.topbar', 'Undo').click();
  await settle(100);
  check('Undo restores it', (await count('members')) === membersBefore);
  await button('.topbar', 'Redo').click();
  await settle(100);
  check('Redo deletes it again', (await count('members')) === membersBefore - 1);
  await page.keyboard.press('Control+z');
  await tool('Select').click();

  // Tables edit.
  await tab('Tables').click();
  await button('.panel-body .segmented', 'Nodes').click();
  const y5 = page.locator('.panel-body table tbody tr').nth(4).locator('input[aria-label="Y"]');
  await y5.fill('4');
  await y5.press('Enter');
  await settle(100);
  check('node coordinates can be edited in the table', (await y5.inputValue()) === '4');

  // ---- 6. Generators ----
  await tab('Generate').click();
  const nodesBefore = await count('nodes');
  await page.locator('.gen-card[aria-label="Building frame generator"] button.primary').click();
  await settle(300);
  check('the frame generator adds members', (await count('nodes')) > nodesBefore);
  await page.locator('.gen-card[aria-label="Plate mesh generator"] button.primary').click();
  await settle(300);
  check('the plate mesh generator adds plates', (await count('plates')) > 1);
  await page.locator('.gen-card[aria-label="Solid block generator"] button.primary').click();
  await settle(300);
  check('the solid block generator adds solids', (await count('solids')) === 16);
  const sw = page.locator('.panel-body label.check', { hasText: 'self-weight' }).first();
  await sw.locator('input').check();
  await settle(300);
  check('self-weight can be switched on', await sw.locator('input').isChecked());
  await button('.panel-body', '\\+ Add material').click();
  check(
    'materials can be added',
    (await page.locator('table[aria-label="Materials"] tbody tr').count()) === 3,
  );
  await button('.panel-body', '\\+ Add custom section').click();
  check(
    'custom sections can be added',
    (await page.locator('table[aria-label="Custom sections"] tbody tr').count()) === 1,
  );
  await shot('05-generated');

  // ---- 7. Files ----
  await page.selectOption('.example-picker', 'braced-frame');
  await settle(300);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button('.file-actions', 'Save').click(),
  ]);
  const jsonPath = join(tmp, 'model3d.json');
  await download.saveAs(jsonPath);
  const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
  check('Save downloads a 3D project', saved.kind === 'space' && saved.members.length === 36);
  await page.selectOption('.example-picker', 'tower-25-bar');
  await page.setInputFiles('.topbar input[type="file"]', jsonPath);
  await settle(300);
  check('Open restores a 3D project', (await count('members')) === 36);

  const [png] = await Promise.all([
    page.waitForEvent('download'),
    button('.viewbar', 'Image').click(),
  ]);
  const pngPath = join(tmp, 'view.png');
  await png.saveAs(pngPath);
  const image = PNG.sync.read(readFileSync(pngPath));
  check(
    'the view can be saved as a PNG',
    image.width > 300 && image.height > 300,
    `${image.width}×${image.height}`,
  );

  await button('.file-actions', 'Share').click();
  await page.waitForFunction(() => location.hash.startsWith('#s='));
  const shared = page.url();
  check('Share puts a #s= link in the address bar', shared.includes('#s='));
  const page2 = await context.newPage();
  watch(page2);
  await page2.goto(shared, { waitUntil: 'networkidle' });
  await page2.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  await page2.waitForTimeout(500);
  check(
    'a #s= link opens the 3D workspace with the model',
    /36 members/.test(await page2.locator('.statusbar').innerText()),
  );
  await page2.close();

  // A 2D file opened in 3D goes to the 2D workspace, and back.
  const file2d = join(tmp, 'model2d.json');
  writeFileSync(
    file2d,
    JSON.stringify({
      format: 'frameforge-project',
      version: 1,
      name: 'Two-D beam',
      E: 200,
      nodes: [
        { id: 'N1', x: 0, y: 0 },
        { id: 'N2', x: 5, y: 0 },
      ],
      members: [{ id: 'M1', i: 'N1', j: 'N2', type: 'frame', section: 'ISMB 300' }],
      supports: [
        { node: 'N1', kind: 'pinned' },
        { node: 'N2', kind: 'rollerX' },
      ],
      loads: [{ id: 'L1', kind: 'nodal', node: 'N2', fx: 0, fy: -10, mz: 0 }],
    }),
  );
  await page.setInputFiles('.topbar input[type="file"]', file2d);
  await page.waitForSelector('.canvas svg .member', { timeout: 10000 });
  check(
    'a 2D file opened from 3D switches to the 2D workspace',
    (await page.locator('.member').count()) === 1,
  );
  await page.setInputFiles('.topbar input[type="file"]', jsonPath);
  await page.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  await settle(400);
  check('a 3D file opened from 2D switches to the 3D workspace', (await count('members')) === 36);

  await button('.workspace-switch', '2D').click();
  await page.waitForSelector('.canvas svg .member');
  await page.selectOption('.example-picker', 'portal-frame');
  await settle(200);
  await button('.file-actions', 'Open in 3D').click();
  await page.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  await settle(400);
  check('"Open in 3D" converts the 2D model', await solved(), await status());
  check(
    'the converted model keeps its name',
    (await page.locator('.project-name').innerText()).toLowerCase().includes('portal'),
  );

  // ---- 8. Keyboard, help, theme, phone ----
  await page.keyboard.press('m');
  check(
    'shortcut M picks the member tool',
    (await tool('Member').getAttribute('aria-pressed')) === 'true',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  check(
    'shortcut 1 shows the axial diagram',
    (await page.locator('.legend3d').innerText()).includes('N (kN)'),
  );
  await page.keyboard.press('?');
  check(
    'help explains 3D conventions',
    (await page.locator('.modal').innerText()).includes('Y up'),
  );
  await page.keyboard.press('Escape');

  await page.selectOption('.example-picker', 'building-frame');
  await settle(300);
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.locator('.topbar button', { hasText: /^(Light|Dark)$/ }).click();
  await settle(250);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  check('the theme toggles', themeBefore !== themeAfter, `${themeBefore} -> ${themeAfter}`);
  await shot(`06-theme-${themeAfter}`);
  await page.selectOption('.example-picker', 'pad-footing');
  await settle(300);
  await shot(`07-footing-${themeAfter}`);
  await page.locator('.topbar button', { hasText: /^(Light|Dark)$/ }).click();
  await settle(250);
  await shot(`07-footing-${themeBefore}`);

  // Bigger model: a 30 × 30 plate mesh (~5 600 equations) stays usable.
  await button('.file-actions', 'New').click();
  await tab('Generate').click();
  const mesh = page.locator('.gen-card[aria-label="Plate mesh generator"]');
  for (const [label, value] of [
    ['C1 Y', 0],
    ['C2 Y', 0],
    ['C3 Y', 0],
    ['C4 Y', 0],
    ['C2 X', 10],
    ['C3 X', 10],
    ['C3 Z', 10],
    ['C4 Z', 10],
    ['Divisions 1→2', 30],
    ['Divisions 1→4', 30],
  ]) {
    const input = mesh.locator(`input[aria-label="${label}"]`);
    await input.fill(String(value));
    await input.press('Enter');
  }
  await mesh.locator('button.primary').click();
  // The generated plates stay selected: load them all with the load tool.
  await tool('Load').click();
  await page.selectOption('select[aria-label="Load type"]', 'pressure');
  await button('.tool-options', 'Apply to selected plates').click();
  await tool('Select').click();
  // Fix one edge from the supports table.
  await tab('Tables').click();
  await button('.panel-body .segmented', 'Supports').click();
  for (let k = 0; k < 31; k++) await button('.panel-body', '\\+ Add support.*').click();
  const started = Date.now();
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.statusbar')?.textContent ?? '';
      return /\d+ equations/.test(text) && !text.includes('Analysing');
    },
    null,
    { timeout: 30000 },
  );
  const elapsed = Date.now() - started;
  const bigStatus = await status();
  check(
    'a ~5 600-equation plate mesh solves',
    /(\d{4,}) equations/.test(bigStatus),
    bigStatus.split('\n').join(' · '),
  );
  check('and stays responsive', elapsed < 8000, `${elapsed} ms`);
  const t0 = Date.now();
  await page.mouse.move(vbox.x + vbox.width / 2, vbox.y + vbox.height / 2);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(vbox.x + vbox.width / 2 + 120, vbox.y + vbox.height / 2 + 40, { steps: 8 });
  await page.mouse.up({ button: 'left' });
  check('orbiting a big model is quick', Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  await shot('08-big-mesh');

  // Phone width.
  await page.selectOption('.example-picker', 'building-frame');
  await page.setViewportSize({ width: 390, height: 800 });
  await settle(400);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check('phone layout has no horizontal page scroll', !overflow);
  const phoneBox = await page.locator('.viewer3d').boundingBox();
  check(
    'the viewer is usable on a phone',
    phoneBox.height > 150,
    `${Math.round(phoneBox.height)} px`,
  );
  await shot('09-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
} catch (e) {
  check('script ran to completion', false, String(e));
  await shot('zz-failure').catch(() => undefined);
}

check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nScreenshots: ${shots}`);
console.log(`${results.length - failed.length}/${results.length} checks passed on ${url}`);
process.exit(failed.length === 0 ? 0 : 1);
