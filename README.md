# Open Media Compressor

An ultra-minimalist, "Brutalist" single-page web application for private media compression. It runs entirely in the browser.

## Features

- **Privacy First**: All processing happens locally on your device. No data is ever sent to a server.
- **Videos**: Common video formats are converted to broadly compatible **H.264/AAC MP4** with hardware-accelerated browser codecs when available and an FFmpeg compatibility fallback, then verified against the requested size.
- **Images**: Common image formats are converted to universally previewable **JPEG**, preserving resolution when possible and resizing only when quality alone cannot meet the target. Transparency is flattened onto white.
- **Private**: All codecs run locally in the browser. Media never leaves the device.
- **Brutalist Aesthetic**: Built with a sleek, high-contrast dark mode using **Alpine.js**.

## Portfolio Notes

- **Problem:** media compression tools often require uploads, subscriptions, or unclear privacy tradeoffs.
- **Approach:** run compression entirely in the browser with hardware-accelerated WebCodecs for everyday video, FFmpeg WebAssembly for broad fallback support, and the browser's JPEG encoder for common images.
- **What it shows:** modern browser APIs, performance-minded worker architecture, metadata stripping, target-size heuristics, and pragmatic compatibility handling for Safari/macOS.

## Technology Stack

- **Core**: Mediabunny/WebCodecs for fast video, `ffmpeg.wasm` for compatibility and fallback image decoding, plus Canvas/JPEG for common images.
- **UI**: `Alpine.js` + Vanilla CSS.
- **Build**: Vite.

## Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Run the test suite:
   ```bash
   npm test
   ```

4. Run the browser tests:
   ```bash
   npx playwright install chromium
   npm run test:e2e
   ```

5. Build for production:
   ```bash
   npm run build
   ```

## Credits

Open-source and 100% free. Made by [nickdrezza](https://nickdrezza.com).
