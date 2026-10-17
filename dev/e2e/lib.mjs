// Shared e2e helpers: open SillyTavern in headless Chromium, point the extension at the fake
// AI, import lore files, and take screenshots. Each script exits non-zero on the first failure.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIXTURES = path.join(DEV, 'fixtures');
export const PRIVATE_LORE = path.join(DEV, '.work', 'lore');
export const ST_URL = 'http://127.0.0.1:8123/';
export const FAKE_URL = 'http://127.0.0.1:8124';

let checks = 0;
export function check(condition, message) {
    checks++;
    if (!condition) throw new Error(`Check failed: ${message}`);
    console.log(`  ✓ ${message}`);
}

export async function launch() {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    // No internet here: SillyTavern's AI Horde lookups would fail and stop the settings from loading.
    await page.route('**/api/horde/**', route => route.fulfill({ contentType: 'application/json', body: route.request().url().includes('text-models') ? '[]' : '{}' }));
    page.on('pageerror', e => console.log('  [page error]', e.message));
    page.on('console', m => { if (m.type() === 'error' && /lore/i.test(m.text())) console.log('  [console]', m.text()); });
    return { browser, page };
}

export async function openST(page) {
    await page.goto(ST_URL);
    // A fresh SillyTavern user first gets a welcome popup asking for a persona name.
    const welcome = page.locator('dialog[open]:has-text("Welcome to SillyTavern")');
    const deadline = Date.now() + 90000;
    for (;;) {
        if (await welcome.count()) {
            await welcome.locator('.popup-button-ok').first().click();
            await welcome.waitFor({ state: 'detached' }).catch(() => {});
        }
        const ready = await page.evaluate(() => !!(window.SillyTavern?.getContext && document.querySelector('#lore_graph_settings'))).catch(() => false);
        if (ready && !(await welcome.count())) break;
        if (Date.now() > deadline) throw new Error('SillyTavern did not finish loading');
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
}

/** Saves a connection profile for the fake AI and points Lore Graph at it (and at the fake embeddings). */
export async function configure(page, extra = {}) {
    const saved = page.waitForResponse(r => r.url().includes('/api/settings/save') && r.ok(), { timeout: 30000 });
    await page.evaluate(async ({ fake, extra }) => {
        const ctx = SillyTavern.getContext();
        const cm = ctx.extensionSettings.connectionManager ??= { profiles: [], selectedProfile: null };
        cm.profiles = cm.profiles.filter(p => p.id !== 'fake-profile');
        cm.profiles.push({ id: 'fake-profile', name: 'Fake AI', mode: 'cc', api: 'custom', 'api-url': `${fake}/v1`, model: 'fake-model' });
        Object.assign(ctx.extensionSettings.lore_graph, {
            enabled: true, extraction_profile: 'fake-profile', extraction_timeout_seconds: 60,
            embed_url: fake, embed_model: 'fake-embed', embed_enabled: false, ...extra,
        });
        ctx.saveSettingsDebounced();
    }, { fake: FAKE_URL, extra });
    await saved;
    await openST(page); // reload so the panel shows the saved settings
}

export async function openPanel(page) {
    await page.click('#extensionsMenuButton').catch(() => {});
    await page.locator('#rm_extensions_block, #top-settings-holder').first().waitFor().catch(() => {});
    const drawer = page.locator('#extensions-settings-button .drawer-toggle');
    if (await drawer.count()) await drawer.click();
    const header = page.locator('#lore_graph_settings .inline-drawer-toggle');
    const content = page.locator('#lore_graph_settings .inline-drawer-content');
    if (!(await content.isVisible())) await header.click();
    await content.waitFor({ state: 'visible' });
}

export async function importLore(page, files) {
    await page.setInputFiles('#lore_graph_import_file', files);
    await page.waitForFunction((n) => document.querySelectorAll('#lore_graph_sources .lore_graph_source').length >= n, files.length, { timeout: 30000 });
    await page.waitForTimeout(1000);
}

/** Confirms the open SillyTavern popup (OK / affirmative button). */
export async function confirmPopup(page) {
    const ok = page.locator('dialog[open] .popup-button-ok').last();
    await ok.waitFor();
    await ok.click();
}

export async function closePopup(page) {
    const ok = page.locator('dialog[open] .popup-button-ok').last();
    if (await ok.count()) await ok.click();
    await page.waitForTimeout(300);
}

export async function extractAll(page) {
    await page.click('#lore_graph_extract');
    await confirmPopup(page);
    await page.waitForFunction(() => /^(Finished|Paused|Stopped|Extraction stopped)/.test(document.querySelector('#lore_graph_extract_status')?.textContent ?? ''), null, { timeout: 180000 });
    const status = await page.locator('#lore_graph_extract_status').textContent();
    check(/^Finished\. \d+ chunk\(s\) processed, 0 failed/.test(status), `extraction finished: "${status}"`);
}

/** Writes one of the extension's JSON files directly (e.g. a saved test list), using its own storage code. */
export async function writeExtensionFile(page, name, data) {
    await page.evaluate(async ({ name, data }) => {
        const storage = await import('/scripts/extensions/third-party/lore-graph/storage.js');
        await storage.saveJsonFile(name, data);
    }, { name, data });
}

export async function buildMeaningIndex(page) {
    await page.click('#lore_graph_embed_build');
    await page.waitForSelector('.toast-success:has-text("meaning index updated")', { timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector('#lore_graph_embed_build.disabled'));
}

/** Text of the most recent toast whose text matches. */
export async function waitToast(page, pattern, timeout = 60000) {
    const handle = await page.waitForFunction((src) => {
        const re = new RegExp(src, 'i');
        return [...document.querySelectorAll('#toast-container .toast')].map(t => t.textContent).reverse().find(t => re.test(t)) || null;
    }, pattern.source, { timeout });
    return handle.jsonValue();
}

export async function shot(page, name, locator = null) {
    const file = path.join(DEV, 'screenshots', `${name}.png`);
    await page.evaluate(() => { window.toastr?.clear(); document.querySelectorAll('#toast-container').forEach(e => e.remove()); }).catch(() => {});
    if (locator) await locator.screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log(`  📷 ${path.relative(DEV, file)}`);
}

/** Screenshot of part of the settings panel, from one element down to another. */
export async function shotPanelArea(page, name, from, to) {
    await from.scrollIntoViewIfNeeded();
    await page.evaluate(() => { window.toastr?.clear(); document.querySelectorAll('#toast-container').forEach(e => e.remove()); });
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    const panel = await page.locator('#lore_graph_settings').boundingBox();
    const file = path.join(DEV, 'screenshots', `${name}.png`);
    await page.screenshot({ path: file, clip: { x: panel.x - 8, y: a.y - 8, width: panel.width + 16, height: b.y + b.height - a.y + 16 } });
    console.log(`  📷 ${path.relative(DEV, file)}`);
}

export async function run(name, fn) {
    const { browser, page } = await launch();
    try {
        await fn(page);
        console.log(`${name}: ${checks} checks passed`);
    } catch (error) {
        console.error(`${name}: FAILED: ${error.message}`);
        await shot(page, `${name}-FAILED`).catch(() => {});
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
}
