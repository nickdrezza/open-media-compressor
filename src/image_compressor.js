import { fetchFile } from '@ffmpeg/util';
import { withFFmpeg } from './ffmpeg_engine.js';

const OUTPUT_TYPE = 'image/jpeg';
const MIN_QUALITY = 0.02;
const MAX_QUALITY = 0.96;
const MIN_QSCALE = 2;
const MAX_QSCALE = 31;
const NATIVE_RESIZE_LIMIT = 12;
const FFMPEG_RESIZE_LIMIT = 10;
const QUALITY_SEARCH_LIMIT = 9;

function sourceName(file) {
    return typeof file?.name === 'string' && file.name.length > 0 ? file.name : 'unnamed image';
}

function validateRequest(file, targetBytes) {
    const name = sourceName(file);
    if (!file || typeof file !== 'object') {
        throw new TypeError(`An image file is required for "${name}".`);
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
        throw new Error(`Image file "${name}" is empty.`);
    }
    if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
        throw new RangeError(`Target size for "${name}" must be a positive finite number.`);
    }
}

function ensureNonEmptyBlob(blob, fileName) {
    if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) {
        throw new Error(`Encoder produced an empty JPEG for "${fileName}".`);
    }
    return blob;
}

function canvasToBlob(canvas, quality, fileName) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            try {
                resolve(ensureNonEmptyBlob(blob, fileName));
            } catch (error) {
                reject(error);
            }
        }, OUTPUT_TYPE, quality);
    });
}

async function decodeImage(file) {
    const fileName = sourceName(file);
    const objectUrl = URL.createObjectURL(file);
    let image;

    try {
        image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = () => {
                image.onload = null;
                image.onerror = null;
                resolve();
            };
            image.onerror = () => {
                image.onload = null;
                image.onerror = null;
                reject(new Error(`Failed to decode image file "${fileName}".`));
            };
            image.src = objectUrl;
        });
        return { image, objectUrl };
    } catch (error) {
        if (image) {
            image.onload = null;
            image.onerror = null;
        }
        URL.revokeObjectURL(objectUrl);
        throw error;
    }
}

function resizeDimensions(width, height, minimumBytes, targetBytes) {
    const ratio = Math.sqrt(targetBytes / Math.max(minimumBytes, 1));
    const scale = Math.min(0.9, Math.max(0.35, ratio * 0.94));
    return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale))
    };
}

async function findNativeQuality(canvas, ctx, image, width, height, targetBytes, fileName) {
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const encoded = new Map();
    const encode = async (quality) => {
        if (!encoded.has(quality)) encoded.set(quality, canvasToBlob(canvas, quality, fileName));
        return encoded.get(quality);
    };

    // The first probe keeps small images at the highest requested quality.
    const maximum = await encode(MAX_QUALITY);
    if (maximum.size <= targetBytes) return { best: maximum, minimum: maximum };

    const minimum = await encode(MIN_QUALITY);
    // If even the lowest quality is too large, more quality probes cannot help.
    if (minimum.size > targetBytes) return { best: null, minimum };

    let best = minimum;
    let low = MIN_QUALITY;
    let high = MAX_QUALITY;
    for (let attempt = 0; attempt < QUALITY_SEARCH_LIMIT; attempt++) {
        const quality = (low + high) / 2;
        if (quality === low || quality === high) break;
        const candidate = await encode(quality);
        if (candidate.size <= targetBytes) {
            best = candidate;
            low = quality;
        } else {
            high = quality;
        }
    }

    return { best, minimum };
}

