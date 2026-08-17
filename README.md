# Open Media Compressor

An ultra-minimalist, "Brutalist" single-page web application for private media compression. It runs entirely in the browser.

## Features

- **Privacy First**: All processing happens locally on your device. No data is ever sent to a server.
- **Videos**: Common video formats are converted to broadly compatible **H.264/AAC MP4** using a two-pass FFmpeg encode and verified against the requested size.
- **Images**: Common image formats are converted to **WebP**, preserving resolution when possible and resizing only when quality alone cannot meet the target.
- **Private**: FFmpeg runs locally in a Web Worker. Media never leaves the device.
- **Brutalist Aesthetic**: Built with a sleek, high-contrast dark mode using **Alpine.js**.

## Portfolio Notes

- **Problem:** media compression tools often require uploads, subscriptions, or unclear privacy tradeoffs.
- **Approach:** run compression entirely in the browser with FFmpeg WebAssembly for video and the browser's WebP encoder for images.
- **What it shows:** modern browser APIs, performance-minded worker architecture, metadata stripping, target-size heuristics, and pragmatic compatibility handling for Safari/macOS.

## Technology Stack

- **Core**: `ffmpeg.wasm` for video and Canvas/WebP for images.
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
