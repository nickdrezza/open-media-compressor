import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCompressorApp, normalizeError } from '../src/app.js';

const root = process.cwd();
const indexPath = path.join(root, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

function imageFile(name = 'photo.png', size = 10_000) {
    return { name, size, type: 'image/png' };
}

function videoFile(name = 'movie.webm', size = 20_000) {
    return { name, size, type: 'video/webm' };
}

test('page includes expected app title and heading', () => {
    assert.match(html, /<title>Open Media Compressor \| Private Browser-Based Compression<\/title>/);
    assert.match(html, /<h1>Open Media Compressor<\/h1>/);
});

test('page contains upload and compress controls', () => {
    assert.match(html, /id="drop-zone"/);
    assert.match(html, /id="compress-btn"/);
    assert.match(html, /DROP IN FILES OR UPLOAD/);
    assert.match(html, /src="\/src\/app\.js"/);
    assert.match(html, /href="\/src\/styles\.css"/);
});

test('page exposes accessible target controls and status regions', () => {
    assert.match(html, /id="max-size"[^>]*min="0"[^>]*step="any"/);
    assert.match(html, /aria-describedby="target-validation-error"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /:aria-pressed="unit === 'KB'"/);
    assert.match(html, /<progress class="file-progress"/);
    assert.match(html, /role="status" aria-live="polite"/);
});

test('required compression modules exist', () => {
    for (const file of ['src/image_compressor.js', 'src/video_compressor.js']) {
        assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
    }
});

test('factory applies media-specific defaults and formats sub-MB sizes in KB', () => {
    const app = createCompressorApp({ detectFileKind: file => file.type.startsWith('video/') ? 'video' : 'image' });
    app.addFiles([videoFile()]);
    assert.equal(app.maxSize, 20);
    assert.equal(app.unit, 'MB');
    assert.equal(app.formatSize(512 * 1024), '512.00 KB');

    const imageApp = createCompressorApp({ detectFileKind: () => 'image' });
    imageApp.addFiles([imageFile()]);
    assert.equal(imageApp.maxSize, 500);
    assert.equal(imageApp.unit, 'KB');
});

test('invalid targets are rejected before any file row is processed', async () => {
    let compressCalls = 0;
    const app = createCompressorApp({
        detectFileKind: () => 'image',
        compressImage: async () => { compressCalls += 1; return new Blob(['output']); }
    });
    app.addFiles([imageFile()]);
    app.maxSize = 'not-a-number';

    await app.startCompression();

    assert.equal(compressCalls, 0);
    assert.match(app.validationError, /positive finite/);
    assert.equal(app.files[0].status, null);
});

test('target byte overflow is rejected and validation can clear', () => {
    const app = createCompressorApp();
    app.maxSize = Number.MAX_VALUE;
    app.unit = 'MB';
    assert.equal(app.validateTarget(), null);
    assert.match(app.validationError, /invalid target in bytes/);

    app.maxSize = 1;
    assert.equal(app.validateTarget(), 1024 * 1024);
    assert.equal(app.validationError, '');
});

test('compression captures one target and processes appended files sequentially', async () => {
    const targets = [];
    let app;
    const compressor = async (file, targetBytes) => {
        targets.push([file.name, targetBytes]);
        if (targets.length === 1) {
            app.maxSize = 1;
            app.addFiles([imageFile('added-later.png', 15_000)]);
        }
        return new Blob(['output']);
    };
    app = createCompressorApp({ detectFileKind: () => 'image', compressImage: compressor, downloadFile: () => {} });
    app.addFiles([imageFile('first.png', 10_000)]);
    app.maxSize = 10;

    await app.startCompression();

    assert.deepEqual(targets, [['first.png', 10_000], ['added-later.png', 10 * 1024]]);
    assert.deepEqual(app.files.map(file => file.status), ['done', 'done']);
});

test('duplicate compression starts only one run', async () => {
    let calls = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const app = createCompressorApp({
        detectFileKind: () => 'image',
        compressImage: async () => {
            calls += 1;
            await pending;
            return new Blob(['output']);
        },
        downloadFile: () => {}
    });
    app.addFiles([imageFile()]);

    const firstRun = app.startCompression();
    const duplicateRun = app.startCompression();
    release();
    await Promise.all([firstRun, duplicateRun]);

    assert.equal(calls, 1);
});

test('video compression is directly awaited and downloads use the output extension', async () => {
    const downloads = [];
    const statuses = [];
    const app = createCompressorApp({
        detectFileKind: () => 'video',
        compressVideo: async (file, targetBytes, callbacks) => {
            statuses.push([file.name, targetBytes]);
            callbacks.onProgress(50);
            callbacks.onStatus('Encoding MP4...');
            return new Blob(['mp4']);
        },
        downloadFile: (blob, filename) => downloads.push([blob.size, filename])
    });
    app.addFiles([videoFile()]);

    await app.startCompression();

    assert.deepEqual(statuses, [['movie.webm', 20_000]]);
    assert.deepEqual(downloads, [[3, 'movie_c.mp4']]);
    assert.equal(app.files[0].progress, 100);
    assert.equal(app.files[0].status, 'done');
});

test('errors are normalized, logged, and failed files can be retried', async () => {
    const diagnostics = [];
    let calls = 0;
    const app = createCompressorApp({
        detectFileKind: () => 'image',
        diagnosticConsole: { error: (...args) => diagnostics.push(args) },
        compressImage: async () => {
            calls += 1;
            if (calls === 1) throw 'plain string failure';
            return new Blob(['output']);
        },
        downloadFile: () => {}
    });
    app.addFiles([imageFile()]);

    await app.startCompression();
    assert.equal(app.files[0].status, 'error');
    assert.equal(app.files[0].statusMessage, 'plain string failure');
    assert.equal(diagnostics.length, 1);

    await app.startCompression();
    assert.equal(app.files[0].status, 'done');
    assert.equal(calls, 2);
});

test('unknown thrown values receive a stable user-facing message', () => {
    assert.equal(normalizeError(new Error('broken')), 'broken');
    assert.equal(normalizeError('broken'), 'broken');
    assert.equal(normalizeError({ unexpected: true }), 'Compression failed for an unknown reason.');
});
