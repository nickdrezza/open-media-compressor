import { FFmpeg } from '@ffmpeg/ffmpeg';

const defaultCoreURL = new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', import.meta.url).href;
const defaultWasmURL = new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url).href;

function progressValue(progress) {
    return Math.max(0, Math.min(99, Math.round(progress * 100)));
}

export function createFFmpegEngine({
    createFFmpeg = () => new FFmpeg(),
    coreURL = defaultCoreURL,
    wasmURL = defaultWasmURL
} = {}) {
    let ffmpegPromise;

    function getFFmpeg() {
        if (ffmpegPromise) return ffmpegPromise;

        let promise;
        promise = (async () => {
            let ffmpeg;
            try {
                ffmpeg = createFFmpeg();
                await ffmpeg.load({ coreURL, wasmURL });
                return ffmpeg;
            } catch (error) {
                try {
                    await ffmpeg?.terminate?.();
                } catch {
                    // Preserve the load failure as the actionable error.
                }
                if (ffmpegPromise === promise) ffmpegPromise = undefined;
                throw new Error('Failed to load the FFmpeg video engine.', { cause: error });
            }
        })();
        ffmpegPromise = promise;
        return promise;
    }

    async function withFFmpeg({ onProgress } = {}, operation) {
        if (typeof operation !== 'function') throw new TypeError('An FFmpeg operation is required.');

        const ffmpeg = await getFFmpeg();
        const progressHandler = ({ progress }) => onProgress?.(progressValue(progress));
        ffmpeg.on('progress', progressHandler);
        try {
            return await operation(ffmpeg);
        } finally {
            ffmpeg.off('progress', progressHandler);
        }
    }

    return { getFFmpeg, withFFmpeg };
}

const defaultEngine = createFFmpegEngine();

export const { getFFmpeg, withFFmpeg } = defaultEngine;
