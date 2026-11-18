// Generates the README screenshots and the hero GIF with Playwright.
// Usage: node scripts/screenshots.mjs [url]   (default: http://localhost:4179/, `npx vite preview --port 4179`)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gifenc from 'gifenc';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const url = process.argv[2] ?? 'http://localhost:4179/';
const out = 'docs/screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

async function open(theme, viewport = { width: 1440, height: 860 }, scale = 2) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem('frameforge-theme', t), theme);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.viewer3d canvas');
  await page.waitForTimeout(400);
  return page;
}

const pick = async (page, id) => {
  await page.selectOption('.example-picker', id);
  await page.waitForTimeout(400);
};
const chip = (page, label) => page.locator('.viewbar .chip', { hasText: label }).click();
const diagram = (page, label) =>
  page.locator('.viewbar .segmented button', { hasText: new RegExp(`^${label}$`) }).click();
const tab = (page, label) => page.locator('.panel .tabs button', { hasText: label }).click();
const preset = (page, label) =>
  page.locator('.viewer-presets button', { hasText: new RegExp(`^${label}$`) }).click();
const shot = async (page, name) => {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, name) });
  console.log(`wrote ${out}/${name}`);
};

// 1. Hero still: plane portal frame, dark theme, bending moments and deflected shape.
{
  const page = await open('dark');
  await pick(page, 'plane-portal-frame');
  await tab(page, 'Results');
  await shot(page, 'hero-dark.png');
  await page.context().close();
}

// 2. Multi-storey plane frame with the IS 800 design tab and utilisation colours.
{
  const page = await open('light');
  await pick(page, 'plane-multi-storey');
  await diagram(page, 'None');
  await chip(page, 'Utilisation');
  await tab(page, 'Design');
  await shot(page, 'design-check.png');
  await page.context().close();
}

// 3. Plane transmission tower, utilisation colours.
{
  const page = await open('dark', { width: 1440, height: 1000 });
  await pick(page, 'plane-transmission-tower');
  await diagram(page, 'None');
  await chip(page, 'Utilisation');
  await tab(page, 'Design');
  await shot(page, 'transmission-tower.png');
  await page.context().close();
}

// 4. Pratt truss, axial forces drawn on the members.
{
  const page = await open('light');
  await pick(page, 'plane-pratt-truss');
  await chip(page, 'Labels');
  await tab(page, 'Results');
  await shot(page, 'pratt-truss.png');
  await page.context().close();
}

// 5. Editing by table.
{
  const page = await open('light');
  await pick(page, 'plane-continuous-beam');
  await tab(page, 'Tables');
  await page.locator('.panel-body .segmented button', { hasText: 'Loads' }).click();
  await shot(page, 'tables.png');
  await page.context().close();
}

// 6. Animated mode shape of the 3D building frame, caught near its largest amplitude.
{
  const page = await open('dark');
  await pick(page, 'building-frame');
  await tab(page, 'Advanced');
  await page.locator('label', { hasText: 'Compute natural frequencies' }).locator('input').check();
  await page.waitForSelector('table[aria-label="Natural frequencies"] tbody tr');
  // Sample one 1.6 s cycle and keep the frame that differs most from the undeformed view.
  await page.mouse.move(5, 5);
  await page.locator('.panel-body button', { hasText: 'Stop the animation' }).click();
  await page.waitForTimeout(300);
  const still = PNG.sync.read(await page.screenshot());
  await page.locator('table[aria-label="Natural frequencies"] tbody tr').first().click();
  let best = { score: -1, png: null };
  for (let k = 0; k < 16; k++) {
    await page.waitForTimeout(100);
    const buffer = await page.screenshot();
    const png = PNG.sync.read(buffer);
    let score = 0;
    for (let q = 0; q < png.data.length; q += 4 * 53) {
      score += Math.abs(png.data[q] - still.data[q]) > 30 ? 1 : 0;
    }
    if (score > best.score) best = { score, png: buffer };
  }
  writeFileSync(join(out, 'modal.png'), best.png);
  console.log(`wrote ${out}/modal.png`);
  await page.context().close();
}

