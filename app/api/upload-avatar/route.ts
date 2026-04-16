export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/db/admin";
import { r2 } from "@/lib/r2";
import sharp from "sharp";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const discord_user_id = session.discord_user_id;

    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    
    const processedImage = await sharp(buffer)
      .resize(256, 256, {
        fit: "cover", 
      })
      .png({ quality: 90 })
      .toBuffer();

    const key = `avatars/${discord_user_id}.png`;

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: processedImage,
        ContentType: "image/png",
      })
    );

    await supabaseAdmin
      .from("user_logs")
      .update({
        avatar_key: key,
        avatar_updated_at: new Date().toISOString(),
      })
      .eq("discord_user_id", discord_user_id);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[UPLOAD AVATAR]", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}