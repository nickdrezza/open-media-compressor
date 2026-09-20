import { test, expect } from '@playwright/test';

function assetPaths(requests) {
    return requests
        .map(request => new URL(request.url()).pathname)
        .filter(path => path.startsWith('/assets/') || path.startsWith('/src/') || path.includes('/node_modules/'));
}

function ffmpegAssetPaths(paths) {
    return paths.filter(path =>
        /\/worker-|\/worker\.js$|\/ffmpeg-core-|\/ffmpeg_engine(?:-|\/|\.js)|\/src\/ffmpeg_engine|\/esm-[^/]+\.js$|\.wasm$/.test(path)
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

function makeTiffFixture(width = 32, height = 32) {
    const entryCount = 10;
    const ifdSize = 2 + entryCount * 12 + 4;
    const bitsOffset = 8 + ifdSize;
    const pixelOffset = bitsOffset + 6;
    const pixels = width * height * 3;
    const buffer = Buffer.alloc(pixelOffset + pixels);
    buffer.write('II', 0, 'ascii');
    buffer.writeUInt16LE(42, 2);
    buffer.writeUInt32LE(8, 4);
    buffer.writeUInt16LE(entryCount, 8);
    const entries = [
        [256, 4, 1, width], [257, 4, 1, height], [258, 3, 3, bitsOffset],
        [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, pixelOffset],
        [277, 3, 1, 3], [278, 4, 1, height], [279, 4, 1, pixels], [284, 3, 1, 1]
    ];
    entries.forEach(([tag, type, count, value], index) => {
        const offset = 10 + index * 12;
        buffer.writeUInt16LE(tag, offset);
        buffer.writeUInt16LE(type, offset + 2);
        buffer.writeUInt32LE(count, offset + 4);
        if (type === 3 && count === 1) buffer.writeUInt16LE(value, offset + 8);
        else buffer.writeUInt32LE(value, offset + 8);
    });
    buffer.writeUInt16LE(8, bitsOffset);
    buffer.writeUInt16LE(8, bitsOffset + 2);
    buffer.writeUInt16LE(8, bitsOffset + 4);
    for (let index = 0; index < width * height; index++) {
        buffer[pixelOffset + index * 3] = (index * 17) % 256;
        buffer[pixelOffset + index * 3 + 1] = (index * 31) % 256;
        buffer[pixelOffset + index * 3 + 2] = (index * 47) % 256;
    }
    return buffer;
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
    const tiff = makeTiffFixture();

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
    expect(paths.some(path => /\/dist\/esm\/|\/esm-[^/]+\.js$/.test(path))).toBe(true);
    expect(paths.filter(path => /\/worker-|\/worker\.js$/.test(path))).toHaveLength(1);
    expect(paths.filter(path => /\/ffmpeg-core(?:-|\/|\.js)/.test(path) && path.endsWith('.js'))).toHaveLength(1);
    expect(paths.filter(path => path.endsWith('.wasm'))).toHaveLength(1);
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
