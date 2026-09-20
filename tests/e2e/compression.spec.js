import { test, expect } from '@playwright/test';
import {
    assertNoUnexpectedNetwork,
    fixture,
    frameRate,
    hasQuarterTurn,
    primaryAudio,
    primaryVideo,
    probeMedia,
    readDownloadBytes,
    recordNetwork,
    streamDuration,
} from './support/media.js';
import {
    compressAndRead,
    compressionStatuses,
    forceCodecFallback,
    forceCompatibilityEngine,
    observeStatuses,
    selectTarget,
    skipWithoutBrowserCodec,
    statusText,
    uploadFixture,
} from './support/app.js';

function makeSvgFixture() {
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

test('uploads, compresses, and downloads a deterministic SVG within the effective cap', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
        name: 'browser-fixture.svg',
        mimeType: 'image/svg+xml',
        buffer: makeSvgFixture(),
    });
    await selectTarget(page, 20);

    const { download, bytes } = await compressAndRead(page);
    expect(download.suggestedFilename()).toBe('browser-fixture_c.jpg');
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(20 * 1024);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(page.getByText('DONE')).toBeVisible();
});

test('uploads, compresses, and downloads a deterministic image within the effective cap', async ({ page }) => {
    const requests = recordNetwork(page);
    await page.goto('/');
    await uploadFixture(page, { name: 'transparent.png', mimeType: 'image/png' });
    await selectTarget(page, 80);

    const { download, bytes } = await compressAndRead(page);
    expect(download.suggestedFilename()).toBe('transparent_c.jpg');
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(80 * 1024);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(page.getByText('DONE')).toBeVisible();
    await assertNoUnexpectedNetwork(requests, page);
});

test('flattens transparent pixels onto white and emits a decodable JPEG', async ({ page }) => {
    await page.goto('/');
    await uploadFixture(page, { name: 'transparent.png', mimeType: 'image/png' });
    const { bytes } = await compressAndRead(page);
    const corner = await page.evaluate(async payload => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(payload)], { type: 'image/jpeg' }));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return [...context.getImageData(0, 0, 1, 1).data];
    }, [...bytes]);
    expect(corner[0]).toBeGreaterThan(245);
    expect(corner[1]).toBeGreaterThan(245);
    expect(corner[2]).toBeGreaterThan(245);
    expect(corner[3]).toBe(255);
});

test('decodes a deterministic TIFF through the image fallback and outputs JPEG', async ({ page }) => {
    await page.goto('/');
    await uploadFixture(page, { name: 'photo.tiff', mimeType: 'image/tiff' });
    const { download, bytes } = await compressAndRead(page);
    expect(download.suggestedFilename()).toBe('photo_c.jpg');
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(500 * 1024);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(page.getByText('DONE')).toBeVisible();
});

test('handles mixed success, malformed error, and success rows with two downloads', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles([
        { name: 'first.png', mimeType: 'image/png', buffer: await fixture('transparent.png') },
        { name: 'malformed.mp4', mimeType: 'video/mp4', buffer: await fixture('malformed.mp4') },
        { name: 'last.tiff', mimeType: 'image/tiff', buffer: await fixture('photo.tiff') },
    ]);
    await selectTarget(page, 80);
    const downloads = [];
    page.on('download', download => downloads.push(download));
    await page.getByRole('button', { name: 'COMPRESS' }).click();

    await expect(page.locator('.file-item.done')).toHaveCount(2, { timeout: 180_000 });
    await expect(page.locator('.file-item.error')).toHaveCount(1);
    expect(downloads.map(download => download.suggestedFilename())).toEqual(['first_c.jpg', 'last_c.jpg']);
    for (const download of downloads) expect((await readDownloadBytes(download)).length).toBeGreaterThan(0);
});

