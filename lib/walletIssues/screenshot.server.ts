import "server-only";

import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  WALLET_ISSUE_SCREENSHOT_MAX_BYTES,
  WALLET_ISSUE_SCREENSHOT_TYPES,
} from "@/lib/walletIssues/contract";

export class WalletIssueScreenshotError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "WalletIssueScreenshotError";
  }
}
export async function normalizeWalletIssueScreenshot(file: File | null) {
  if (!file || file.size === 0) return null;
  if (
    file.size > WALLET_ISSUE_SCREENSHOT_MAX_BYTES ||
    !WALLET_ISSUE_SCREENSHOT_TYPES.includes(
      file.type as (typeof WALLET_ISSUE_SCREENSHOT_TYPES)[number]
    )
  ) {
    throw new WalletIssueScreenshotError("WALLET_ISSUE_SCREENSHOT_INVALID");
  }
  try {
    const source = Buffer.from(await file.arrayBuffer());
    const image = sharp(source, {
      animated: false,
      failOn: "error",
      limitInputPixels: 40_000_000,
    });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw new Error("invalid image");
    }
    const data = await image
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    if (data.length < 1 || data.length > WALLET_ISSUE_SCREENSHOT_MAX_BYTES) {
      throw new Error("invalid output size");
    }
    return Object.freeze({
      data,
      mime: "image/webp" as const,
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
    });
  } catch (error) {
    if (error instanceof WalletIssueScreenshotError) throw error;
    throw new WalletIssueScreenshotError("WALLET_ISSUE_SCREENSHOT_INVALID");
  }
}