async function compressWithFFmpeg(file, targetBytes, withFFmpegRunner = withFFmpeg) {
    const fileName = sourceName(file);
    const suffix = fileName.includes('.') ? `.${fileName.split('.').pop().toLowerCase()}` : '';
    const token = crypto.randomUUID();
    const inputName = `image-input-${token}${suffix}`;
    const outputName = `image-output-${token}.jpg`;
    let logs = '';
    const logger = ({ message }) => { logs += `${message}\n`; };

    return withFFmpegRunner({}, async ffmpeg => {
        try {
            const input = await fetchFile(file);
            if (!input || input.byteLength === 0) {
                throw new Error(`Image file "${fileName}" is empty.`);
            }
            await ffmpeg.writeFile(inputName, input);

            ffmpeg.on('log', logger);
            try {
                // This metadata-only probe may return nonzero because it has no output target;
                // the dimension log is the validation signal used by the existing fallback.
                await ffmpeg.exec(['-i', inputName]);
            } finally {
                ffmpeg.off('log', logger);
            }

            const dimensions = /(\d{1,6})x(\d{1,6})/.exec(logs);
            if (!dimensions) throw new Error(`Failed to read image file "${fileName}".`);
            let width = Number(dimensions[1]);
            let height = Number(dimensions[2]);
            if (!width || !height) throw new Error(`Image "${fileName}" has invalid dimensions.`);

            const encoded = new Map();
            const encode = async (qScale) => {
                if (encoded.has(qScale)) return encoded.get(qScale);
                const filter = `[0:v]scale=${width}:${height}:flags=lanczos,format=rgba[fg];color=c=white:s=${width}x${height}[bg];[bg][fg]overlay=shortest=1,format=yuvj420p[out]`;
                const exitCode = await ffmpeg.exec([
                    '-i', inputName, '-frames:v', '1', '-an', '-map_metadata', '-1',
                    '-filter_complex', filter, '-map', '[out]',
                    '-c:v', 'mjpeg', '-q:v', String(qScale),
                    '-y', outputName
                ]);
                if (exitCode !== 0) throw new Error(`Failed to encode "${fileName}" as JPEG.`);
                const data = await ffmpeg.readFile(outputName);
                if (!data || data.byteLength === 0) {
                    throw new Error(`Encoder produced an empty JPEG for "${fileName}".`);
                }
                // Preserve a typed-array view's offset and length; data.buffer may include unrelated bytes.
                const blob = ensureNonEmptyBlob(new Blob([data], { type: OUTPUT_TYPE }), fileName);
                encoded.set(qScale, blob);
                return blob;
            };

            for (let resize = 0; resize < FFMPEG_RESIZE_LIMIT; resize++) {
                // FFmpeg qscale is inverse quality: 2 is maximum quality, 31 minimum.
                const maximum = await encode(MIN_QSCALE);
                if (maximum.size <= targetBytes) return maximum;

                const minimum = await encode(MAX_QSCALE);
                if (minimum.size <= targetBytes) {
                    let best = minimum;
                    let low = MIN_QSCALE + 1;
                    let high = MAX_QSCALE - 1;
                    for (let attempt = 0; attempt < QUALITY_SEARCH_LIMIT && low <= high; attempt++) {
                        const qScale = Math.floor((low + high) / 2);
                        const candidate = await encode(qScale);
                        if (candidate.size <= targetBytes) {
                            best = candidate;
                            high = qScale - 1;
                        } else {
                            low = qScale + 1;
                        }
                    }
                    return best;
                }

                const next = resizeDimensions(width, height, minimum.size, targetBytes);
                if (next.width === width && next.height === height) break;
                width = next.width;
                height = next.height;
                encoded.clear();
            }
            throw new Error(`Could not compress "${fileName}" below the requested size.`);
        } finally {
            ffmpeg.off('log', logger);
            await ffmpeg.deleteFile(inputName).catch(() => {});
            await ffmpeg.deleteFile(outputName).catch(() => {});
        }
    });
}

export async function compressImage(file, targetBytes, { withFFmpegRunner = withFFmpeg } = {}) {
    validateRequest(file, targetBytes);
    const fileName = sourceName(file);

    let decoded;
    try {
        decoded = await decodeImage(file);
    } catch {
        try {
            return await compressWithFFmpeg(file, targetBytes, withFFmpegRunner);
        } catch (error) {
            if (String(error?.message).includes(`"${fileName}"`)) throw error;
            throw new Error(`Failed to compress image "${fileName}".`, { cause: error });
        }
    }

    const { image, objectUrl } = decoded;
    let canvas;
    try {
        canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error(`Could not create a canvas for "${fileName}".`);

        let width = image.naturalWidth || image.width;
        let height = image.naturalHeight || image.height;
        if (!width || !height) throw new Error(`Image "${fileName}" has invalid dimensions.`);

        for (let resize = 0; resize < NATIVE_RESIZE_LIMIT; resize++) {
            const { best, minimum } = await findNativeQuality(
                canvas, ctx, image, width, height, targetBytes, fileName
            );
            if (best) return ensureNonEmptyBlob(best, fileName);

            const next = resizeDimensions(width, height, minimum.size, targetBytes);
            if (next.width === width && next.height === height) break;
            width = next.width;
            height = next.height;
        }

        throw new Error(`Could not compress "${fileName}" below the requested size.`);
    } finally {
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
        image.onload = null;
        image.onerror = null;
        try {
            image.src = '';
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }
}