test('reports unsupported and empty input instead of producing a download', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
        name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not media'),
    });
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    await expect(page.getByText('ERROR')).toBeVisible();
    await expect(page.getByText(/Format not supported/)).toBeVisible();

    await page.getByRole('button', { name: 'Upload more' }).click();
    await page.locator('#file-input').setInputFiles({
        name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0),
    });
    await expect(page.getByText('empty.png')).toBeVisible();
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    await expect(page.locator('.file-item.error')).toHaveCount(2);
});

test('forced FFmpeg compatibility produces a real audio-bearing MP4 and strips source metadata', async ({ page }) => {
    test.setTimeout(180_000);
    await forceCompatibilityEngine(page);
    const requests = recordNetwork(page);
    await page.goto('/');
    await uploadFixture(page, { name: 'audio-24fps.webm', mimeType: 'video/webm' });
    await selectTarget(page, 160);
    await observeStatuses(page);
    const { download, bytes } = await compressAndRead(page);
    const statuses = await compressionStatuses(page);
    const text = statusText(statuses);

    expect(download.suggestedFilename()).toBe('audio-24fps_c.mp4');
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
    expect(bytes.length).toBeLessThanOrEqual(160 * 1024);
    expect(text).toContain('Encoding MP4...');
    expect(text).not.toContain('Using browser video codecs...');
    const probe = await probeMedia(bytes);
    test.skip(!probe, 'ffprobe is unavailable; container-level media assertions skipped.');
    const video = primaryVideo(probe);
    const audio = primaryAudio(probe);
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();
    expect(frameRate(video)).toBeCloseTo(24, 1);
    expect(streamDuration(video, probe)).toBeCloseTo(2.4, 0);
    expect(streamDuration(audio, probe)).toBeCloseTo(2.4, 0);
    expect(JSON.stringify(probe)).not.toContain('omc-l6-source-marker');
    expect(probe.chapters ?? []).toHaveLength(0);
    await assertNoUnexpectedNetwork(requests, page);
});

test('real browser-codec success stays on the browser path when H.264 encode is available', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await skipWithoutBrowserCodec(test, page);
    const requests = recordNetwork(page);
    await uploadFixture(page, { name: 'audio-24fps.webm', mimeType: 'video/webm' });
    await selectTarget(page, 160);
    await observeStatuses(page);
    const { download, bytes } = await compressAndRead(page);
    const statuses = await compressionStatuses(page);
    const text = statusText(statuses);

    expect(download.suggestedFilename()).toBe('audio-24fps_c.mp4');
    expect(bytes.length).toBeLessThanOrEqual(160 * 1024);
    expect(text).toContain('Using browser video codecs...');
    expect(text).not.toContain('compatibility video engine');
    const videoAssets = requests.filter(request => /ffmpeg_engine|ffmpeg-core|worker-|\.wasm$/.test(request.url()));
    expect(videoAssets).toEqual([]);
    const probe = await probeMedia(bytes);
    test.skip(!probe, 'ffprobe is unavailable; container-level media assertions skipped.');
    expect(primaryVideo(probe)).toBeTruthy();
    expect(primaryAudio(probe)).toBeTruthy();
    expect(frameRate(primaryVideo(probe))).toBeCloseTo(24, 1);
    await assertNoUnexpectedNetwork(requests, page);
});

test('automatic unsupported AAC and video fallback preserves the primary tracks', async ({ page }) => {
    test.setTimeout(180_000);
    await forceCodecFallback(page, { rejectAudio: true });
    await page.goto('/');
    const requests = recordNetwork(page);
    await uploadFixture(page, { name: 'audio-24fps.webm', mimeType: 'video/webm' });
    await selectTarget(page, 160);
    await observeStatuses(page);
    const { bytes } = await compressAndRead(page);
    const text = statusText(await compressionStatuses(page));
    expect(text).toContain('Encoding MP4...');
    expect(requests.some(request => /ffmpeg_engine|ffmpeg-core|\.wasm$/.test(request.url()))).toBe(true);
    const probe = await probeMedia(bytes);
    test.skip(!probe, 'ffprobe is unavailable; container-level media assertions skipped.');
    expect(primaryVideo(probe)).toBeTruthy();
    expect(primaryAudio(probe)).toBeTruthy();
});

