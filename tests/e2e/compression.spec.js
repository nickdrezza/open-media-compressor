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

function makeTiffFixture(width = 64, height = 64) {
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
    for (let i = 0; i < width * height; i++) {
        buffer[pixelOffset + i * 3] = (i * 17) % 256;
        buffer[pixelOffset + i * 3 + 1] = (i * 31) % 256;
        buffer[pixelOffset + i * 3 + 2] = (i * 47) % 256;
    }
    return buffer;
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
    const download = await Promise.race([
        downloadPromise,
        page.getByText('ERROR', { exact: true }).waitFor().then(async () => {
            throw new Error(await page.locator('.file-status-msg').first().innerText());
        })
    ]);

    expect(download.suggestedFilename()).toBe('browser-fixture_c.jpg');
    const output = await download.createReadStream();
    const chunks = [];
    for await (const chunk of output) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(20 * 1024);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    await expect(page.getByText('DONE')).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
});

test('flattens transparent PNG pixels onto white in JPEG output', async ({ page }) => {
    await page.goto('/');
    const pngBytes = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 600;
        canvas.height = 400;
        const ctx = canvas.getContext('2d');
        const pixels = ctx.createImageData(500, 300);
        let seed = 42;
        for (let i = 0; i < pixels.data.length; i += 4) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            pixels.data[i] = seed & 255;
            pixels.data[i + 1] = (seed >>> 8) & 255;
            pixels.data[i + 2] = (seed >>> 16) & 255;
            pixels.data[i + 3] = 180;
        }
        ctx.putImageData(pixels, 50, 50);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await page.locator('input[type="file"]').setInputFiles({
        name: 'transparent-art.png',
        mimeType: 'image/png',
        buffer: Buffer.from(pngBytes)
    });
    await page.getByText('Max Size:').locator('..').getByRole('spinbutton').fill('80');
    await page.getByRole('button', { name: 'KB' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('transparent-art_c.jpg');
    const output = await download.createReadStream();
    const chunks = [];
    for await (const chunk of output) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBeLessThanOrEqual(80 * 1024);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const corner = await page.evaluate(async payload => {
        const blob = new Blob([Uint8Array.from(payload)], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return [...ctx.getImageData(0, 0, 1, 1).data];
    }, Array.from(bytes));
    expect(corner[0]).toBeGreaterThan(245);
    expect(corner[1]).toBeGreaterThan(245);
    expect(corner[2]).toBeGreaterThan(245);
    expect(corner[3]).toBe(255);
});

test('uses the fallback decoder for a TIFF photo and outputs JPEG', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({
        name: 'camera-photo.tiff',
        mimeType: 'image/tiff',
        buffer: makeTiffFixture()
    });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('camera-photo_c.jpg');
    const output = await download.createReadStream();
    const chunks = [];
    for await (const chunk of output) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.byteLength).toBeLessThanOrEqual(makeTiffFixture().byteLength);
    await expect(page.getByText('DONE')).toBeVisible();
});

test('converts a WebM video to H.264 MP4 under the target size', async ({ page }) => {
    test.setTimeout(180_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/');

    const videoBytes = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(24);
        const audioContext = new AudioContext();
        const audioDestination = audioContext.createMediaStreamDestination();
        const oscillator = audioContext.createOscillator();
        oscillator.frequency.value = 440;
        oscillator.connect(audioDestination);
        oscillator.start();
        stream.addTrack(audioDestination.stream.getAudioTracks()[0]);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 1_500_000 });
        const chunks = [];
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.start();
        const started = performance.now();
        while (performance.now() - started < 2200) {
            const t = performance.now() - started;
            ctx.fillStyle = `hsl(${Math.floor(t / 8) % 360} 70% 30%)`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < 80; i++) {
                ctx.fillStyle = `hsl(${(i * 41 + t / 4) % 360} 90% 60%)`;
                ctx.fillRect((i * 83 + t / 2) % 640, (i * 47 + t / 3) % 360, 28, 28);
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        await new Promise(resolve => {
            recorder.onstop = resolve;
            recorder.stop();
        });
        oscillator.stop();
        await audioContext.close();
        stream.getTracks().forEach(track => track.stop());
        return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });

    await page.locator('input[type="file"]').setInputFiles({
        name: 'browser-video.webm',
        mimeType: 'video/webm',
        buffer: Buffer.from(videoBytes)
    });
    await page.getByText('Max Size:').locator('..').getByRole('spinbutton').fill('120');
    await page.getByRole('button', { name: 'KB' }).click();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await Promise.race([
        downloadPromise,
        page.getByText('ERROR', { exact: true }).waitFor().then(async () => {
            throw new Error(await page.locator('.file-status-msg').first().innerText());
        })
    ]);
    expect(download.suggestedFilename()).toBe('browser-video_c.mp4');
    const output = await download.createReadStream();
    const chunks = [];
    for await (const chunk of output) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(120 * 1024);
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
    const playback = await page.evaluate(async (payload) => {
        const blob = new Blob([Uint8Array.from(payload)], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const video = document.createElement('video');
        video.src = url;
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Browser could not decode the generated MP4.'));
        });
        const audioContext = new AudioContext();
        const source = audioContext.createMediaElementSource(video);
        const analyser = audioContext.createAnalyser();
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        await video.play();
        await new Promise(resolve => setTimeout(resolve, 500));
        const frequencies = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(frequencies);
        const result = {
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight,
            audioEnergy: Math.max(...frequencies)
        };
        video.pause();
        await audioContext.close();
        URL.revokeObjectURL(url);
        return result;
    }, Array.from(bytes));
    expect(playback.duration).toBeGreaterThan(1);
    expect(playback.width).toBeGreaterThan(0);
    expect(playback.height).toBeGreaterThan(0);
    expect(playback.audioEnergy).toBeGreaterThan(0);
    await expect(page.getByText('DONE')).toBeVisible();
    expect(pageErrors).toEqual([]);
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
