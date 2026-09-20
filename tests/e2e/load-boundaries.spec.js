import { test, expect } from '@playwright/test';
import { fixture, readDownloadBytes } from './support/media.js';
import { forceCompatibilityEngine, selectTarget, uploadFixture } from './support/app.js';

function assetPaths(requests) {
    return requests
        .map(request => new URL(request.url()).pathname)
        .filter(path => path.startsWith('/assets/') || path.startsWith('/src/') || path.includes('/node_modules/'));
}

function ffmpegAssetPaths(paths) {
    return paths.filter(path =>
        /\/worker-|\/ffmpeg-core-|\/ffmpeg_engine|\/src\/ffmpeg_engine|\/esm-[^/]+\.js$|\.wasm$/.test(path)
    );
}

async function tracePage(page) {
    const requests = [];
    page.on('request', request => requests.push(request));
    await page.goto('/');
    return {
        requests,
        paths: () => assetPaths(requests),
    };
}

async function makePngFixture(page) {
    const bytes = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 600;
        const context = canvas.getContext('2d');
        const pixels = context.createImageData(canvas.width, canvas.height);
        let seed = 17;
        for (let index = 0; index < pixels.data.length; index += 4) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            pixels.data[index] = seed & 255;
            pixels.data[index + 1] = (seed >>> 8) & 255;
            pixels.data[index + 2] = (seed >>> 16) & 255;
            pixels.data[index + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    return Buffer.from(bytes);
}

test('startup and ordinary PNG compression stay off the video and FFmpeg assets', async ({ page }) => {
    const trace = await tracePage(page);
    const startupPaths = trace.paths();
    expect(startupPaths.some(path => path.includes('video_compressor'))).toBe(false);
    expect(ffmpegAssetPaths(startupPaths)).toEqual([]);

    await page.locator('#file-input').setInputFiles({
        name: 'load-boundary.png',
        mimeType: 'image/png',
        buffer: await makePngFixture(page),
    });
    await page.locator('#max-size').fill('80');
    await page.getByRole('button', { name: 'KB' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    await downloadPromise;
    await expect(page.getByText('DONE')).toBeVisible();

    const allPaths = trace.paths();
    expect(allPaths.filter(path => path.includes('image_compressor'))).toHaveLength(1);
    expect(allPaths.some(path => path.includes('video_compressor'))).toBe(false);
    expect(ffmpegAssetPaths(allPaths)).toEqual([]);
});

test('the first TIFF fallback loads FFmpeg and the second reuses its module and engine', async ({ page }) => {
    const trace = await tracePage(page);
    const tiff = await fixture('photo.tiff');

    for (const name of ['first.tiff', 'second.tiff']) {
        await page.locator('#file-input').setInputFiles({
            name,
            mimeType: 'image/tiff',
            buffer: tiff,
        });
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'COMPRESS' }).click();
        await downloadPromise;
        await expect(page.getByText('DONE').last()).toBeVisible();
    }

    const paths = trace.paths();
    expect(paths.filter(path => path.includes('image_compressor'))).toHaveLength(1);
    expect(paths.filter(path => path.includes('ffmpeg_engine'))).toHaveLength(1);
    expect(paths.some(path => /\/esm-[^/]+\.js$/.test(path) || path.includes('ffmpeg-core'))).toBe(true);
    expect(paths.some(path => path.includes('ffmpeg-core') && path.endsWith('.js'))).toBe(true);
    expect(paths.some(path => path.endsWith('.wasm'))).toBe(true);
});

test('video processing requests the video chunk and exposes reload after a cached chunk failure', async ({ page }) => {
    await page.route('**/*video_compressor*', route => route.abort());
    const trace = await tracePage(page);
    await page.locator('#file-input').setInputFiles({
        name: 'load-boundary.webm',
        mimeType: 'video/webm',
        buffer: Buffer.from('not a real video'),
    });
    await page.getByRole('button', { name: 'COMPRESS' }).click();

    await expect(page.getByText('ERROR')).toBeVisible();
    await expect(page.getByRole('button', { name: 'RELOAD PAGE' })).toBeVisible();
    await expect(page.locator('.file-status-msg')).toContainText('Reload the page and try again.');
    expect(trace.paths().filter(path => path.includes('video_compressor'))).toHaveLength(1);
});

test('retries a first WASM fetch failure in the same page and then downloads TIFF output', async ({ page }) => {
    let wasmRequests = 0;
    await page.route('**/*.wasm', route => {
        wasmRequests++;
        if (wasmRequests === 1) return route.abort('failed');
        return route.continue();
    });
    await page.goto('/');
    await uploadFixture(page, { name: 'photo.tiff', mimeType: 'image/tiff' });
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    await expect(page.getByText('ERROR')).toBeVisible();
    await expect(page.locator('.file-status-msg')).toContainText('Failed to compress image "photo.tiff".');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await downloadPromise;
    const bytes = await readDownloadBytes(download);
    expect(wasmRequests).toBeGreaterThanOrEqual(2);
    expect(download.suggestedFilename()).toBe('photo_c.jpg');
    expect(bytes.length).toBeGreaterThan(0);
    await expect(page.getByText('DONE')).toBeVisible();
});

test('retries a first WASM fetch failure in the same page and then downloads video output', async ({ page }) => {
    test.setTimeout(180_000);
    await forceCompatibilityEngine(page);
    let wasmRequests = 0;
    await page.route('**/*.wasm', route => {
        wasmRequests++;
        if (wasmRequests === 1) return route.abort('failed');
        return route.continue();
    });
    await page.goto('/');
    await uploadFixture(page, { name: 'audio-24fps.webm', mimeType: 'video/webm' });
    await selectTarget(page, 160);
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    await expect(page.getByText('ERROR')).toBeVisible();
    await expect(page.locator('.file-status-msg')).toContainText('Failed to load the FFmpeg video engine.');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await downloadPromise;
    const bytes = await readDownloadBytes(download);
    expect(wasmRequests).toBeGreaterThanOrEqual(2);
    expect(download.suggestedFilename()).toBe('audio-24fps_c.mp4');
    expect(bytes.length).toBeGreaterThan(0);
    await expect(page.getByText('DONE')).toBeVisible();
});
