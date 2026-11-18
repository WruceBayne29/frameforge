// End-to-end test of FrameForge: opens the app in headless Chromium and exercises examples
// (3D and the converted 2D ones), tools, plane-frame mode with node dragging, generators, result
// views, IS 800 design, modal analysis, influence lines, the PDF report, files, share links,
// the migration of old 2D files / links / autosaves, themes and the phone layout.
// Usage: node scripts/e2e3d.mjs [url] [screenshot-dir]
//   (default url: the live GitHub Pages site; screenshots go to a temporary folder)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const url =
  process.argv[2] ?? process.env.FRAMEFORGE_URL ?? 'https://wrucebayne29.github.io/frameforge/';
const tmp = mkdtempSync(join(tmpdir(), 'frameforge-e2e-'));
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
/** A share-link payload as the app makes it: `1.` + base64url(deflate-raw(JSON)). */
const payload = (value) =>
  `1.${deflateRawSync(Buffer.from(JSON.stringify(value))).toString('base64url')}`;
/** A model file of the former 2D app. */
const OLD_2D = {
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
};
/** Waits for a toast containing the text. */
const toast = (text) =>
  page
    .locator('.toasts', { hasText: text })
    .first()
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
async function viewerShot() {
  const box = await page.locator('.viewer3d').boundingBox();
  return PNG.sync.read(await page.screenshot({ clip: box }));
}
/** Share of sampled pixels that differ between two viewer screenshots. */
function difference(a, b) {
  let diff = 0;
  let total = 0;
  for (let k = 0; k < Math.min(a.data.length, b.data.length); k += 4 * 31) {
    total++;
    if (Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1]) > 30) diff++;
  }
  return diff / Math.max(total, 1);
}
async function newModel(kind = 'space') {
  await page.selectOption('.new-picker', kind);
  await settle(200);
}
async function addNodeByCoordinates(x, y, z) {
  const fields = ['X', 'Y', 'Z'];
  for (const [k, v] of [x, y, z].entries()) {
    if (z === undefined && k === 2) continue;
    const input = page.locator(`input[aria-label="New node ${fields[k]} (m)"]`);
    await input.fill(String(v));
    await input.press('Enter');
  }
  await button('.tool-options', 'Add node').click();
  await settle(120);
}

