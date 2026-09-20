import {
    detectFileKind as defaultDetectFileKind,
    getUnsupportedFileMessage as defaultGetUnsupportedFileMessage
} from './file_types.js';
import { compressImage as defaultCompressImage } from './image_compressor.js';
import { compressVideo as defaultCompressVideo } from './video_compressor.js';

export function normalizeError(error) {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return 'Compression failed for an unknown reason.';
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

export function createCompressorApp({
    detectFileKind = defaultDetectFileKind,
    getUnsupportedFileMessage = defaultGetUnsupportedFileMessage,
    compressImage = defaultCompressImage,
    compressVideo = defaultCompressVideo,
    downloadFile = downloadBlob,
    diagnosticConsole = globalThis.console
} = {}) {
    const logger = diagnosticConsole || { error() {} };

    return {
        files: [],
        isDragging: false,
        isCompressing: false,
        maxSize: 500,
        unit: 'KB',
        validationError: '',
        phaseMessage: '',

        handleDrop(event) {
            this.isDragging = false;
            this.addFiles(event.dataTransfer?.files || []);
        },

        handleFiles(event) {
            this.addFiles(event.target?.files || []);
            if (event.target) event.target.value = '';
        },

        addFiles(fileList) {
            const incomingFiles = Array.from(fileList || []);
            if (!incomingFiles.length) return;

            if (this.files.length === 0) {
                const firstPath = detectFileKind(incomingFiles[0]);
                if (firstPath === 'video') {
                    this.maxSize = 20;
                    this.unit = 'MB';
                } else if (firstPath === 'image') {
                    this.maxSize = 500;
                    this.unit = 'KB';
                }
            }

            for (const raw of incomingFiles) {
                this.files.push({
                    raw,
                    status: null,
                    progress: 0,
                    statusMessage: ''
                });
            }
        },

        formatSize(bytes) {
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        },

        getTargetBytes() {
            const numericMaxSize = Number(this.maxSize);
            if (!Number.isFinite(numericMaxSize) || numericMaxSize <= 0) {
                throw new Error('Max size must be a positive finite number.');
            }

            const multiplier = this.unit === 'MB' ? 1024 * 1024 : 1024;
            const targetBytes = numericMaxSize * multiplier;
            if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
                throw new Error('Max size produces an invalid target in bytes.');
            }
            return targetBytes;
        },

        validateTarget() {
            try {
                const targetBytes = this.getTargetBytes();
                this.validationError = '';
                return targetBytes;
            } catch (error) {
                this.validationError = normalizeError(error);
                return null;
            }
        },

        detectFileKind(file) {
            return detectFileKind(file);
        },

        assertFileSupport(path, file) {
            if (path !== 'unsupported') return;
            throw new Error(getUnsupportedFileMessage(file));
        },

        finalizeFile(fileObj, blob, newExt, effectiveTargetBytes) {
            const outputBytes = Number(blob?.size);
            if (!Number.isFinite(outputBytes) || outputBytes < 1) {
                throw new Error('Compression produced an empty or invalid output.');
            }
            if (outputBytes > effectiveTargetBytes) {
                throw new Error('Compressed output exceeds the requested target size.');
            }
            this.downloadFile(blob, this.getOutName(fileObj.raw.name, newExt));
            fileObj.status = 'done';
            fileObj.progress = 100;
            fileObj.statusMessage = `${this.formatSize(fileObj.raw.size)} -> ${this.formatSize(outputBytes)}`;
        },

        async startCompression() {
            if (this.isCompressing) return;

            const targetBytes = this.validateTarget();
            if (targetBytes === null) return;

            this.isCompressing = true;
            this.phaseMessage = 'Preparing compression...';

            try {
                for (const fileObj of this.files) {
                    if (fileObj.status === 'done') continue;

                    fileObj.status = 'processing';
                    fileObj.progress = 0;
                    fileObj.statusMessage = 'Preparing...';
                    this.phaseMessage = `Preparing ${fileObj.raw.name}...`;

                    try {
                        const sourceBytes = Number(fileObj.raw?.size);
                        if (!Number.isFinite(sourceBytes) || sourceBytes < 1) {
                            throw new Error('Source file must have a positive finite byte count.');
                        }
                        const effectiveTargetBytes = Math.min(sourceBytes, targetBytes);
                        const path = this.detectFileKind(fileObj.raw);
                        this.assertFileSupport(path, fileObj.raw);

                        if (path === 'video') {
                            const blob = await compressVideo(fileObj.raw, effectiveTargetBytes, {
                                onProgress: value => { fileObj.progress = value; },
                                onStatus: message => {
                                    fileObj.statusMessage = message;
                                    this.phaseMessage = message;
                                }
                            });
                            this.finalizeFile(fileObj, blob, '.mp4', effectiveTargetBytes);
                        } else if (path === 'image') {
                            fileObj.statusMessage = 'Compressing image...';
                            this.phaseMessage = `Compressing ${fileObj.raw.name}...`;
                            const blob = await compressImage(fileObj.raw, effectiveTargetBytes);
                            this.finalizeFile(fileObj, blob, '.jpg', effectiveTargetBytes);
                        }
                    } catch (error) {
                        logger.error('Compression failed.', error);
                        fileObj.status = 'error';
                        fileObj.statusMessage = normalizeError(error);
                        this.phaseMessage = `Could not compress ${fileObj.raw.name}.`;
                    }
                }
            } finally {
                this.isCompressing = false;
                if (!this.phaseMessage) this.phaseMessage = 'Compression complete.';
            }
        },

        downloadFile(blob, filename) {
            return downloadFile(blob, filename);
        },

        getOutName(originalName, newExt) {
            const extensionIndex = originalName.lastIndexOf('.');
            const hasExtension = extensionIndex > 0;
            const namePart = hasExtension ? originalName.slice(0, extensionIndex) : originalName;
            const ext = newExt || (hasExtension ? originalName.slice(extensionIndex) : '');
            return `${namePart}_c${ext}`;
        }
    };
}

export async function startCompressor() {
    const { default: Alpine } = await import('alpinejs');
    window.Alpine = Alpine;
    Alpine.data('compressor', () => createCompressorApp());
    Alpine.start();
}

if (typeof window !== 'undefined') startCompressor();
