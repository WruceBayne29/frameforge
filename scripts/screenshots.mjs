// Generates the README screenshots and the hero GIF with Playwright.
// Usage: node scripts/screenshots.mjs [url]   (default: http://localhost:5183/)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gifenc from 'gifenc';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const url = process.argv[2] ?? 'http://localhost:5183/';
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
  await page.waitForSelector('.member');
  return page;
}

const pick = async (page, id) => {
  await page.selectOption('.example-picker', id);
  await page.waitForTimeout(200);
};
const chip = (page, label) => page.locator('.viewbar .chip', { hasText: label }).click();
const diagram = (page, label) =>
  page.locator('.viewbar .segmented button', { hasText: label }).click();
const tab = (page, label) => page.locator('.tabs button', { hasText: label }).click();
const shot = async (page, name) => {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(out, name) });
  console.log(`wrote ${out}/${name}`);
};

// 1. Hero: portal frame, dark theme, bending moments and deflected shape.
{
  const page = await open('dark');
  await pick(page, 'portal-frame');
  await tab(page, 'Results');
  await shot(page, 'hero-dark.png');
  await page.context().close();
}

// 2. Multi-storey frame in light theme with the design table.
{
  const page = await open('light');
  await pick(page, 'multi-storey');
  await diagram(page, 'None');
  await chip(page, 'Utilisation');
  await tab(page, 'Design');
  await shot(page, 'design-check.png');
  await page.context().close();
}

// 3. Transmission tower, utilisation colours.
{
  const page = await open('dark', { width: 1440, height: 1000 });
  await pick(page, 'transmission-tower');
  await diagram(page, 'None');
  await chip(page, 'Utilisation');
  await tab(page, 'Design');
  await shot(page, 'transmission-tower.png');
  await page.context().close();
}

// 4. Pratt truss, axial forces.
{
  const page = await open('light');
  await pick(page, 'pratt-truss');
  await chip(page, 'Labels');
  await tab(page, 'Results');
  await shot(page, 'pratt-truss.png');
  await page.context().close();
}

// 5. Editing by table.
{
  const page = await open('light');
  await pick(page, 'continuous-beam');
  await tab(page, 'Tables');
  await page.locator('.panel-body .segmented button', { hasText: 'Loads' }).click();
  await shot(page, 'tables.png');
  await page.context().close();
}

// 6. Phone layout.
{
  const page = await open('dark', { width: 390, height: 800 }, 3);
  await pick(page, 'gable-frame');
  await shot(page, 'mobile.png');
  await page.context().close();
}

// 7. First page of the PDF report (rendered to PNG with macOS `sips`, if available).
{
  const page = await open('light');
  await pick(page, 'portal-frame');
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
      {
        stdio: 'ignore',
      },
    );
    console.log(`wrote ${out}/report.png`);
  } catch {
    console.log('skipped report.png (sips not available)');
  }
  await page.context().close();
}

// 8. Hero GIF: drag a joint with live results, then cycle through the diagrams.
{
  const page = await open('dark', { width: 1000, height: 600 }, 1);
  await pick(page, 'portal-frame');
  await tab(page, 'Results');
  const frames = [];
  const grab = async (hold = 1) => {
    frames.push({ png: PNG.sync.read(await page.screenshot()), delay: 110 * hold });
  };
  const b = await page.locator('.canvas').boundingBox();
  const node = page.locator('.node circle').nth(2);
  const start = {
    x: b.x + Number(await node.getAttribute('cx')),
    y: b.y + Number(await node.getAttribute('cy')),
  };
  await grab(8);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const path = [];
  for (let k = 1; k <= 8; k++) path.push([start.x + k * 14, start.y - k * 6]);
  for (let k = 7; k >= 0; k--) path.push([start.x + k * 14, start.y - k * 6]);
  for (let k = 1; k <= 6; k++) path.push([start.x - k * 5, start.y + k * 12]);
  for (let k = 5; k >= 0; k--) path.push([start.x - k * 5, start.y + k * 12]);
  for (const [x, y] of path) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(40);
    await grab();
  }
  await page.mouse.up();
  await page.mouse.move(b.x + 40, b.y + b.height - 60);
  await grab(5);
  for (const label of ['Shear', 'Axial', 'Moment']) {
    await diagram(page, label);
    await page.waitForTimeout(80);
    await grab(9);
  }
  await chip(page, 'Utilisation');
  await tab(page, 'Design');
  await page.waitForTimeout(80);
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
