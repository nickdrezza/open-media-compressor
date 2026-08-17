import { fetchFile } from '@ffmpeg/util';
import { getFFmpeg } from './video_compressor.js';

const OUTPUT_TYPE = 'image/jpeg';
const MIN_QUALITY = 0.02;
const MAX_QUALITY = 0.96;

function canvasToBlob(canvas, quality, fileName) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error(`Failed to encode "${fileName}" as JPEG.`));
        }, OUTPUT_TYPE, quality);
    });
}

async function decodeImage(file) {
    const url = URL.createObjectURL(file);
    const image = new Image();

    try {
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error(`Failed to decode image file "${file.name}".`));
            image.src = url;
        });
        return image;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

async function compressWithFFmpeg(file, targetBytes) {
    const ffmpeg = await getFFmpeg();
    const suffix = file.name.includes('.') ? `.${file.name.split('.').pop().toLowerCase()}` : '';
    const token = crypto.randomUUID();
    const inputName = `image-input-${token}${suffix}`;
    const outputName = `image-output-${token}.jpg`;
    let logs = '';
    const logger = ({ message }) => { logs += `${message}\n`; };

    try {
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        ffmpeg.on('log', logger);
        await ffmpeg.exec(['-i', inputName]);
        ffmpeg.off('log', logger);
        const dimensions = /(\d{2,6})x(\d{2,6})/.exec(logs);
        if (!dimensions) throw new Error(`Failed to read image file "${file.name}".`);
        let width = Number(dimensions[1]);
        let height = Number(dimensions[2]);

        const encode = async (qScale) => {
            const filter = `[0:v]scale=${width}:${height}:flags=lanczos,format=rgba[fg];color=c=white:s=${width}x${height}[bg];[bg][fg]overlay=shortest=1,format=yuvj420p[out]`;
            const exitCode = await ffmpeg.exec([
                '-i', inputName, '-frames:v', '1', '-an', '-map_metadata', '-1',
                '-filter_complex', filter, '-map', '[out]',
                '-c:v', 'mjpeg', '-q:v', String(qScale),
                '-y', outputName
            ]);
            if (exitCode !== 0) throw new Error(`Failed to encode "${file.name}" as JPEG.`);
            const data = await ffmpeg.readFile(outputName);
            return new Blob([data.buffer], { type: OUTPUT_TYPE });
        };

        for (let resize = 0; resize < 10; resize++) {
            let low = 2;
            let high = 31;
            let best = null;
            let minimum = await encode(high);
            if (minimum.size <= targetBytes) best = minimum;

            for (let attempt = 0; attempt < 6 && low <= high; attempt++) {
                const qScale = Math.floor((low + high) / 2);
                const candidate = await encode(qScale);
                if (candidate.size <= targetBytes) {
                    best = candidate;
                    high = qScale - 1;
                } else {
                    low = qScale + 1;
                }
            }
            if (best) return best;

            const scale = Math.min(0.9, Math.max(0.35, Math.sqrt(targetBytes / Math.max(minimum.size, 1)) * 0.94));
            const nextWidth = Math.max(1, Math.floor(width * scale));
            const nextHeight = Math.max(1, Math.floor(height * scale));
            if (nextWidth === width && nextHeight === height) break;
            width = nextWidth;
            height = nextHeight;
        }
        throw new Error(`Could not compress "${file.name}" below the requested size.`);
    } finally {
        ffmpeg.off('log', logger);
        await ffmpeg.deleteFile(inputName).catch(() => {});
        await ffmpeg.deleteFile(outputName).catch(() => {});
    }
}

async function bestQualityAtSize(canvas, ctx, image, width, height, targetBytes) {
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    let low = MIN_QUALITY;
    let high = MAX_QUALITY;
    let best = null;
    const minimum = await canvasToBlob(canvas, MIN_QUALITY, image.src);
    if (minimum.size <= targetBytes) best = minimum;

    for (let attempt = 0; attempt < 9; attempt++) {
        const quality = (low + high) / 2;
        const candidate = await canvasToBlob(canvas, quality, image.src);
        if (candidate.size <= targetBytes) {
            best = candidate;
            low = quality;
        } else {
            high = quality;
        }
    }

    return { best, minimum };
}

export async function compressImage(file, targetBytes) {
    let image;
    try {
        image = await decodeImage(file);
    } catch {
        return compressWithFFmpeg(file, targetBytes);
    }
    const objectUrl = image.src;

    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error(`Could not create a canvas for "${file.name}".`);

        let width = image.naturalWidth || image.width;
        let height = image.naturalHeight || image.height;
        if (!width || !height) throw new Error(`Image "${file.name}" has invalid dimensions.`);

        for (let resize = 0; resize < 12; resize++) {
            const { best, minimum } = await bestQualityAtSize(canvas, ctx, image, width, height, targetBytes);
            if (best) return best;

            const ratio = Math.sqrt(targetBytes / Math.max(minimum.size, 1));
            const scale = Math.min(0.9, Math.max(0.35, ratio * 0.94));
            const nextWidth = Math.max(1, Math.floor(width * scale));
            const nextHeight = Math.max(1, Math.floor(height * scale));
            if (nextWidth === width && nextHeight === height) break;
            width = nextWidth;
            height = nextHeight;
        }

        throw new Error(`Could not compress "${file.name}" below the requested size.`);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}
