import { expect } from '@playwright/test';
import { fixture } from './media.js';

export async function uploadFixture(page, { name, mimeType, fixtureName = name }) {
    await page.locator('#file-input').setInputFiles({
        name,
        mimeType,
        buffer: await fixture(fixtureName),
    });
    await expect(page.getByText(name, { exact: true })).toBeVisible();
}

export async function selectTarget(page, value, unit = 'KB') {
    await page.getByLabel('Max Size:').fill(String(value));
    await page.getByRole('button', { name: unit, exact: true }).click();
}

export async function compressAndRead(page) {
    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    const errorPromise = page.getByText('ERROR', { exact: true }).waitFor({ timeout: 120_000 }).then(async () => {
        throw new Error(await page.locator('.file-status-msg').first().innerText());
    });
    await page.getByRole('button', { name: 'COMPRESS' }).click();
    const download = await Promise.race([downloadPromise, errorPromise]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { download, bytes: Buffer.concat(chunks) };
}

export async function observeStatuses(page) {
    await page.evaluate(() => {
        window.__compressionStatuses = [];
        const statusNodes = [...document.querySelectorAll('.file-status-msg')];
        const observer = new MutationObserver(() => {
            window.__compressionStatuses.push(statusNodes.map(node => node.textContent));
        });
        for (const node of statusNodes) observer.observe(node, {
            childList: true, subtree: true, characterData: true,
        });
        window.__compressionStatusObserver = observer;
    });
}

export async function compressionStatuses(page) {
    return page.evaluate(() => {
        window.__compressionStatusObserver?.disconnect();
        return window.__compressionStatuses ?? [];
    });
}

export function statusText(statuses) {
    return statuses.flat().filter(Boolean).join(' | ');
}

export async function forceCompatibilityEngine(page) {
    await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'VideoEncoder', { configurable: true, value: undefined });
        Object.defineProperty(globalThis, 'VideoDecoder', { configurable: true, value: undefined });
    });
}

export async function forceCodecFallback(page, { rejectVideo = true, rejectAudio = false } = {}) {
    await page.addInitScript(({ rejectVideo, rejectAudio }) => {
        const rejectingEncoder = (NativeEncoder, predicate) => {
            if (!NativeEncoder) return null;
            return class FailingEncoder extends NativeEncoder {
                static async isConfigSupported(config) {
                    if (predicate(config)) return { supported: false, config };
                    return NativeEncoder.isConfigSupported(config);
                }
            };
        };

        if (rejectVideo) {
            const FailingVideoEncoder = rejectingEncoder(
                globalThis.VideoEncoder,
                config => config?.codec?.startsWith('avc'),
            );
            if (FailingVideoEncoder) Object.defineProperty(globalThis, 'VideoEncoder', {
                configurable: true,
                value: FailingVideoEncoder,
            });
        }

        if (rejectAudio) {
            const FailingAudioEncoder = rejectingEncoder(
                globalThis.AudioEncoder,
                config => config?.codec?.startsWith('mp4a'),
            );
            if (FailingAudioEncoder) Object.defineProperty(globalThis, 'AudioEncoder', {
                configurable: true,
                value: FailingAudioEncoder,
            });
        }
    }, { rejectVideo, rejectAudio });
}

export async function browserCodecCapability(page) {
    return page.evaluate(async () => {
        if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return false;
        try {
            const result = await VideoEncoder.isConfigSupported({
                codec: 'avc1.64000c', width: 320, height: 180, bitrate: 292_100, framerate: 24,
                hardwareAcceleration: 'prefer-hardware',
            });
            return Boolean(result?.supported);
        } catch {
            return false;
        }
    });
}

export async function skipWithoutBrowserCodec(test, page) {
    if (!(await browserCodecCapability(page))) test.skip(true, 'Runner cannot encode the required H.264 browser codec.');
}
