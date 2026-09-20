import { test, expect } from '@playwright/test';
import { compressAndRead, uploadFixture } from './support/app.js';

test.describe('WebKit smoke (desktop only; not iOS/Safari release proof)', () => {
    test('uploads and converts a still image', async ({ page }) => {
        await page.goto('/');
        await uploadFixture(page, { name: 'transparent.png', mimeType: 'image/png' });
        const { download, bytes } = await compressAndRead(page);
        expect(download.suggestedFilename()).toBe('transparent_c.jpg');
        expect(bytes.length).toBeGreaterThan(0);
        expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    });

    test('reports invalid target input accessibly', async ({ page }) => {
        await page.goto('/');
        await uploadFixture(page, { name: 'transparent.png', mimeType: 'image/png' });
        const target = page.getByLabel('Max Size:');
        await target.fill('-1');
        await page.getByRole('button', { name: 'COMPRESS' }).click();
        await expect(page.getByRole('alert')).toContainText('positive finite');
        await expect(target).toHaveAttribute('aria-invalid', 'true');
    });

    test('uses the FFmpeg compatibility fallback for a TIFF input', async ({ page }) => {
        await page.goto('/');
        await uploadFixture(page, { name: 'photo.tiff', mimeType: 'image/tiff' });
        const { download, bytes } = await compressAndRead(page);
        expect(download.suggestedFilename()).toBe('photo_c.jpg');
        expect(bytes.length).toBeGreaterThan(0);
        expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    });
});
