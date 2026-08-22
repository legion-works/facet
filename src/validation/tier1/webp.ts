import sharp from "sharp";

export interface AnimatedWebpOptions {
  readonly width: number;
  readonly height: number;
  readonly delayMs: number;
  readonly quality: number;
}

export interface AnimatedWebpCapOptions extends Omit<AnimatedWebpOptions, "quality"> {
  readonly qualities: readonly number[];
  readonly capBytes: number;
}

export async function encodeAnimatedWebp(
  frames: readonly Buffer[],
  options: AnimatedWebpOptions,
): Promise<Buffer> {
  if (frames.length === 0) throw new Error("animated WebP requires at least one frame");
  const metadata = await Promise.all(
    frames.map((frame) => sharp(frame, { limitInputPixels: true }).metadata()),
  );
  if (metadata.some(({ width, height }) => width !== options.width || height !== options.height))
    throw new Error("animated WebP frame dimensions do not match capture bounds");
  const decoded = await Promise.all(
    frames.map(async (frame) => {
      const result = await sharp(frame, { limitInputPixels: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { bytes: result.data, info: result.info };
    }),
  );
  if (decoded.some(({ info }) => info.channels !== 4))
    throw new Error("animated WebP frame dimensions do not match capture bounds");
  if (!Number.isSafeInteger(options.height * frames.length))
    throw new Error("animated WebP frame stack is too tall");

  return sharp(Buffer.concat(decoded.map(({ bytes }) => bytes)), {
    raw: {
      width: options.width,
      height: options.height * frames.length,
      channels: 4,
      pageHeight: options.height,
    },
  })
    .webp({
      quality: options.quality,
      effort: 4,
      loop: 0,
      delay: Array.from({ length: frames.length }, () => options.delayMs),
    })
    .toBuffer();
}

export async function encodeAnimatedWebpWithinCap(
  frames: readonly Buffer[],
  options: AnimatedWebpCapOptions,
): Promise<Buffer | null> {
  for (const quality of options.qualities) {
    const bytes = await encodeAnimatedWebp(frames, { ...options, quality });
    if (bytes.byteLength <= options.capBytes) return bytes;
  }
  return null;
}
