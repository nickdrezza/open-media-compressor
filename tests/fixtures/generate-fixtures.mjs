import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
mkdirSync(directory, { recursive: true });

function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const payload = Buffer.concat([typeBytes, data]);
    const crc = crc32(payload);
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    payload.copy(result, 4);
    result.writeUInt32BE(crc >>> 0, 8 + data.length);
    return result;
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function writeTransparentPng() {
    const width = 128;
    const height = 96;
    const rows = [];
    for (let y = 0; y < height; y++) {
        const row = Buffer.alloc(1 + width * 4);
        for (let x = 0; x < width; x++) {
            const offset = 1 + x * 4;
            row[offset] = (x * 17 + y * 3) % 256;
            row[offset + 1] = (x * 5 + y * 19) % 256;
            row[offset + 2] = (x * 29 + y * 7) % 256;
            row[offset + 3] = (x + y) % 32 === 0 ? 0 : 180;
        }
        rows.push(row);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    writeFileSync(join(directory, 'transparent.png'), Buffer.concat([
        Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}

function writeTiff() {
    const width = 64;
    const height = 64;
    const entryCount = 10;
    const ifdSize = 2 + entryCount * 12 + 4;
    const bitsOffset = 8 + ifdSize;
    const pixelOffset = bitsOffset + 6;
    const pixels = width * height * 3;
    const buffer = Buffer.alloc(pixelOffset + pixels);
    buffer.write('II', 0, 'ascii');
    buffer.writeUInt16LE(42, 2);
    buffer.writeUInt32LE(8, 4);
    buffer.writeUInt16LE(entryCount, 8);
    const entries = [
        [256, 4, 1, width], [257, 4, 1, height], [258, 3, 3, bitsOffset],
        [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, pixelOffset],
        [277, 3, 1, 3], [278, 4, 1, height], [279, 4, 1, pixels], [284, 3, 1, 1]
    ];
    entries.forEach(([tag, type, count, value], index) => {
        const offset = 10 + index * 12;
        buffer.writeUInt16LE(tag, offset);
        buffer.writeUInt16LE(type, offset + 2);
        buffer.writeUInt32LE(count, offset + 4);
        if (type === 3 && count === 1) buffer.writeUInt16LE(value, offset + 8);
        else buffer.writeUInt32LE(value, offset + 8);
    });
    buffer.writeUInt16LE(8, bitsOffset);
    buffer.writeUInt16LE(8, bitsOffset + 2);
    buffer.writeUInt16LE(8, bitsOffset + 4);
    for (let index = 0; index < width * height; index++) {
        buffer[pixelOffset + index * 3] = (index * 17) % 256;
        buffer[pixelOffset + index * 3 + 1] = (index * 31) % 256;
        buffer[pixelOffset + index * 3 + 2] = (index * 47) % 256;
    }
    writeFileSync(join(directory, 'photo.tiff'), buffer);
}

function writeMalformedInput() {
    writeFileSync(join(directory, 'malformed.mp4'), Buffer.from(
        'OMC-L6 malformed synthetic input; this is intentionally not a media container.\n',
        'ascii'
    ));
}

function makeVideo(output, args) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, output], {
        cwd: directory,
        stdio: 'inherit',
    });
}

function addQuarterTurnDisplayMatrix(fileName) {
    const filePath = join(directory, fileName);
    const buffer = readFileSync(filePath);
    const atom = Buffer.from('tkhd', 'ascii');
    const atomOffset = buffer.indexOf(atom);
    if (atomOffset < 4) throw new Error(`Could not find the video track header in ${fileName}.`);
    const matrixOffset = atomOffset + 44;
    const matrix = [0, 0x00010000, 0, -0x00010000, 0, 0, 0, 0, 0x00010000];
    matrix.forEach((value, index) => buffer.writeInt32BE(value, matrixOffset + index * 4));
    writeFileSync(filePath, buffer);
}

writeTransparentPng();
writeTiff();
writeMalformedInput();

makeVideo('audio-24fps.webm', [
    '-f', 'lavfi', '-i', 'color=c=black:size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,0.8\\,1.2)\\,0.65*sin(2*PI*880*t)\\,0):s=48000',
    '-t', '2.4', '-map', '0:v:0', '-map', '1:a:0',
    '-vf', 'noise=alls=20:allf=u,drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable=between(t\\,0.8\\,1.2)',
    '-map_metadata', '-1',
    '-metadata', 'comment=omc-l6-source-marker', '-metadata', 'title=Open Media Compressor L6 synthetic fixture',
    '-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '4', '-b:v', '650k',
    '-c:a', 'libopus', '-b:a', '96k', '-fflags', '+bitexact', '-flags:v', '+bitexact',
]);

makeVideo('silent-29.97fps-rotated.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30000/1001',
    '-f', 'ffmetadata', '-i', 'fixture-metadata.txt', '-t', '2.4', '-map', '0:v:0', '-map_metadata', '1',
    '-map_chapters', '1', '-map', '-0:d', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-fflags', '+bitexact', '-flags:v', '+bitexact',
]);
addQuarterTurnDisplayMatrix('silent-29.97fps-rotated.mp4');

console.log('Generated deterministic L6 fixtures in', directory);
