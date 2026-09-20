import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');
let ffprobeAvailable;

export async function hasFfprobe() {
    if (ffprobeAvailable === undefined) {
        ffprobeAvailable = await execFileAsync('ffprobe', ['-version']).then(() => true).catch(() => false);
    }
    return ffprobeAvailable;
}

export async function fixture(name) {
    return readFile(join(fixtureDirectory, name));
}

export async function readDownloadBytes(download) {
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.length < 1) throw new Error(`Downloaded ${download.suggestedFilename()} was empty.`);
    return bytes;
}

function runFfprobe(bytes) {
    return new Promise((resolve, reject) => {
        const child = spawn('ffprobe', [
            '-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', 'pipe:0'
        ]);
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', reject);
        child.stdin.on('error', error => {
            if (error.code !== 'EPIPE') reject(error);
        });
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`ffprobe failed with code ${code}: ${Buffer.concat(stderr).toString()}`));
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
            } catch (error) {
                reject(new Error(`ffprobe returned invalid JSON: ${error.message}`));
            }
        });
        child.stdin.end(bytes);
    });
}

export async function probeMedia(bytes) {
    if (!(await hasFfprobe())) return null;
    return runFfprobe(bytes);
}

export function primaryVideo(probe) {
    return probe?.streams?.find(stream => stream.codec_type === 'video') ?? null;
}

export function primaryAudio(probe) {
    return probe?.streams?.find(stream => stream.codec_type === 'audio') ?? null;
}

export function streamDuration(stream, probe) {
    const value = Number(stream?.duration ?? probe?.format?.duration);
    return Number.isFinite(value) ? value : null;
}

export function frameRate(stream) {
    const [numerator, denominator] = String(stream?.avg_frame_rate || stream?.r_frame_rate || '0/0')
        .split('/').map(Number);
    return denominator ? numerator / denominator : null;
}

export function hasQuarterTurn(stream) {
    return stream?.side_data_list?.some(item => Math.abs(Number(item.rotation)) === 90) ?? false;
}

export async function assertNoUnexpectedNetwork(requests, page) {
    const appOrigin = new URL(page.url()).origin;
    const unexpected = requests.filter(request => {
        const url = request.url();
        if (url.startsWith('blob:') || url.startsWith('data:')) return false;
        const parsed = new URL(url);
        return parsed.origin !== appOrigin || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method());
    }).map(request => `${request.method()} ${request.url()}`);
    if (unexpected.length) throw new Error(`Unexpected network activity:\n${unexpected.join('\n')}`);
}

export function recordNetwork(page) {
    const requests = [];
    page.on('request', request => requests.push(request));
    return requests;
}

export async function downloadBytes(page, trigger) {
    const downloadPromise = page.waitForEvent('download');
    await trigger();
    const download = await downloadPromise;
    return { download, bytes: await readDownloadBytes(download) };
}

export async function waitForDownloadOrError(page, trigger) {
    const downloadPromise = page.waitForEvent('download');
    const errorPromise = page.getByText('ERROR', { exact: true }).waitFor().then(async () => {
        throw new Error(await page.locator('.file-status-msg').first().innerText());
    });
    await trigger();
    return Promise.race([downloadPromise, errorPromise]);
}