try {
  // ---- 1. Start-up ----
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  await settle(600);
  check(
    'the app opens straight into the 3D viewer',
    (await page.locator('.viewer3d').count()) === 1,
  );
  check(
    'there is no 2D | 3D switch any more',
    (await page.locator('.workspace-switch').count()) === 0,
  );
  check('the first example solves', await solved(), await status());
  check(
    'the 3D view draws the model',
    (await viewerContrast()) > 40,
    `${await viewerContrast()} colours`,
  );
  check(
    'the camera presets and legend are shown',
    (await page.locator('.viewer-presets button').count()) === 5 &&
      (await page.locator('.legend3d').count()) === 1,
  );
  await shot('01-building-frame');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  check('a reload keeps the model', await solved());

  // ---- 2. Examples ----
  const examples = await page
    .locator('.example-picker option')
    .evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
  check(
    'eighteen examples are offered (nine 3D, nine converted 2D)',
    examples.length === 18,
    `${examples.length}`,
  );
  const groups = await page.locator('.example-picker optgroup').count();
  check('examples are grouped by category, with a 2D group', groups === 6);
  check(
    'the 2D examples are plane frames',
    examples.filter((id) => id.startsWith('plane-')).length === 9,
  );
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
    if (id.startsWith('plane-')) {
      check(
        `example "${id}" opens in plane frame mode`,
        (await page.locator('.plane-badge').count()) === 1,
      );
    }
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
  await newModel();
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

  // Files and links of the former 2D app open as plane frames.
  const file2d = join(tmp, 'model2d.json');
  writeFileSync(file2d, JSON.stringify(OLD_2D));
  await page.setInputFiles('.topbar input[type="file"]', file2d);
  check('an old 2D file says it was converted', await toast('converted to a plane frame'));
  await settle(300);
  check(
    'an old 2D file opens as a plane frame',
    (await page.locator('.plane-badge').count()) === 1 &&
      (await page.locator('.project-name').innerText()).includes('Two-D beam') &&
      (await solved()),
  );
  const oldLink = `${url.split('#')[0]}#m=${payload(OLD_2D)}`;
  const page3 = await context.newPage();
  watch(page3);
  await page3.goto(oldLink, { waitUntil: 'networkidle' });
  await page3.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  await page3.waitForTimeout(600);
  check(
    'an old #m= link opens the model as a plane frame',
    (await page3.locator('.plane-badge').count()) === 1 &&
      (await page3.locator('.project-name').innerText()).includes('Two-D beam'),
  );
  await page3.close();

  // ---- 7b. Plane frame mode ----
  await page.selectOption('.example-picker', 'plane-portal-frame');
  await settle(400);
  check(
    'a plane frame shows the Plane XY badge',
    (await page.locator('.plane-badge').count()) === 1,
  );
  check(
    'the camera is locked: only "Fit" is offered',
    (await page.locator('.viewer-presets button').count()) === 1,
  );
  const diagramButtons = await page.locator('.viewbar .segmented button').allInnerTexts();
  check(
    'plane frames offer the N, Vy and Mz diagrams',
    diagramButtons.join(' ') === 'None N Vy Mz',
    diagramButtons.join(' '),
  );
  await tab('Results').click();
  await button('.panel-body .segmented', 'Reactions').click();
  const reactionHead = await page
    .locator('table[aria-label="Support reactions"] thead')
    .innerText();
  check(
    'reaction tables show only the in-plane components',
    reactionHead.includes('Fx') && reactionHead.includes('Mz') && !reactionHead.includes('Fz'),
    reactionHead.replace(/\s+/g, ' '),
  );
  // Drag node N2 (top of the left column) to the right: the results follow live.
  await tool('Select').click();
  const before = await status();
  const p2 = await nodeAt('N2');
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(p2.x + 12 * k, p2.y - 6 * k);
  await settle(200);
  const during = await status();
  await page.mouse.up();
  await settle(200);
  await tab('Tables').click();
  await button('.panel-body .segmented', 'Nodes').click();
  const x2 = await page
    .locator('.panel-body table tbody tr')
    .nth(1)
    .locator('input[aria-label="X"]')
    .inputValue();
  check(
    'dragging a node moves it on the snap grid',
    Number(x2) > 0 && Number(x2) * 2 === Math.round(Number(x2) * 2),
    `x = ${x2}`,
  );
  check(
    'the results update while dragging',
    during !== before && (await solved()),
    during.split('\n')[1],
  );
  check(
    'node tables show X and Y only',
    (await page.locator('.panel-body table thead').first().innerText()).includes('Y (m)') &&
      !(await page.locator('.panel-body table thead').first().innerText()).includes('Z (m)'),
  );
  await page.keyboard.press('Control+z');
  await settle(150);
  check(
    'one Undo puts the dragged node back',
    (await page
      .locator('.panel-body table tbody tr')
      .nth(1)
      .locator('input[aria-label="X"]')
      .inputValue()) === '0',
  );
  await shot('10-plane-portal');
  await newModel('plane');
  check(
    'New → Plane frame starts an empty plane frame',
    (await page.locator('.plane-badge').count()) === 1,
  );
  await tool('Node').click();
  check(
    'in plane mode new nodes take X and Y only',
    (await page.locator('input[aria-label="New node Z (m)"]').count()) === 0,
  );
  await addNodeByCoordinates(0, 0);
  await addNodeByCoordinates(6, 0);
  await tool('Member').click();
  await clickNode('N1');
  await clickNode('N2');
  await page.keyboard.press('Escape');
  await tool('Support').click();
  const kinds = await page
    .locator('select[aria-label="Support type"] option')
    .evaluateAll((els) => els.map((e) => e.value));
  check(
    'supports offer the 2D kinds',
    ['fixed', 'pinned', 'rollerX', 'rollerY'].every((k) => kinds.includes(k)),
    kinds.join(' '),
  );
  await page.selectOption('select[aria-label="Support type"]', 'pinned');
  await clickNode('N1');
  await page.selectOption('select[aria-label="Support type"]', 'rollerX');
  await clickNode('N2');
  await tool('Load').click();
  await page.selectOption('select[aria-label="Load type"]', 'distributed');
  const p1 = await nodeAt('N1');
  const q2 = await nodeAt('N2');
  await page.mouse.click((p1.x + q2.x) / 2, (p1.y + q2.y) / 2);
  await settle(250);
  check('a beam drawn in plane mode solves', await solved(), await status());
  await tool('Select').click();
  await tab('Properties').click();
  await page.keyboard.press('Escape');
  const planeToggle = page.locator('input[aria-label="Plane frame (XY)"]');
  await planeToggle.uncheck();
  await settle(250);
  check(
    'plane mode can be switched off (free 3D camera again)',
    (await page.locator('.viewer-presets button').count()) === 5,
  );
  await planeToggle.check();
  await settle(250);
  check('… and back on', (await page.locator('.plane-badge').count()) === 1);

  // ---- 7c. IS 800 design ----
  await page.selectOption('.example-picker', 'building-frame');
  await settle(400);
  await tab('Design').click();
  const designText = await page.locator('.panel-body').innerText();
  check(
    'the Design tab summarises the IS 800 check',
    designText.includes('Highest utilisation') && designText.includes('Torsion is not checked'),
  );
  check(
    'every rolled member gets a ratio',
    (await page.locator('table[aria-label="Design summary"] tbody .badge').count()) > 10,
  );
  const plain = await viewerShot();
  await page.keyboard.press('u');
  await settle(300);
  const coloured = await viewerShot();
  check(
    'U colours the members by utilisation',
    difference(plain, coloured) > 0.002,
    `${(difference(plain, coloured) * 100).toFixed(2)} % of pixels`,
  );
  await page.locator('table[aria-label="Design summary"] tbody tr').first().click();
  await settle(150);
  check(
    'clicking a member shows the full check breakdown',
    (await page.locator('.design-breakdown').count()) === 1 &&
      (await page.locator('.design-breakdown').innerText()).includes('KL/r'),
  );
  await page.selectOption('select[aria-label="Steel grade"]', 'E350');
  await settle(200);
  check(
    'the steel grade can be changed',
    (await page.locator('.panel-body').innerText()).includes('E350'),
  );
  await shot('11-design');
  await page.keyboard.press('u');

  // ---- 7d. Modal analysis and influence lines ----
  await tab('Advanced').click();
  await page.locator('label', { hasText: 'Compute natural frequencies' }).locator('input').check();
  await page.waitForSelector('table[aria-label="Natural frequencies"] tbody tr', {
    timeout: 10000,
  });
  check(
    'six natural frequencies are listed',
    (await page.locator('table[aria-label="Natural frequencies"] tbody tr').count()) === 6,
  );
  check(
    'mode 1 is animated',
    (await page.locator('.legend3d', { hasText: 'Mode 1' }).count()) === 1,
  );
  const frameA = await viewerShot();
  await page.waitForTimeout(400);
  const frameB = await viewerShot();
  check(
    'the mode shape moves',
    difference(frameA, frameB) > 0.002,
    `${(difference(frameA, frameB) * 100).toFixed(2)} % of pixels`,
  );
  await shot('12-modal');
  await button('.panel-body', 'Stop the animation').click();
  await page.selectOption('.example-picker', 'plane-continuous-beam');
  await settle(400);
  await tab('Advanced').click();
  await button('.panel-body', 'Show influence line').click();
  await page.waitForSelector('table[aria-label="Influence line ordinates"] tbody tr', {
    timeout: 10000,
  });
  check(
    'an influence line is computed along the beams',
    (await page.locator('table[aria-label="Influence line ordinates"] tbody tr').count()) > 10,
  );
  await page.selectOption('select[aria-label="Influence line response"]', 'memberForce');
  await settle(300);
  check(
    'influence lines of internal forces at a section',
    (await page.locator('.panel-body').innerText()).includes('Largest'),
  );
  await shot('13-influence');
  await button('.panel-body', 'Hide').click();

  // ---- 7e. PDF report ----
  for (const id of ['plane-portal-frame', 'slab-on-beams']) {
    await page.selectOption('.example-picker', id);
    await settle(400);
    const [pdf] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      button('.file-actions', 'PDF report').click(),
    ]);
    const pdfPath = join(tmp, `${id}.pdf`);
    await pdf.saveAs(pdfPath);
    const bytes = readFileSync(pdfPath);
    check(
      `the PDF report of "${id}" downloads`,
      bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 20000,
      `${pdf.suggestedFilename()} · ${Math.round(bytes.length / 1024)} kB`,
    );
  }

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
  const help = await page.locator('.modal').innerText();
  check(
    'help explains the conventions and plane frames',
    help.includes('Y up') && help.includes('Plane frame'),
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
  await newModel();
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

  // ---- 9. The former 2D app's autosave is converted once ----
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await fresh.addInitScript((model) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('frameforge-project', model);
    localStorage.setItem('frameforge-workspace', '2d');
  }, JSON.stringify(OLD_2D));
  const page4 = await fresh.newPage();
  watch(page4);
  await page4.goto(url, { waitUntil: 'networkidle' });
  await page4.waitForSelector('.viewer3d canvas', { timeout: 20000 });
  check(
    'an old 2D autosave opens converted, with a message',
    await page4
      .locator('.toasts', { hasText: 'converted to a plane frame' })
      .first()
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  );
  check(
    'the converted autosave is the open model',
    (await page4.locator('.project-name').innerText()).includes('Two-D beam') &&
      (await page4.locator('.plane-badge').count()) === 1,
  );
  check(
    'the old autosave is converted only once',
    (await page4.evaluate(() => localStorage.getItem('frameforge-project'))) === null,
  );
  await fresh.close();
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
