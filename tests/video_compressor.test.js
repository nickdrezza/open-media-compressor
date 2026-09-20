import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildVideoEncodeArgs,
    buildVideoPlan,
    isCompleteMp4,
    parseDuration,
    parseVideoProbe,
    selectVideoFrameRate,
    tightenVideoPlan
} from '../src/video_compressor.js';

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

test('parseVideoProbe reads the primary video stream and common frame rates', () => {
    const rates = [
        ['23.976', 23.976],
        ['24000/1001', 23.976],
        ['24', 24],
        ['25', 25],
        ['29.97', 29.97],
        ['30000/1001', 29.97],
        ['30', 30],
        ['59.94', 59.94],
        ['60000/1001', 59.94],
        ['60', 60]
    ];
    for (const [rateText, expectedRate] of rates) {
        const probe = parseVideoProbe([
            'Stream #0:0: Video: h264, yuv420p, 640x360 [SAR 1:1 DAR 16:9], 23 kb/s, 12 fps',
            `Stream #0:1: Audio: aac, 48000 Hz, stereo, 96 kb/s`,
            `Stream #0:2: Video: h264, yuv420p, 3840x2160, ${rateText} fps`
        ].join('\n').replace('12 fps', `${rateText} fps`));
        assert.deepEqual(probe, { width: 640, height: 360, frameRate: expectedRate, hasAudio: true });
    }
});

test('parseVideoProbe falls back to safe dimensions and 30 fps', () => {
    assert.deepEqual(parseVideoProbe('Stream #0:0: Video: h264, yuv420p, 3840x2160, 48 fps'), {
        width: 3840,
        height: 2160,
        frameRate: 30,
        hasAudio: false
    });
    assert.deepEqual(parseVideoProbe('Duration: 00:00:10.00'), {
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: false
    });
});

test('video planning and FFmpeg mapping omit audio when the primary stream has none', () => {
    const plan = buildVideoPlan({ duration: 30, targetBytes: 2 * 1024 * 1024, hasAudio: false });
    assert.equal(plan.audioBitrate, 0);
    assert.equal(plan.hasAudio, false);
    const args = buildVideoEncodeArgs('input.mp4', 'output.mp4', { ...plan, maxHeight: 720 });
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map_metadata')), ['-map', '0:v:0', '-an']);
    assert.equal(args.includes('-c:a'), false);
});

test('accelerated frame-rate selection uses Mediabunny metrics and preserves supported rates', () => {
    assert.equal(selectVideoFrameRate({ bestGuessFrameRate: 59.94005994 }), 59.94);
    assert.equal(selectVideoFrameRate({ bestGuessFrameRate: 48 }), 30);
});

test('tightening stops when the bitrate floor cannot shrink further', () => {
    const plan = { videoBitrate: 60_000, audioBitrate: 0, hasAudio: false };
    assert.equal(tightenVideoPlan(plan, 1000, 2000), null);
    assert.equal(tightenVideoPlan({ ...plan, videoBitrate: 800_000 }, 1000, 2000).videoBitrate, 376_000);
});

test('video encode uses one veryfast pass and keeps the target bitrate controls', () => {
    const args = buildVideoEncodeArgs('input.mov', 'output.mp4', {
        frameRate: 30,
        maxHeight: 720,
        videoBitrate: 800_000,
        audioBitrate: 96_000
    });
    assert.equal(args.filter(value => value === '-i').length, 1);
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map_metadata')), ['-map', '0:v:0', '-map', '0:a:0']);
    assert.equal(args.includes('-pass'), false);
    assert.deepEqual(args.slice(args.indexOf('-preset'), args.indexOf('-preset') + 2), ['-preset', 'veryfast']);
    assert.deepEqual(args.slice(args.indexOf('-b:v'), args.indexOf('-b:v') + 2), ['-b:v', '800000']);
});