// 7. Influence line of the moment over a support of the continuous beam.
{
  const page = await open('light');
  await pick(page, 'plane-continuous-beam');
  await tab(page, 'Advanced');
  await page.selectOption('select[aria-label="Influence line response"]', 'memberForce');
  await page.selectOption('select[aria-label="Influence line member"]', 'M1');
  const position = page.locator('input[aria-label="Section position (m)"]');
  await position.fill('6');
  await position.press('Enter');
  await page.locator('.panel-body button', { hasText: 'Show influence line' }).click();
  await page.waitForSelector('table[aria-label="Influence line ordinates"] tbody tr');
  await shot(page, 'influence-line.png');
  await page.context().close();
}

// 8. Phone layout.
{
  const page = await open('dark', { width: 390, height: 800 }, 3);
  await pick(page, 'plane-gable-frame');
  await shot(page, 'mobile.png');
  await page.context().close();
}

// 9. 3D examples.
{
  const page = await open('light');
  await pick(page, 'building-frame');
  await tab(page, 'Results');
  await shot(page, '3d-building-frame.png');
  await pick(page, 'slab-on-beams');
  await shot(page, '3d-slab-on-beams.png');
  await pick(page, 'tower-25-bar');
  await diagram(page, 'N');
  await shot(page, '3d-tower.png');
  await page.context().close();
}
{
  const page = await open('dark');
  await pick(page, 'pad-footing');
  await preset(page, 'Iso');
  await shot(page, '3d-pad-footing.png');
  await page.context().close();
}

// 10. First page of the PDF report (rendered to PNG with macOS `sips`, if available).
{
  const page = await open('light');
  await pick(page, 'building-frame');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.file-actions button', { hasText: 'PDF report' }).click(),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'frameforge-pdf-'));
  const pdf = join(dir, 'report.pdf');
  await download.saveAs(pdf);
  try {
    execFileSync(
      'sips',
      ['-s', 'format', 'png', '--resampleHeight', '1600', pdf, '--out', join(out, 'report.png')],
      { stdio: 'ignore' },
    );
    console.log(`wrote ${out}/report.png`);
  } catch {
    console.log('skipped report.png (sips not available)');
  }
  await page.context().close();
}

// 11. Hero GIF: drag a joint of the plane portal with live results, then cycle the diagrams
// and switch on the utilisation colours.
{
  const page = await open('dark', { width: 1000, height: 600 }, 1);
  await pick(page, 'plane-portal-frame');
  await tab(page, 'Results');
  const frames = [];
  const grab = async (hold = 1) => {
    frames.push({ png: PNG.sync.read(await page.screenshot()), delay: 110 * hold });
  };
  const start = await page.evaluate(() => window.frameforgeViewer3D?.nodeScreenPosition('N2'));
  await page.mouse.move(5, 5);
  await grab(8);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const path = [];
  for (let k = 1; k <= 8; k++) path.push([start.x + k * 12, start.y - k * 5]);
  for (let k = 7; k >= 0; k--) path.push([start.x + k * 12, start.y - k * 5]);
  for (let k = 1; k <= 6; k++) path.push([start.x - k * 4, start.y + k * 10]);
  for (let k = 5; k >= 0; k--) path.push([start.x - k * 4, start.y + k * 10]);
  for (const [x, y] of path) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(60);
    await grab();
  }
  await page.mouse.up();
  await page.keyboard.press('Control+z');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  await grab(5);
  for (const label of ['Vy', 'N', 'Mz']) {
    await diagram(page, label);
    await page.waitForTimeout(120);
    await grab(9);
  }
  await chip(page, 'Utilisation');
  await tab(page, 'Design');
  await page.waitForTimeout(150);
  await grab(14);

  const { width, height } = frames[0].png;
  const gif = GIFEncoder();
  for (const { png, delay } of frames) {
    const palette = quantize(png.data, 96);
    gif.writeFrame(applyPalette(png.data, palette), width, height, { palette, delay });
  }
  gif.finish();
  writeFileSync(join(out, 'hero.gif'), gif.bytes());
  console.log(
    `wrote ${out}/hero.gif (${frames.length} frames, ${(gif.bytes().length / 1e6).toFixed(1)} MB)`,
  );
  await page.context().close();
}

await browser.close();