test('fallback preserves silent rotated portrait video, frame rate, duration, and no audio', async ({ page }) => {
    test.setTimeout(180_000);
    await forceCompatibilityEngine(page);
    await page.goto('/');
    const input = await fixture('silent-29.97fps-rotated.mp4');
    await uploadFixture(page, { name: 'silent-29.97fps-rotated.mp4', mimeType: 'video/mp4' });
    await selectTarget(page, 160);
    await expect(page.getByLabel('Max Size:')).toHaveValue('160');
    await expect(page.getByRole('button', { name: 'KB', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const { bytes } = await compressAndRead(page);
    const sourceProbe = await probeMedia(input);
    expect(bytes.length).toBeLessThanOrEqual(160 * 1024);
    const outputProbe = await probeMedia(bytes);
    test.skip(!sourceProbe || !outputProbe, 'ffprobe is unavailable; media geometry assertions skipped.');
    const sourceVideo = primaryVideo(sourceProbe);
    const outputVideo = primaryVideo(outputProbe);
    expect(outputVideo).toBeTruthy();
    expect(primaryAudio(outputProbe)).toBeNull();
    expect(frameRate(outputVideo)).toBeCloseTo(frameRate(sourceVideo), 0);
    expect(streamDuration(outputVideo, outputProbe)).toBeCloseTo(streamDuration(sourceVideo, sourceProbe), 0);
    expect(outputVideo.height).toBeGreaterThan(outputVideo.width);
    expect(Number(outputVideo.height) / Number(outputVideo.width)).toBeCloseTo(4 / 3, 1);
    expect(hasQuarterTurn(outputVideo)).toBe(false);
    expect(JSON.stringify(outputProbe)).not.toContain('omc-l6-source-marker');
    expect(outputProbe.chapters ?? []).toHaveLength(0);
});

test('the synchronized synthetic audio/visual event survives video fallback', async ({ page }) => {
    test.setTimeout(180_000);
    await forceCompatibilityEngine(page);
    await page.goto('/');
    await uploadFixture(page, { name: 'audio-24fps.webm', mimeType: 'video/webm' });
    await selectTarget(page, 160);
    const { bytes } = await compressAndRead(page);
    const event = await page.evaluate(async payload => {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(new Blob([Uint8Array.from(payload)], { type: 'video/mp4' }));
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Generated MP4 did not decode.'));
        });
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        const audioContext = new AudioContext();
        const source = audioContext.createMediaElementSource(video);
        const analyser = audioContext.createAnalyser();
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        const sample = async time => {
            video.currentTime = time;
            await new Promise(resolve => { video.onseeked = resolve; });
            context.drawImage(video, 0, 0);
            const pixels = context.getImageData(Math.floor(video.videoWidth / 2), Math.floor(video.videoHeight / 2), 1, 1).data;
            await video.play();
            await new Promise(resolve => setTimeout(resolve, 100));
            const frequencies = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(frequencies);
            video.pause();
            return { pixel: [...pixels], audioEnergy: Math.max(...frequencies) };
        };
        const before = await sample(0.4);
        const eventSample = await sample(1.0);
        video.pause();
        await audioContext.close();
        URL.revokeObjectURL(video.src);
        return { before, event: eventSample };
    }, [...bytes]);
    expect(event.event.pixel[0]).toBeGreaterThan(235);
    expect(event.event.pixel[1]).toBeGreaterThan(235);
    expect(event.event.pixel[2]).toBeGreaterThan(235);
    expect(event.before.pixel[0] + event.before.pixel[1] + event.before.pixel[2]).toBeLessThan(650);
    expect(event.event.audioEnergy).toBeGreaterThan(event.before.audioEnergy + 10);
});
