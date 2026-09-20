# Open Media Compressor

An ultra-minimalist, "Brutalist" single-page web application for private media compression. It runs entirely in the browser.

## Features

- **Privacy first**: all processing happens locally on your device. No media is sent to a server.
- **Video**: supported inputs become H.264/AAC MP4 when the current browser can encode the requested tracks. If that capability is missing or the encode fails, the app reports the compatibility path and retries with FFmpeg WebAssembly. Silent inputs remain silent; primary audio and video tracks are mapped explicitly, metadata and chapters are stripped, and the result is checked against the requested size.
- **Images**: supported still images become JPEG, preserving resolution when possible and resizing only when quality alone cannot meet the target. Transparency is flattened onto white. Animated input is treated as a still image and produces a JPEG frame, not an animated output.
- **Private**: all codecs run locally in the browser. Media never leaves the device.

## Portfolio Notes

- **Problem:** media compression tools often require uploads, subscriptions, or unclear privacy tradeoffs.
- **Approach:** use WebCodecs where available, FFmpeg WebAssembly for compatibility, and the browser's JPEG encoder for common images.
- **What it shows:** browser capability detection, real output validation, metadata stripping, target-size heuristics, and a compatibility path for browsers without the required codec support.

## Technology Stack

- **Core**: Mediabunny/WebCodecs for browser-codec video, `ffmpeg.wasm` for compatibility and TIFF/fallback decoding, plus Canvas/JPEG for common images.
- **UI**: `Alpine.js` + Vanilla CSS.
- **Build**: Vite.

## Development

Use Node 22.23.1 (the CI runtime; Node 20.19+ is also supported by the current Vite dependency):

```bash
npm ci
```

Regenerate the checked-in deterministic synthetic fixtures only when changing their generator:

```bash
npm run fixtures:generate
```

Run the unit suite and Chromium browser suites:

```bash
npm test
npx playwright install chromium
npm run test:e2e:dev
npm run test:e2e:built
```

Run the optional desktop WebKit smoke suite when WebKit is installed:

```bash
npx playwright install webkit
npm run test:e2e:webkit
```

Build for production:

```bash
npm run build
```

The app does not promise universal HEIC, HDR, device-camera, iOS, or Safari support. Results depend on the browser's decode/encode capabilities and available device memory. The desktop WebKit smoke suite is a compatibility signal, not iOS/Safari release proof. The E2E suite also asserts that no media upload POST/PUT requests occur.

## Credits

Open-source and 100% free. Made by [nickdrezza](https://nickdrezza.com).
