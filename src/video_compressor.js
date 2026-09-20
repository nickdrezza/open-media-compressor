import { fetchFile } from '@ffmpeg/util';
import { getFFmpeg, withFFmpeg } from './ffmpeg_engine.js';
import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    Quality
} from 'mediabunny';

const MIN_VIDEO_BITRATE = 60_000;
const MIN_AUDIO_BITRATE = 64_000;
const MAX_OUTPUT_FRAME_RATE = 30;
const DEFAULT_FRAME_RATE = 30;
export const ACCELERATED_STATUS = 'Using browser video codecs...';
const SUPPORTED_FRAME_RATES = [
    { value: 23.976, aliases: [24000 / 1001] },
    { value: 24 },
    { value: 25 },
    { value: 29.97, aliases: [30000 / 1001] },
    { value: 30 },
    { value: 59.94, aliases: [60000 / 1001] },
    { value: 60 }
];

export class VideoTargetSizeError extends Error {
    constructor(message = 'The requested size is too small for this video duration. Try a larger target.') {
        super(message);
        this.name = 'VideoTargetSizeError';
        this.code = 'VIDEO_TARGET_SIZE_EXHAUSTED';
    }
}

export class VideoTargetLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VideoTargetLimitError';
        this.code = 'VIDEO_TARGET_BELOW_APP_MINIMUM';
    }
}

class AcceleratedEncoderError extends Error {
    constructor(message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AcceleratedEncoderError';
        this.code = 'ACCELERATED_ENCODER_UNAVAILABLE';
    }
}

function normalizeFrameRate(value) {
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_FRAME_RATE;
    const match = SUPPORTED_FRAME_RATES
        .map(rate => ({ rate, difference: Math.min(...[rate.value, ...(rate.aliases ?? [])].map(candidate => Math.abs(value - candidate))) }))
        .filter(candidate => candidate.difference <= 0.04)
        .sort((left, right) => left.difference - right.difference)[0];
    return match?.rate.value ?? Math.min(MAX_OUTPUT_FRAME_RATE, value);
}

function parseFrameRate(value) {
    if (!value) return DEFAULT_FRAME_RATE;
    const [numerator, denominator] = value.split('/').map(Number);
    return normalizeFrameRate(denominator ? numerator / denominator : numerator);
}

function isStreamLine(line, kind) {
    return new RegExp(`Stream #0:\\d+[^:\\n]*:\\s*${kind}:`).test(line);
}

