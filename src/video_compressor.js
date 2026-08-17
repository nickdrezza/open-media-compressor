import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const coreURL = new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', import.meta.url).href;
const wasmURL = new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url).href;
const MIN_VIDEO_BITRATE = 60_000;

let ffmpegPromise;
let activeProgressHandler;

export async function getFFmpeg(onProgress) {
    if (!ffmpegPromise) {
        ffmpegPromise = (async () => {
            const ffmpeg = new FFmpeg();
            await ffmpeg.load({ coreURL, wasmURL });
            return ffmpeg;
        })();
    }
    const ffmpeg = await ffmpegPromise;
    if (activeProgressHandler) ffmpeg.off('progress', activeProgressHandler);
    activeProgressHandler = ({ progress }) => onProgress?.(Math.max(0, Math.min(99, Math.round(progress * 100))));
    ffmpeg.on('progress', activeProgressHandler);
    return ffmpeg;
}

export function parseDuration(logText) {
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(logText);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function buildVideoPlan({ duration, targetBytes, width = 1920, height = 1080, frameRate = 30 }) {
    if (!(duration > 0) || !(targetBytes > 0)) throw new Error('Invalid video duration or target size.');
    const totalBitrate = Math.floor((targetBytes * 8 * 0.965) / duration);
    const audioBitrate = totalBitrate >= 900_000 ? 128_000 : totalBitrate >= 450_000 ? 96_000 : 64_000;
    const videoBitrate = Math.max(MIN_VIDEO_BITRATE, totalBitrate - audioBitrate);
    const bpp = videoBitrate / Math.max(1, width * height * frameRate);
    let maxHeight = height;
    if (bpp < 0.025 || videoBitrate < 450_000) maxHeight = Math.min(maxHeight, 360);
    else if (bpp < 0.045 || videoBitrate < 900_000) maxHeight = Math.min(maxHeight, 480);
    else if (bpp < 0.075 || videoBitrate < 2_000_000) maxHeight = Math.min(maxHeight, 720);
    else maxHeight = Math.min(maxHeight, 1080);
    return { audioBitrate, videoBitrate, maxHeight, frameRate: Math.max(1, Math.min(30, frameRate || 30)) };
}

function uniqueName(prefix, extension = '') {
    return `${prefix}-${crypto.randomUUID()}${extension}`;
}

async function probe(ffmpeg, inputName) {
    let logs = '';
    const logger = ({ message }) => { logs += `${message}\n`; };
    ffmpeg.on('log', logger);
    await ffmpeg.exec(['-i', inputName]);
    ffmpeg.off('log', logger);
    const duration = parseDuration(logs);
    const videoMatch = /(\d{2,5})x(\d{2,5})[^\n]*(\d+(?:\.\d+)?) fps/.exec(logs);
    if (!duration) throw new Error('Could not read the video duration.');
    return {
        duration,
        width: videoMatch ? Number(videoMatch[1]) : 1920,
        height: videoMatch ? Number(videoMatch[2]) : 1080,
        frameRate: videoMatch ? Number(videoMatch[3]) : 30
    };
}

async function encodeAttempt(ffmpeg, inputName, outputName, plan, passLog, onStatus) {
    const videoFilter = `fps=${plan.frameRate},scale=-2:min(${plan.maxHeight}\\,ih):flags=lanczos`;
    const common = ['-i', inputName, '-map_metadata', '-1', '-map_chapters', '-1', '-vf', videoFilter,
        '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
        '-b:v', String(plan.videoBitrate), '-maxrate', String(Math.round(plan.videoBitrate * 1.25)),
        '-bufsize', String(plan.videoBitrate * 2)];

    onStatus?.('Optimizing video quality (pass 1 of 2)...');
    const firstPassCode = await ffmpeg.exec([...common, '-an', '-pass', '1', '-passlogfile', passLog, '-f', 'null', '-']);
    if (firstPassCode !== 0) throw new Error(`FFmpeg first pass failed with code ${firstPassCode}.`);
    onStatus?.('Encoding MP4 (pass 2 of 2)...');
    let recentLogs = [];
    const logger = ({ message }) => { recentLogs = [...recentLogs.slice(-49), message]; };
    ffmpeg.on('log', logger);
    const secondPassCode = await ffmpeg.exec([...common, '-pass', '2', '-passlogfile', passLog,
        '-c:a', 'aac', '-b:a', String(plan.audioBitrate), '-ac', '2', '-ar', '48000',
        '-af', 'aresample=async=1:first_pts=0', outputName]);
    ffmpeg.off('log', logger);
    if (secondPassCode !== 0) {
        throw new Error(`FFmpeg final encode failed with code ${secondPassCode}: ${recentLogs.join(' ')}`);
    }
}

export function isCompleteMp4(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let offset = 0;
    let hasFtyp = false;
    let hasMoov = false;
    let hasMdat = false;
    while (offset + 8 <= bytes.byteLength) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
        let size = view.getUint32(0);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > bytes.byteLength) return false;
            size = Number(view.getBigUint64(8));
            headerSize = 16;
        } else if (size === 0) {
            size = bytes.byteLength - offset;
        }
        if (size < headerSize || offset + size > bytes.byteLength) return false;
        if (type === 'ftyp') hasFtyp = true;
        if (type === 'moov') hasMoov = true;
        if (type === 'mdat') hasMdat = true;
        offset += size;
    }
    return offset === bytes.byteLength && hasFtyp && hasMoov && hasMdat;
}

export async function compressVideo(file, targetBytes, { onProgress, onStatus } = {}) {
    onStatus?.('Loading the video engine...');
    const ffmpeg = await getFFmpeg(onProgress);
    const extension = file.name.includes('.') ? `.${file.name.split('.').pop().toLowerCase()}` : '';
    const inputName = uniqueName('input', extension);
    const outputName = uniqueName('output', '.mp4');
    const passLog = uniqueName('passlog');
    const cleanup = new Set([inputName, outputName, `${passLog}-0.log`, `${passLog}-0.log.mbtree`]);

    try {
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        onStatus?.('Analyzing video...');
        const metadata = await probe(ffmpeg, inputName);
        let plan = buildVideoPlan({ ...metadata, targetBytes });

        for (let attempt = 0; attempt < 3; attempt++) {
            await encodeAttempt(ffmpeg, inputName, outputName, plan, passLog, onStatus);
            const data = await ffmpeg.readFile(outputName);
            if (!isCompleteMp4(data)) throw new Error('FFmpeg produced an incomplete MP4 container.');
            const blob = new Blob([data.buffer], { type: 'video/mp4' });
            if (blob.size <= targetBytes) {
                onProgress?.(100);
                return blob;
            }
            plan = {
                ...plan,
                videoBitrate: Math.max(MIN_VIDEO_BITRATE, Math.floor(plan.videoBitrate * (targetBytes / blob.size) * 0.94))
            };
            onStatus?.('Tightening the bitrate to meet the target size...');
            await ffmpeg.deleteFile(outputName).catch(() => {});
        }

        throw new Error('The requested size is too small for this video duration. Try a larger target.');
    } finally {
        for (const name of cleanup) await ffmpeg.deleteFile(name).catch(() => {});
    }
}
