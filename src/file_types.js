const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.mpeg', '.mpg']);

const IMAGE_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.bmp',
    '.tif',
    '.tiff',
    '.avif',
    '.heic',
    '.heif'
]);

export function getFileExtension(file) {
    const fileName = (file?.name || '').toLowerCase();
    const extensionIndex = fileName.lastIndexOf('.');
    return extensionIndex > 0 ? fileName.slice(extensionIndex) : '';
}

export function getNormalizedMimeType(file) {
    return (file?.type || '').toLowerCase().split(';', 1)[0].trim();
}

export function detectFileKind(file) {
    const mime = getNormalizedMimeType(file);
    const ext = getFileExtension(file);

    if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video';

    if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';

    return 'unsupported';
}

export function getUnsupportedFileMessage(file) {
    const mime = getNormalizedMimeType(file) || 'empty';
    const extension = getFileExtension(file) || 'none';

    return `Format not supported (photos and videos only). Detected MIME: ${mime}, extension: ${extension}`;
}
