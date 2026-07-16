import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  AVATAR_MEDIA_PROFILE,
  isCountableSubmissionMediaErrorCode,
  SUBMISSION_MEDIA_PROFILE,
} from "../../lib/media/profiles.ts";
import {
  MediaValidationError,
  processStaticImage,
} from "../../lib/media/processStaticImage.ts";

async function expectMediaError(promise, codes) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MediaValidationError);
    assert.ok(codes.includes(error.code), `unexpected code ${error.code}`);
    return true;
  });
}

async function solid(width, height, format, options = {}) {
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: options.background ?? "#d15428",
    },
  });
  if (options.orientation) {
    pipeline = pipeline.withMetadata({ orientation: options.orientation });
  }
  return pipeline[format]().toBuffer();
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function pngWithDeclaredDimensions(width, height) {
  const buffer = Buffer.from(await solid(1, 1, "png"));
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt32BE(crc32(buffer.subarray(12, 29)), 29);
  return buffer;
}

test("central profiles expose the exact submission and avatar boundaries", () => {
  assert.deepEqual(SUBMISSION_MEDIA_PROFILE.allowedInputFormats, [
    "jpeg",
    "png",
    "webp",
  ]);
  assert.equal(SUBMISSION_MEDIA_PROFILE.maxInputBytes, 4_000_000);
  assert.equal(SUBMISSION_MEDIA_PROFILE.maxInputWidth, 8192);
  assert.equal(SUBMISSION_MEDIA_PROFILE.maxInputHeight, 20_000);
  assert.equal(SUBMISSION_MEDIA_PROFILE.maxInputPixels, 24_000_000);
  assert.equal(SUBMISSION_MEDIA_PROFILE.maxOutputWidth, 2400);
  assert.equal(SUBMISSION_MEDIA_PROFILE.maxOutputHeight, 16_383);
  assert.equal(SUBMISSION_MEDIA_PROFILE.allowUpscale, false);
  assert.equal(AVATAR_MEDIA_PROFILE.maxInputPixels, 16_000_000);
  assert.equal(AVATAR_MEDIA_PROFILE.minInputWidth, 256);
  assert.equal(AVATAR_MEDIA_PROFILE.outputWidth, 512);
  assert.equal(AVATAR_MEDIA_PROFILE.outputHeight, 512);
});

test("static JPEG, PNG and WebP become static metadata-free WebP", async () => {
  for (const [format, mime] of [
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ]) {
    const result = await processStaticImage({
      input: await solid(320, 240, format),
      claimedMimeType: mime,
      profile: SUBMISSION_MEDIA_PROFILE,
    });
    const metadata = await sharp(result.buffer, { animated: true }).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.pages ?? 1, 1);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
  }
});

test("claimed MIME cannot disguise the decoded type", async () => {
  await expectMediaError(
    processStaticImage({
      input: await solid(20, 20, "png"),
      claimedMimeType: "image/jpeg",
      profile: SUBMISSION_MEDIA_PROFILE,
    }),
    ["MEDIA_MIME_MISMATCH"]
  );
});

test("GIF and animated WebP are rejected", async () => {
  await expectMediaError(
    processStaticImage({
      input: await solid(20, 20, "gif"),
      claimedMimeType: "image/gif",
      profile: SUBMISSION_MEDIA_PROFILE,
    }),
    ["MEDIA_FORMAT_UNSUPPORTED", "MEDIA_ANIMATION_UNSUPPORTED"]
  );

  const animatedWebp = await sharp(
    [
      { create: { width: 20, height: 20, channels: 4, background: "red" } },
      { create: { width: 20, height: 20, channels: 4, background: "blue" } },
    ],
    { join: { animated: true } }
  )
    .webp({ delay: [100, 100], loop: 0 })
    .toBuffer();
  await expectMediaError(
    processStaticImage({
      input: animatedWebp,
      claimedMimeType: "image/webp",
      profile: SUBMISSION_MEDIA_PROFILE,
    }),
    ["MEDIA_ANIMATION_UNSUPPORTED"]
  );
});

test("corrupt and oversized byte inputs fail before storage", async () => {
  await expectMediaError(
    processStaticImage({
      input: Buffer.from("not an image"),
      claimedMimeType: "image/png",
      profile: SUBMISSION_MEDIA_PROFILE,
    }),
    ["MEDIA_CORRUPT"]
  );
  await expectMediaError(
    processStaticImage({
      input: Buffer.alloc(SUBMISSION_MEDIA_PROFILE.maxInputBytes + 1),
      claimedMimeType: "image/png",
      profile: SUBMISSION_MEDIA_PROFILE,
    }),
    ["MEDIA_FILE_TOO_LARGE"]
  );
});

