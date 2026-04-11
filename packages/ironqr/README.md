# ironqr

A browser-native QR Code Model 2 reader SDK built for the real world — where codes have rounded dots, custom colors, logos, gradients, perspective distortion, and every other creative treatment designers throw at them.

**No QR or CV dependencies.** A small number of runtime dependencies exist for developer ergonomics (like [Effect](https://effect.website)), but all detection, sampling, and decoding logic is built from scratch. TypeScript orchestration with WebAssembly for performance-critical paths. Runs entirely client-side.

> [!NOTE]
> ironqr is under active development. Implementation may be lacking. See [Status](#status) below for what has been implemented.

## Why ironqr

Existing web QR readers break on stylized codes. They assume square black-on-white modules, choke on rounded dots, miss inverted or colored codes, and return false positives on decorative patterns. ironqr takes a different approach:

- **Multi-sample evidence model** — each module cell is sampled at multiple points with center-weighted patterns, making classification robust to rounded, hollow, connected, and sparse-dot module shapes.
- **Multi-hypothesis decoding** — luminance, color channels, and inversion hypotheses are evaluated so non-standard palettes and dark-mode codes decode correctly.
- **Aggressive finder detection** — heavily stylized finder patterns are targeted from the start, not just near-standard square bullseyes.
- **Strict validation** — format info, version logic, masking, Reed-Solomon correction, and structural consistency must all pass before a result is returned. No hallucinated decodes.
- **Multi-code detection** — returns all valid QR symbols in a frame, sorted by confidence and area.

## Install

```bash
npm install ironqr
# or
pnpm i ironqr
# or
bun i ironqr
```

## Usage

### Scan an image

```ts
import { scanImage } from "ironqr";

const results = await scanImage(imageElement);

for (const result of results) {
  console.log(result.payload.text);
  console.log(result.payload.kind); // 'url' | 'text' | 'wifi' | ...
  console.log(result.confidence);
  console.log(result.corners); // corner geometry for overlays
}
```

### Scan a video stream

```ts
import { scanStream } from "ironqr";

const controller = new AbortController();

await scanStream(mediaStream, {
  onResult: (result) => console.log(result.payload.text),
  onError: (err) => console.error(err),
  signal: controller.signal,
});
```

### Scan a single frame

```ts
import { scanFrame } from "ironqr";

const results = await scanFrame(videoFrame);
```

### Decode a known grid

For advanced use — decode a logical boolean grid directly, bypassing image detection:

```ts
import { decodeGrid } from "ironqr";

const result = await decodeGrid({
  grid: booleanGrid, // boolean[][]
});
```

## API

### Functions

| Function     | Input                             | Output                      | Description                            |
| ------------ | --------------------------------- | --------------------------- | -------------------------------------- |
| `scanImage`  | `BrowserImageSource`              | `Promise<ScanResult[]>`     | Scan a still image for all QR codes    |
| `scanFrame`  | `BrowserImageSource`              | `Promise<ScanResult[]>`     | Scan a single video frame              |
| `scanStream` | `MediaStream \| HTMLVideoElement` | `Promise<ScanResult[]>`     | Managed stream scanning with callbacks |
| `decodeGrid` | `DecodeGridInput`                 | `Promise<DecodeGridResult>` | Decode a pre-extracted logical grid    |

`BrowserImageSource` accepts `Blob`, `File`, `ImageBitmap`, `ImageData`, `HTMLCanvasElement`, `HTMLImageElement`, `OffscreenCanvas`, or `VideoFrame`.

### ScanResult

Each result includes:

| Field                  | Type                       | Description                                                                                      |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `payload.text`         | `string`                   | Decoded text content                                                                             |
| `payload.kind`         | `PayloadKind`              | Semantic type: `url`, `text`, `email`, `sms`, `wifi`, `contact`, `calendar`, `binary`, `unknown` |
| `payload.bytes`        | `Uint8Array`               | Raw decoded bytes                                                                                |
| `confidence`           | `number`                   | Decode confidence score                                                                          |
| `version`              | `number`                   | QR code version (1–40)                                                                           |
| `errorCorrectionLevel` | `'L' \| 'M' \| 'Q' \| 'H'` | Error correction level                                                                           |
| `bounds`               | `Bounds`                   | Axis-aligned bounding box                                                                        |
| `corners`              | `CornerSet`                | Perspective-accurate corner points                                                               |
| `headers`              | `[string, string][]`       | Segment-level metadata                                                                           |

### Options

```ts
interface ScanOptions {
  allowMultiple?: boolean; // return all codes, not just the first
  debug?: boolean; // expose intermediate artifacts
  maxCandidates?: number; // limit candidate evaluation
}
```

## Style tolerance

ironqr targets practical robustness across common QR styling treatments:

- Rounded and circular modules
- Custom foreground/background colors
- Inverted (light-on-dark) codes
- Gradient fills
- Logo overlays and partial occlusion (within EC capacity)
- Connected / line-art module styles
- Hollow and ring-shaped modules
- Sparse dots centered in larger cells
- Perspective distortion from handheld cameras
- Mild blur and resampling artifacts

## Architecture

```
image/frame
  → candidate discovery (aggressive finder detection)
  → geometric resolver (perspective estimation)
  → module evidence sampler (multi-point, center-weighted)
  → grid interpreter (binary hypotheses from subcell evidence)
  → standards decoder (format, version, mask, RS, segments)
  → result validator (false-positive guard)
  → ScanResult[]
```

Detection and geometry estimation are fully separated from module interpretation and payload decoding. The standards decoder is the final gatekeeper — no result is emitted without passing structural and error-correction validation.

Performance-critical kernels (image processing, sampling) are compiled to WebAssembly from Rust. The TypeScript layer handles orchestration, public APIs, and schema validation via Effect.

## Development

```bash
bun install
bun run build        # build with tsup
bun run test         # run bun test
bun run lint         # biome check
bun run typecheck    # tsc --noEmit
bun run package:quality  # publint + attw
```

## Status

ironqr is in active development.

## License

[MCX License (mia.cx) v1.0](./LICENSE) — MPL 2.0 derivative that treats SaaS as distribution requiring attribution.
