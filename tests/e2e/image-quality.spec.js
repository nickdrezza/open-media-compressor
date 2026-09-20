import { test, expect } from '@playwright/test';
import { readDownloadBytes } from './support/media.js';

async function makeRasterFixture(page, width, height) {
    return page.evaluate(async ({ width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const pixels = ctx.createImageData(width, height);
        let seed = 0x12345678;
        for (let i = 0; i < pixels.data.length; i += 4) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            pixels.data[i] = seed & 255;
            pixels.data[i + 1] = (seed >>> 8) & 255;
            pixels.data[i + 2] = (seed >>> 16) & 255;
            pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }, { width, height });
}

async function installQualityProbe(page) {
    await page.addInitScript(() => {
        window.__imageQualityCalls = [];
        const originalToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
            window.__imageQualityCalls.push({ width: this.width, height: this.height, type, quality });
            return originalToBlob.call(this, callback, type, quality);
        };
    });
}

test('keeps high-quality output when the maximum-quality candidate fits', async ({ page }) => {
    await installQualityProbe(page);
    const pageErrors = [];
    const failedRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(request.url()));
    await page.goto('/');

    const fixture = await makeRasterFixture(page, 256, 192);
    await page.locator('input[type="file"]').setInputFiles({
        name: 'quality-first.png',
        mimeType: 'image/png',
        buffer: Buffer.from(fixture)
    });
    await page.evaluate(() => { window.__imageQualityCalls = []; });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await downloadPromise;
    const bytes = await readDownloadBytes(download);
    const calls = await page.evaluate(() => window.__imageQualityCalls);

    expect(download.suggestedFilename()).toBe('quality-first_c.jpg');
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(calls).toHaveLength(1);
    expect(calls[0].quality).toBe(0.96);
    await expect(page.getByText('DONE')).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
});

test('resizes before searching quality when minimum-quality output is too large', async ({ page }) => {
    test.setTimeout(180_000);
    await installQualityProbe(page);
    const pageErrors = [];
    const failedRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(request.url()));
    await page.goto('/');

    const fixture = await makeRasterFixture(page, 1200, 800);
    await page.locator('input[type="file"]').setInputFiles({
        name: 'resize-first.png',
        mimeType: 'image/png',
        buffer: Buffer.from(fixture)
    });
    await page.getByText('Max Size:').locator('..').getByRole('spinbutton').fill('5');
    await page.evaluate(() => { window.__imageQualityCalls = []; });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await downloadPromise;
    const bytes = await readDownloadBytes(download);
    const calls = await page.evaluate(() => window.__imageQualityCalls);
    const output = await page.evaluate(async payload => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(payload)], { type: 'image/jpeg' }));
        return { width: bitmap.width, height: bitmap.height };
    }, Array.from(bytes));

    expect(download.suggestedFilename()).toBe('resize-first_c.jpg');
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(5 * 1024);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls[0].quality).toBe(0.96);
    expect(calls[1].quality).toBe(0.02);
    expect(calls[2].quality).toBe(0.96);
    expect(calls[2].width).toBeLessThan(calls[0].width);
    expect(calls[2].height).toBeLessThan(calls[0].height);
    expect(output.width / output.height).toBeCloseTo(1200 / 800, 2);
    await expect(page.getByText('DONE')).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
});
