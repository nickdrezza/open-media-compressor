import test from 'node:test';
import assert from 'node:assert/strict';

import {
    detectFileKind,
    getUnsupportedFileMessage
} from '../src/file_types.js';

function file({ name, type = '' }) {
    return { name, type };
}

test('detectFileKind accepts common video containers', () => {
    const supportedFiles = [
        file({ name: 'clip.mp4', type: 'video/mp4' }),
        file({ name: 'clip.mov', type: 'video/quicktime' }),
        file({ name: 'clip.m4v', type: 'video/x-m4v' }),
        file({ name: 'camera-upload.MP4' }),
        file({ name: 'screen.webm', type: 'video/webm' }),
        file({ name: 'capture.mkv', type: 'video/x-matroska' }),
        file({ name: 'legacy.avi', type: 'video/x-msvideo' }),
        file({ name: 'windows.wmv', type: 'video/x-ms-wmv' }),
        file({ name: 'flash.flv', type: 'video/x-flv' })
    ];

    for (const supportedFile of supportedFiles) {
        assert.equal(detectFileKind(supportedFile), 'video', supportedFile.name);
    }
});

test('detectFileKind supports image extension fallbacks and rejects non-media', () => {
    assert.equal(detectFileKind(file({ name: 'animation.gif' })), 'image');
    assert.equal(detectFileKind(file({ name: 'photo.jpeg' })), 'image');
    assert.equal(detectFileKind(file({ name: 'graphic.webp' })), 'image');
    const text = file({ name: 'notes.txt', type: 'text/plain' });
    assert.equal(detectFileKind(text), 'unsupported');
    assert.match(getUnsupportedFileMessage(text), /photos and videos only/);
});
