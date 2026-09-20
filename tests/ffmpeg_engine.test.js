import test from 'node:test';
import assert from 'node:assert/strict';
import { createFFmpegEngine } from '../src/ffmpeg_engine.js';

function createFakeFFmpeg({ load, terminate } = {}) {
    const listeners = new Map();
    const ffmpeg = {
        load: load ?? (async () => {}),
        terminate: terminate ?? (async () => {}),
        on(event, listener) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);
        },
        off(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        listenerCount(event) {
            return listeners.get(event)?.size ?? 0;
        },
        emit(event, payload) {
            for (const listener of listeners.get(event) ?? []) listener(payload);
        }
    };
    return ffmpeg;
}

test('simultaneous callers share one in-flight engine load', async () => {
    let factoryCalls = 0;
    let resolveLoad;
    const ffmpeg = createFakeFFmpeg({ load: () => new Promise(resolve => { resolveLoad = resolve; }) });
    const engine = createFFmpegEngine({ createFFmpeg: () => {
        factoryCalls++;
        return ffmpeg;
    } });

    const first = engine.getFFmpeg();
    const second = engine.getFFmpeg();
    resolveLoad();

    assert.strictEqual(await first, ffmpeg);
    assert.strictEqual(await second, ffmpeg);
    assert.equal(factoryCalls, 1);
});

test('a failed load terminates the failed engine and the next call retries', async () => {
    let factoryCalls = 0;
    let firstTerminations = 0;
    const loadError = new Error('WASM fetch failed');
    const first = createFakeFFmpeg({
        load: async () => { throw loadError; },
        terminate: async () => { firstTerminations++; }
    });
    const second = createFakeFFmpeg();
    const engine = createFFmpegEngine({ createFFmpeg: () => factoryCalls++ === 0 ? first : second });

    await assert.rejects(engine.getFFmpeg(), error => {
        assert.equal(error.message, 'Failed to load the FFmpeg video engine.');
        assert.strictEqual(error.cause, loadError);
        return true;
    });

    assert.equal(firstTerminations, 1);
    assert.strictEqual(await engine.getFFmpeg(), second);
    assert.equal(factoryCalls, 2);
});

test('progress listeners are scoped to each operation and cleaned up on success', async () => {
    const ffmpeg = createFakeFFmpeg();
    const engine = createFFmpegEngine({ createFFmpeg: () => ffmpeg });
    const progress = [];

    assert.equal(ffmpeg.listenerCount('progress'), 0);
    await engine.withFFmpeg({ onProgress: value => progress.push(value) }, async shared => {
        assert.strictEqual(shared, ffmpeg);
        assert.equal(ffmpeg.listenerCount('progress'), 1);
        ffmpeg.emit('progress', { progress: 0.456 });
    });

    assert.deepEqual(progress, [46]);
    assert.equal(ffmpeg.listenerCount('progress'), 0);
});

test('progress listeners are cleaned up when an operation rejects', async () => {
    const ffmpeg = createFakeFFmpeg();
    const engine = createFFmpegEngine({ createFFmpeg: () => ffmpeg });

    await assert.rejects(
        engine.withFFmpeg({}, async () => { throw new Error('operation failed'); }),
        /operation failed/
    );
    assert.equal(ffmpeg.listenerCount('progress'), 0);
    assert.strictEqual(await engine.getFFmpeg(), ffmpeg);
});