test("width, height and decoded-pixel limits reject unsafe images", async () => {
  await expectMediaError(
    processStaticImage({
      input: await solid(8193, 1, "png"),
      claimedMimeType: "image/png",
      profile: SUBMISSION_MEDIA_PROFILE,
    }),
    ["MEDIA_WIDTH_EXCEEDED"]
  );
  await expectMediaError(
    processStaticImage({
      input: await solid(1, 20_001, "png"),
      claimedMimeType: "image/png",
      profile: SUBMISSION_MEDIA_PROFILE,
    }),
    ["MEDIA_HEIGHT_EXCEEDED"]
  );
  for (const [width, height] of [
    [5000, 5000],
    [8000, 8000],
  ]) {
    await expectMediaError(
      processStaticImage({
        input: await pngWithDeclaredDimensions(width, height),
        claimedMimeType: "image/png",
        profile: SUBMISSION_MEDIA_PROFILE,
      }),
      ["MEDIA_PIXEL_LIMIT_EXCEEDED", "MEDIA_DECOMPRESSION_LIMIT"]
    );
  }
});

test("long rage-comic boundaries and 24 MP landscape stay supported", async () => {
  for (const [width, height] of [
    [1600, 1200],
    [1000, 12_000],
    [1200, 20_000],
    [6000, 4000],
  ]) {
    const result = await processStaticImage({
      input: await solid(width, height, "png"),
      claimedMimeType: "image/png",
      profile: SUBMISSION_MEDIA_PROFILE,
    });
    assert.ok(result.width <= Math.min(width, 2400));
    assert.ok(result.height <= Math.min(height, 16_383));
    assert.ok(
      Math.abs(result.width / result.height - width / height) < 0.001
    );
    assert.ok(result.buffer.length <= 4_000_000);
  }
});

test("EXIF orientation is normalized before dimensions and metadata is stripped", async () => {
  const input = await solid(300, 200, "jpeg", { orientation: 6 });
  const result = await processStaticImage({
    input,
    claimedMimeType: "image/jpeg",
    profile: SUBMISSION_MEDIA_PROFILE,
  });
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(result.width, 200);
  assert.equal(result.height, 300);
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
});

test("bounded output attempts fail clearly when no result can fit", async () => {
  await expectMediaError(
    processStaticImage({
      input: await solid(100, 100, "png"),
      claimedMimeType: "image/png",
      profile: { ...SUBMISSION_MEDIA_PROFILE, maxOutputBytes: 1 },
    }),
    ["MEDIA_OUTPUT_TOO_LARGE"]
  );
});

test("avatar profile enforces source bounds and emits deterministic 512 square", async () => {
  const result = await processStaticImage({
    input: await solid(300, 256, "jpeg"),
    claimedMimeType: "image/jpeg",
    profile: AVATAR_MEDIA_PROFILE,
  });
  assert.equal(result.width, 512);
  assert.equal(result.height, 512);
  assert.equal((await sharp(result.buffer).metadata()).format, "webp");

  await expectMediaError(
    processStaticImage({
      input: await solid(255, 300, "png"),
      claimedMimeType: "image/png",
      profile: AVATAR_MEDIA_PROFILE,
    }),
    ["MEDIA_SOURCE_TOO_SMALL"]
  );
  await expectMediaError(
    processStaticImage({
      input: await solid(4097, 1, "png"),
      claimedMimeType: "image/png",
      profile: AVATAR_MEDIA_PROFILE,
    }),
    ["MEDIA_WIDTH_EXCEEDED"]
  );
});

test("only the central submission-media allowlist is countable", () => {
  assert.equal(isCountableSubmissionMediaErrorCode("MEDIA_CORRUPT"), true);
  for (const code of [
    "R2_PROVIDER_ERROR",
    "UPLOAD_DEPENDENCY_UNAVAILABLE",
    "SUBMISSION_PHASE_CLOSED",
    "RULES_NOT_ACCEPTED",
    "UPLOAD_LIMIT_REACHED",
    "IDEMPOTENCY_CONFLICT",
    "INVALID_PRIVATE_DATA",
  ]) {
    assert.equal(isCountableSubmissionMediaErrorCode(code), false);
  }
});
