import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  getSponsorBannerStorageKey,
  isSponsorDetailBannerKey,
  isSponsorFeedBannerKey,
  normalizeSponsorBanner,
} from "../../lib/sponsors/bannerMedia.server.ts";

const operationId = "00000000-0000-4000-8000-000000000015";

async function imageFile({ width, height, format = "png", type = "image/png" }) {
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 80, g: 40, b: 20 },
    },
  });
  pipeline =
    format === "jpeg"
      ? pipeline.jpeg()
      : format === "webp"
        ? pipeline.webp()
        : pipeline.png();
  return new File([await pipeline.toBuffer()], `banner.${format}`, { type });
}

test("Sponsor banner roles require purpose-built exact ratios and normalize dimensions", async () => {
  const detail = await normalizeSponsorBanner({
    file: await imageFile({ width: 2400, height: 1200 }),
    role: "detail",
  });
  const feed = await normalizeSponsorBanner({
    file: await imageFile({
      width: 3600,
      height: 600,
      format: "jpeg",
      type: "image/jpeg",
    }),
    role: "feed",
  });
  assert.deepEqual(
    { width: detail.width, height: detail.height },
    { width: 1200, height: 600 }
  );
  assert.deepEqual(
    { width: feed.width, height: feed.height },
    { width: 1800, height: 300 }
  );
  assert.equal((await sharp(detail.bytes).metadata()).format, "webp");
  assert.equal((await sharp(feed.bytes).metadata()).format, "webp");
});

test("wrong ratios, undersized inputs, and MIME/decoder mismatches fail closed", async () => {
  await assert.rejects(
    normalizeSponsorBanner({
      file: await imageFile({ width: 1800, height: 300 }),
      role: "detail",
    }),
    /SPONSOR_DETAIL_BANNER_DIMENSIONS_INVALID/u
  );
  await assert.rejects(
    normalizeSponsorBanner({
      file: await imageFile({ width: 1200, height: 200 }),
      role: "feed",
    }),
    /SPONSOR_FEED_BANNER_DIMENSIONS_INVALID/u
  );
  await assert.rejects(
    normalizeSponsorBanner({
      file: await imageFile({
        width: 1200,
        height: 600,
        format: "png",
        type: "image/jpeg",
      }),
      role: "detail",
    }),
    /SPONSOR_BANNER_DECODE_INVALID/u
  );
  await assert.rejects(
    normalizeSponsorBanner({
      file: new File(
        [Buffer.alloc(4 * 1024 * 1024 + 1)],
        "oversized.webp",
        { type: "image/webp" }
      ),
      role: "feed",
    }),
    /SPONSOR_BANNER_FILE_SIZE_INVALID/u
  );
});

test("detail and Feed keys use non-interchangeable namespaces", () => {
  const detail = getSponsorBannerStorageKey("detail", operationId);
  const feed = getSponsorBannerStorageKey("feed", operationId);
  assert.equal(isSponsorDetailBannerKey(detail), true);
  assert.equal(isSponsorFeedBannerKey(detail), false);
  assert.equal(isSponsorFeedBannerKey(feed), true);
  assert.equal(isSponsorDetailBannerKey(feed), false);
});
