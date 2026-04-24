#!/usr/bin/env node
const cv = require('@techstark/opencv-js');
const sharp = require('sharp');

const INIT_TIMEOUT_MS = 30_000;
const MODES = new Set(['single', 'multi']);

const normalizeDecodedText = (value) => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end -= 1;
  return value.slice(0, end);
};

const waitForOpenCv = async () => {
  if (typeof cv.Mat === 'function' && typeof cv.QRCodeDetector === 'function') return;
  await new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const previousInitialized = cv.onRuntimeInitialized;
    const timer = setInterval(() => {
      if (typeof cv.Mat === 'function' && typeof cv.QRCodeDetector === 'function') {
        cleanup();
        resolve();
        return;
      }
      if (performance.now() - startedAt >= INIT_TIMEOUT_MS) {
        cleanup();
        reject(new Error('OpenCV runtime initialization timed out.'));
      }
    }, 25);
    const cleanup = () => {
      clearInterval(timer);
      cv.onRuntimeInitialized = previousInitialized;
    };
    cv.onRuntimeInitialized = () => {
      previousInitialized?.();
      if (typeof cv.Mat !== 'function' || typeof cv.QRCodeDetector !== 'function') return;
      cleanup();
      resolve();
    };
  });
};

const scan = async (imagePath, mode) => {
  let source = null;
  let grayscale = null;
  let detector = null;
  let decodedInfo = null;
  try {
    await waitForOpenCv();
    const { data, info } = await sharp(imagePath)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    source = cv.matFromImageData({
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    });
    grayscale = new cv.Mat();
    cv.cvtColor(source, grayscale, cv.COLOR_RGBA2GRAY);
    detector = new cv.QRCodeDetector();

    if (mode === 'multi') {
      decodedInfo = new cv.StringVector();
      const decoded = detector.detectAndDecodeMulti(grayscale, decodedInfo) === true;
      const texts = decoded ? textsFromVector(decodedInfo) : [];
      return texts.length > 0 ? { status: 'decoded', texts } : { status: 'no-decode' };
    }

    const text = normalizeDecodedText(String(detector.detectAndDecode(grayscale) ?? ''));
    return text.length > 0 ? { status: 'decoded', texts: [text] } : { status: 'no-decode' };
  } finally {
    decodedInfo?.delete();
    detector?.delete();
    grayscale?.delete();
    source?.delete();
  }
};

const textsFromVector = (decodedInfo) => {
  const texts = [];
  for (let index = 0; index < decodedInfo.size(); index += 1) {
    const text = normalizeDecodedText(String(decodedInfo.get(index) ?? ''));
    if (text.length > 0) texts.push(text);
  }
  return [...new Set(texts)];
};

const main = async () => {
  const imagePath = process.argv[2];
  const mode = process.argv[3] ?? 'single';
  if (!imagePath || !MODES.has(mode)) {
    throw new Error('Usage: opencv-node-worker.cjs <image-path> <single|multi>');
  }
  const result = await scan(imagePath, mode);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
