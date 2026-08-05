import { test, expect } from '@playwright/test';

function makeImageFixture() {
    const shapes = Array.from({ length: 400 }, (_, index) => {
        const x = (index * 37) % 1200;
        const y = (index * 61) % 800;
        const color = `hsl(${index % 360} 80% 50%)`;
        return `<circle cx="${x}" cy="${y}" r="24" fill="${color}"/>`;
    }).join('');

    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="100%" height="100%" fill="#111"/>${shapes}</svg>`
    );
}

test('uploads, compresses, and downloads an image', async ({ page }) => {
    const pageErrors = [];
    const failedRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));

    await page.goto('/');

    await page.locator('input[type="file"]').setInputFiles({
        name: 'browser-fixture.svg',
        mimeType: 'image/svg+xml',
        buffer: makeImageFixture(),
    });

    await expect(page.getByText('browser-fixture.svg')).toBeVisible();
    await page.getByText('Max Size:').locator('..').getByRole('spinbutton').fill('20');
    await page.getByRole('button', { name: 'KB' }).click();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('browser-fixture_c.webp');
    const output = await download.createReadStream();
    const chunks = [];
    for await (const chunk of output) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(20 * 1024);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');

    await expect(page.getByText('DONE')).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
});

test('explains unsupported uploads instead of silently doing nothing', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not media'),
    });

    await page.getByRole('button', { name: 'COMPRESS' }).click();

    await expect(page.getByText('ERROR')).toBeVisible();
    await expect(page.getByText(/Format not supported/)).toBeVisible();
});
