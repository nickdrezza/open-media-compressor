import test from 'node:test';
import assert from 'node:assert/strict';
import { compressImage } from '../src/image_compressor.js';

function namedBlob(bytes, name, type = 'image/png') {
    const file = new Blob([bytes], { type });
    Object.defineProperty(file, 'name', { value: name });
    return file;
}

async function withBrowserStubs({ width = 1000, height = 500, decode = 'success', sizeFor, run }) {
    const originalImage = globalThis.Image;
    const originalDocument = globalThis.document;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const objectUrls = [];
    const revokedUrls = [];
    const calls = [];
    const canvases = [];

    Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: file => {
            const url = `blob:fixture-${file.name}`;
            objectUrls.push(url);
            return url;
        }
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: url => revokedUrls.push(url)
    });

    globalThis.Image = class FakeImage {
        naturalWidth = width;
        naturalHeight = height;
        width;
        height;
        onload = null;
        onerror = null;
        _src = '';

        set src(value) {
            this._src = value;
            if (!value) return;
            queueMicrotask(() => {
                if (decode === 'success') this.onload?.();
                else this.onerror?.();
            });
        }

        get src() {
            return this._src;
        }
    };

    globalThis.document = {
        createElement(type) {
            assert.equal(type, 'canvas');
            const canvas = {
                width: 0,
                height: 0,
                getContext() {
                    return {
                        imageSmoothingEnabled: false,
                        imageSmoothingQuality: 'low',
                        fillStyle: '',
                        fillRect() {},
                        drawImage() {}
                    };
                },
                toBlob(callback, mimeType, quality) {
                    const call = { width: this.width, height: this.height, mimeType, quality };
                    calls.push(call);
                    const size = sizeFor(call);
                    callback(new Blob([new Uint8Array(size)], { type: mimeType }));
                }
            };
            canvases.push(canvas);
            return canvas;
        }
    };

    try {
        return await run({ calls, canvases, objectUrls, revokedUrls });
    } finally {
        if (originalImage === undefined) delete globalThis.Image;
        else globalThis.Image = originalImage;
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL });
    }
}

test('validates target and rejects empty input before touching browser APIs', async () => {
    await assert.rejects(
        compressImage(namedBlob([], 'empty.png'), 1000),
        /Image file "empty\.png" is empty/
    );
    await assert.rejects(
        compressImage(namedBlob([1], 'bad-target.png'), Number.NaN),
        /Target size for "bad-target\.png" must be a positive finite number/
    );
});

test('probes maximum native quality first and stops without a quality search when it fits', async () => {
    const result = await withBrowserStubs({
        sizeFor: () => 800,
        run: async state => {
            const blob = await compressImage(namedBlob([1], 'small.png'), 1000);
            assert.equal(blob.size, 800);
            assert.deepEqual(state.calls.map(call => call.quality), [0.96]);
            assert.deepEqual(state.revokedUrls, ['blob:fixture-small.png']);
            assert.equal(state.canvases[0].width, 0);
            return blob;
        }
    });
    assert.equal(result.type, 'image/jpeg');
});

test('resizes directly when minimum native quality is too large and preserves aspect ratio', async () => {
    await withBrowserStubs({
        sizeFor: ({ width, height }) => Math.ceil(width * height / 250),
        run: async state => {
            const blob = await compressImage(namedBlob([1], 'large.png'), 1000);
            assert.ok(blob.size <= 1000);
            assert.deepEqual(state.calls.map(call => call.quality), [0.96, 0.02, 0.96]);
            const [initial, resized] = [state.calls[0], state.calls[2]];
            assert.equal(initial.width / initial.height, 2);
            assert.equal(resized.width / resized.height, 2);
            assert.deepEqual(state.revokedUrls, ['blob:fixture-large.png']);
        }
    });
});

test('does not re-test native quality candidates during bounded search', async () => {
    await withBrowserStubs({
        sizeFor: ({ quality }) => 100 + Math.round(quality * 1000),
        run: async state => {
            const blob = await compressImage(namedBlob([1], 'search.png'), 600);
            const qualities = state.calls.map(call => call.quality);
            assert.ok(blob.size <= 600);
            assert.equal(new Set(qualities).size, qualities.length);
            assert.deepEqual(qualities.slice(0, 2), [0.96, 0.02]);
        }
    });
});

test('uses FFmpeg qscale in maximum-to-minimum order and preserves typed-array views', async () => {
    const originalImage = globalThis.Image;
    const originalFileReader = globalThis.FileReader;
    const qScales = [];
    const deleted = [];
    let activeLogger;
    let outputSize = 0;
    const ffmpeg = {
        async writeFile() {},
        async deleteFile(name) { deleted.push(name); },
        on(event, listener) { if (event === 'log') activeLogger = listener; },
        off(event, listener) { if (event === 'log' && activeLogger === listener) activeLogger = null; },
        async exec(args) {
            if (!args.includes('-q:v')) {
                activeLogger?.({ message: 'Stream #0:0: Video: png, 100x50' });
                return 0;
            }
            const qScale = Number(args[args.indexOf('-q:v') + 1]);
            qScales.push(qScale);
            outputSize = 400 + (31 - qScale) * 20;
            return 0;
        },
        async readFile() {
            const backing = new Uint8Array(outputSize + 4);
            return backing.subarray(2, 2 + outputSize);
        }
    };

    globalThis.Image = class CorruptImage {
        set src(value) {
            if (value) queueMicrotask(() => this.onerror?.());
        }
        onload = null;
        onerror = null;
    };
    globalThis.FileReader = class FakeFileReader {
        result = null;
        onload = null;
        onerror = null;

        readAsArrayBuffer(blob) {
            blob.arrayBuffer().then(result => {
                this.result = result;
                this.onload?.();
            }, error => this.onerror?.({ target: { error } }));
        }
    };

    try {
        const blob = await compressImage(
            namedBlob([1, 2, 3], 'camera.tiff', 'image/tiff'),
            600,
            { withFFmpegRunner: async (_, operation) => operation(ffmpeg) }
        );
        assert.equal(blob.size, 600);
        assert.deepEqual(qScales.slice(0, 2), [2, 31]);
        assert.equal(new Set(qScales).size, qScales.length);
        assert.ok(qScales.includes(21));
        assert.equal(qScales.at(-1), 20);
        assert.equal(deleted.length, 2);
    } finally {
        if (originalImage === undefined) delete globalThis.Image;
        else globalThis.Image = originalImage;
        if (originalFileReader === undefined) delete globalThis.FileReader;
        else globalThis.FileReader = originalFileReader;
    }
});

test('rejects an empty native encoder result and still cleans URL and canvas state', async () => {
    await assert.rejects(
        withBrowserStubs({
            sizeFor: () => 0,
            run: async state => compressImage(namedBlob([1], 'empty-output.png'), 1000)
                .catch(error => {
                    assert.match(error.message, /empty JPEG for "empty-output\.png"/);
                    assert.deepEqual(state.revokedUrls, ['blob:fixture-empty-output.png']);
                    assert.equal(state.canvases[0].width, 0);
                    throw error;
                })
        }),
        /empty JPEG for "empty-output\.png"/
    );
});
