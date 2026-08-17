import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoEncodeArgs, buildVideoPlan, isCompleteMp4, parseDuration } from '../src/video_compressor.js';

test('parseDuration reads FFmpeg probe output', () => {
    assert.equal(parseDuration('Duration: 01:02:03.50, start: 0.000000'), 3723.5);
    assert.equal(parseDuration('no duration here'), null);
});

test('isCompleteMp4 rejects a media payload without a moov index', () => {
    const box = (type, payload = []) => {
        const bytes = new Uint8Array(8 + payload.length);
        new DataView(bytes.buffer).setUint32(0, bytes.length);
        bytes.set([...type].map(char => char.charCodeAt(0)), 4);
        bytes.set(payload, 8);
        return bytes;
    };
    const join = (...parts) => Uint8Array.from(parts.flatMap(part => [...part]));
    assert.equal(isCompleteMp4(join(box('ftyp'), box('mdat', [1, 2, 3]))), false);
    assert.equal(isCompleteMp4(join(box('ftyp'), box('moov'), box('mdat', [1, 2, 3]))), true);
});

test('buildVideoPlan reserves audio and lowers resolution for a tight budget', () => {
    const plan = buildVideoPlan({
        duration: 30,
        targetBytes: 2 * 1024 * 1024,
        width: 1920,
        height: 1080,
        frameRate: 30
    });
    assert.ok(plan.videoBitrate > 0);
    assert.ok(plan.audioBitrate > 0);
    assert.ok(plan.maxHeight <= 480);
});

test('video encode uses one veryfast pass and keeps the target bitrate controls', () => {
    const args = buildVideoEncodeArgs('input.mov', 'output.mp4', {
        frameRate: 30,
        maxHeight: 720,
        videoBitrate: 800_000,
        audioBitrate: 96_000
    });
    assert.equal(args.filter(value => value === '-i').length, 1);
    assert.equal(args.includes('-pass'), false);
    assert.deepEqual(args.slice(args.indexOf('-preset'), args.indexOf('-preset') + 2), ['-preset', 'veryfast']);
    assert.deepEqual(args.slice(args.indexOf('-b:v'), args.indexOf('-b:v') + 2), ['-b:v', '800000']);
});