export function parseVideoProbe(logText) {
    const lines = String(logText ?? '').split(/\r?\n/);
    const videoLine = lines.find(line => isStreamLine(line, 'Video'));
    const dimensionMatch = videoLine?.match(/(\d{2,5})x(\d{2,5})(?=\s|,|\[|$)/);
    const frameRateMatch = videoLine?.match(/(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s+fps\b/);

    return {
        width: dimensionMatch ? Number(dimensionMatch[1]) : 1920,
        height: dimensionMatch ? Number(dimensionMatch[2]) : 1080,
        frameRate: parseFrameRate(frameRateMatch?.[1]),
        hasAudio: lines.some(line => isStreamLine(line, 'Audio'))
    };
}

export function selectVideoFrameRate(frameRateMetrics) {
    return normalizeFrameRate(frameRateMetrics?.bestGuessFrameRate);
}

export { getFFmpeg, withFFmpeg };

export function parseDuration(logText) {
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(logText);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function buildVideoPlan({
    duration,
    targetBytes,
    width = 1920,
    height = 1080,
    frameRate = DEFAULT_FRAME_RATE,
    hasAudio = true
}) {
    if (!(duration > 0) || !(targetBytes > 0)) throw new Error('Invalid video duration or target size.');
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        throw new Error('Invalid video dimensions: width and height must be finite positive numbers.');
    }
    const totalBitrate = Math.floor((targetBytes * 8 * 0.965) / duration);
    const audioBitrate = hasAudio
        ? totalBitrate >= 900_000 ? 128_000 : totalBitrate >= 450_000 ? 96_000 : MIN_AUDIO_BITRATE
        : 0;
    const minimumBitrate = MIN_VIDEO_BITRATE + (hasAudio ? MIN_AUDIO_BITRATE : 0);
    if (totalBitrate < minimumBitrate) {
        throw new VideoTargetLimitError(
            `Target size is below the app minimum bitrate policy of ${minimumBitrate} bits per second `
            + `for ${hasAudio ? 'video with audio' : 'silent video'}.`
        );
    }
    const videoBitrate = Math.max(MIN_VIDEO_BITRATE, totalBitrate - audioBitrate);
    const normalizedFrameRate = Math.min(MAX_OUTPUT_FRAME_RATE, normalizeFrameRate(frameRate));
    const bpp = videoBitrate / Math.max(1, width * height * normalizedFrameRate);
    let maxHeight = height;
    if (bpp < 0.025 || videoBitrate < 450_000) maxHeight = Math.min(maxHeight, 360);
    else if (bpp < 0.045 || videoBitrate < 900_000) maxHeight = Math.min(maxHeight, 480);
    else if (bpp < 0.075 || videoBitrate < 2_000_000) maxHeight = Math.min(maxHeight, 720);
    else maxHeight = Math.min(maxHeight, 1080);
    return { audioBitrate, videoBitrate, maxHeight, frameRate: normalizedFrameRate, hasAudio: Boolean(hasAudio) };
}

export function tightenVideoPlan(plan, targetBytes, actualBytes) {
    if (!(actualBytes > targetBytes)) return plan;
    const videoBitrate = Math.max(
        MIN_VIDEO_BITRATE,
        Math.floor(plan.videoBitrate * (targetBytes / actualBytes) * 0.94)
    );
    return videoBitrate < plan.videoBitrate ? { ...plan, videoBitrate } : null;
}

function uniqueName(prefix, extension = '') {
    return `${prefix}-${crypto.randomUUID()}${extension}`;
}

async function probe(ffmpeg, inputName) {
    let logs = '';
    const logger = ({ message }) => { logs += `${message}\n`; };
    ffmpeg.on('log', logger);
    try {
        await ffmpeg.exec(['-i', inputName]);
    } finally {
        ffmpeg.off('log', logger);
    }
    const duration = parseDuration(logs);
    const video = parseVideoProbe(logs);
    if (!duration) throw new Error('Could not read the video duration.');
    return {
        duration,
        ...video
    };
}

export function buildVideoEncodeArgs(inputName, outputName, plan) {
    const frameRate = Math.min(MAX_OUTPUT_FRAME_RATE, normalizeFrameRate(plan.frameRate));
    const videoFilter = `fps=${frameRate},scale=-2:min(${plan.maxHeight}\\,ih):flags=lanczos`;
    const hasAudio = plan.hasAudio !== false;
    const args = ['-i', inputName, '-map', '0:v:0'];
    if (hasAudio) args.push('-map', '0:a:0');
    else args.push('-an');
    args.push('-map_metadata', '-1', '-map_chapters', '-1', '-vf', videoFilter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
        '-b:v', String(plan.videoBitrate), '-maxrate', String(Math.round(plan.videoBitrate * 1.25)),
        '-bufsize', String(plan.videoBitrate * 2));
    if (hasAudio) {
        args.push('-c:a', 'aac', '-b:a', String(plan.audioBitrate), '-ac', '2', '-ar', '48000',
            '-af', 'aresample=async=1:first_pts=0');
    }
    args.push(outputName);
    return args;
}

async function encodeAttempt(ffmpeg, inputName, outputName, plan, onStatus) {
    onStatus?.('Encoding MP4...');
    let recentLogs = [];
    const logger = ({ message }) => { recentLogs = [...recentLogs.slice(-49), message]; };
    ffmpeg.on('log', logger);
    let exitCode;
    try {
        exitCode = await ffmpeg.exec(buildVideoEncodeArgs(inputName, outputName, plan));
    } finally {
        ffmpeg.off('log', logger);
    }
    if (exitCode !== 0) {
        throw new Error(`FFmpeg encode failed with code ${exitCode}: ${recentLogs.join(' ')}`);
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

function canUseAcceleratedEncoder() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

async function compressVideoAccelerated(file, targetBytes, { onProgress, onStatus } = {}) {
    let videoBitrateScale = 1;

    for (let attempt = 0; attempt < 3; attempt++) {
        const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
        let conversion;
        try {
            onStatus?.(attempt === 0 ? 'Analyzing video...' : 'Tightening the bitrate to meet the target size...');
            const videoTrack = await input.getPrimaryVideoTrack();
            const audioTrack = await input.getPrimaryAudioTrack();
            const duration = await input.getDurationFromMetadata();
            if (!videoTrack || !(duration > 0)) throw new Error('Could not read the video metadata.');

            const [width, height, frameRateMetrics] = await Promise.all([
                videoTrack.getDisplayWidth(),
                videoTrack.getDisplayHeight(),
                videoTrack.computeFrameRateMetrics()
            ]);
            const basePlan = buildVideoPlan({
                duration,
                targetBytes,
                width,
                height,
                frameRate: selectVideoFrameRate(frameRateMetrics),
                hasAudio: Boolean(audioTrack)
            });
            const plan = {
                ...basePlan,
                videoBitrate: Math.max(MIN_VIDEO_BITRATE, Math.floor(basePlan.videoBitrate * videoBitrateScale))
            };
            const target = new BufferTarget();
            const output = new Output({
                format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
                target
            });
            conversion = await Conversion.init({
                input,
                output,
                tracks: 'primary',
                video: {
                    codec: 'avc',
                    height: plan.maxHeight,
                    frameRate: plan.frameRate,
                    quality: new Quality({ bitrate: plan.videoBitrate, bitrateMode: 'variable' }),
                    hardwareAcceleration: 'prefer-hardware',
                    keyFrameInterval: 4,
                    forceTranscode: true
                },
                audio: audioTrack ? {
                    codec: 'aac',
                    numberOfChannels: 2,
                    sampleRate: 48_000,
                    quality: new Quality({ bitrate: plan.audioBitrate, bitrateMode: 'variable' }),
                    forceTranscode: true
                } : undefined,
                tags: {}
            });
            const requiredTracks = [videoTrack, ...(audioTrack ? [audioTrack] : [])];
            const missingTracks = requiredTracks.filter(track => !conversion.utilizedTracks.includes(track));
            if (!conversion.isValid || missingTracks.length > 0) {
                const reasons = conversion.discardedTracks.map(track => track.reason).join(', ');
                throw new AcceleratedEncoderError(
                    `This browser cannot hardware-encode the primary ${missingTracks.map(track => track.type).join(' and ')
                    || 'media'} track${reasons ? ` (${reasons})` : ''}.`
                );
            }

            onStatus?.(ACCELERATED_STATUS);
            conversion.onProgress = progress => onProgress?.(Math.max(0, Math.min(99, Math.round(progress * 100))));
            await conversion.execute();
            if (!target.buffer) throw new Error('The accelerated encoder produced no output.');

            const bytes = new Uint8Array(target.buffer);
            if (!isCompleteMp4(bytes)) throw new Error('The accelerated encoder produced an incomplete MP4.');
            const blob = new Blob([bytes], { type: 'video/mp4' });
            if (blob.size <= targetBytes) {
                onProgress?.(100);
                return blob;
            }
            const nextPlan = tightenVideoPlan(plan, targetBytes, blob.size);
            if (!nextPlan) throw new VideoTargetSizeError();
            videoBitrateScale = nextPlan.videoBitrate / basePlan.videoBitrate;
        } finally {
            if (conversion && conversion.state !== 'done' && conversion.state !== 'canceled') {
                await conversion.cancel().catch(() => {});
            }
            try {
                input.dispose();
            } catch {
                // Cleanup must not replace the encoding or target-size error.
            }
        }
    }

    throw new VideoTargetSizeError();
}

export async function compressVideo(file, targetBytes, { onProgress, onStatus } = {}) {
    if (canUseAcceleratedEncoder()) {
        try {
            return await compressVideoAccelerated(file, targetBytes, { onProgress, onStatus });
        } catch (error) {
            if (
                error instanceof VideoTargetSizeError
                || error instanceof VideoTargetLimitError
                || error?.code === 'VIDEO_TARGET_SIZE_EXHAUSTED'
                || error?.code === 'VIDEO_TARGET_BELOW_APP_MINIMUM'
            ) throw error;
            console.warn('Hardware-accelerated encoding unavailable; using FFmpeg fallback.', error);
            onProgress?.(0);
            onStatus?.('Hardware acceleration unavailable; using the compatibility video engine...');
        }
    }

    onStatus?.('Loading the video engine...');
    const extension = file.name.includes('.') ? `.${file.name.split('.').pop().toLowerCase()}` : '';
    const inputName = uniqueName('input', extension);
    const outputName = uniqueName('output', '.mp4');
    const cleanup = new Set([inputName, outputName]);

    return withFFmpeg({ onProgress }, async ffmpeg => {
        try {
            await ffmpeg.writeFile(inputName, await fetchFile(file));
            onStatus?.('Analyzing video...');
            const metadata = await probe(ffmpeg, inputName);
            let plan = buildVideoPlan({ ...metadata, targetBytes });

            for (let attempt = 0; attempt < 3; attempt++) {
                await encodeAttempt(ffmpeg, inputName, outputName, plan, onStatus);
                const data = await ffmpeg.readFile(outputName);
                if (!isCompleteMp4(data)) throw new Error('FFmpeg produced an incomplete MP4 container.');
                const blob = new Blob([data], { type: 'video/mp4' });
                if (blob.size <= targetBytes) {
                    onProgress?.(100);
                    return blob;
                }
                const nextPlan = tightenVideoPlan(plan, targetBytes, blob.size);
                if (!nextPlan) throw new VideoTargetSizeError();
                plan = nextPlan;
                onStatus?.('Tightening the bitrate to meet the target size...');
                await ffmpeg.deleteFile(outputName).catch(() => {});
            }

            throw new VideoTargetSizeError();
        } finally {
            for (const name of cleanup) await ffmpeg.deleteFile(name).catch(() => {});
        }
    });
}
