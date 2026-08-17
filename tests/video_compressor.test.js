import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoPlan, parseDuration } from '../src/video_compressor.js';

test('parseDuration reads FFmpeg probe output', () => {
    assert.equal(parseDuration('Duration: 01:02:03.50, start: 0.000000'), 3723.5);
    assert.equal(parseDuration('no duration here'), null);
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
