import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readInitialMigration = () =>
  readFile(
    new URL(
      "../../supabase/migrations/20260729000100_homepage_info_blocks.sql",
      import.meta.url
    ),
    "utf8"
  );

const readServerOnlyMigration = () =>
  readFile(
    new URL(
      "../../supabase/migrations/20260729000200_homepage_info_blocks_server_only.sql",
      import.meta.url
    ),
    "utf8"
  );

test("Homepage Info migration creates constrained ordered records", async () => {
  const sql = await readInitialMigration();

  assert.match(
    sql,
    /create table if not exists public\.homepage_info_blocks/
  );
  for (const column of [
    "id bigint",
    "title text",
    "body text not null",
    "display_order integer not null",
    "is_active boolean not null",
    "link_label text",
    "link_url text",
    "created_at timestamptz",
    "updated_at timestamptz",
    "created_by text",
    "updated_by text",
  ]) {
    assert.match(sql, new RegExp(column));
  }
  assert.match(sql, /char_length\(title\) between 1 and 120/);
  assert.match(sql, /char_length\(body\) between 1 and 5000/);
  assert.match(sql, /display_order between 0 and 100000/);
  assert.match(sql, /homepage_info_blocks_link_pair_check/);
  assert.match(sql, /homepage_info_blocks_link_url_check/);
  assert.match(sql, /set_homepage_info_blocks_updated_at/);
  assert.match(sql, /before update on public\.homepage_info_blocks/);
});

test("initial Homepage Info migration remains byte-for-byte unchanged", async () => {
  const sql = await readFile(
    new URL(
      "../../supabase/migrations/20260729000100_homepage_info_blocks.sql",
      import.meta.url
    )
  );

  assert.equal(
    createHash("sha256").update(sql).digest("hex").toUpperCase(),
    "D754F71B1A559DAA966AB99B8BFCA591003AD7A1BF33A6DBE66C694FEE932BFF"
  );
});

test("server-only follow-up removes every direct public access path", async () => {
  const sql = await readServerOnlyMigration();

  assert.match(
    sql,
    /drop policy if exists homepage_info_blocks_public_active_select/
  );
  assert.match(
    sql,
    /revoke all privileges on table public\.homepage_info_blocks[\s\S]*?from public, anon, authenticated/
  );
  for (const privilege of ["select", "insert", "update", "references"]) {
    assert.match(
      sql,
      new RegExp(
        `revoke ${privilege} \\([\\s\\S]*?\\) on public\\.homepage_info_blocks from public, anon, authenticated`
      )
    );
  }
  assert.match(
    sql,
    /revoke all privileges on sequence public\.homepage_info_blocks_id_seq[\s\S]*?from public, anon, authenticated/
  );
  assert.match(
    sql,
    /revoke execute[\s\S]*?set_homepage_info_blocks_updated_at\(\)[\s\S]*?from public, anon, authenticated/
  );
  assert.doesNotMatch(sql, /grant\s+usage\s+on\s+schema\s+public/i);
  assert.doesNotMatch(sql, /create policy|alter table .* disable row level security/i);
  assert.doesNotMatch(sql, /\bbegin\s*;|\bcommit\s*;/i);
});

test("server-only follow-up preserves Service Role CRUD without touching unrelated objects", async () => {
  const sql = await readServerOnlyMigration();

  assert.match(
    sql,
    /grant all privileges on table public\.homepage_info_blocks[\s\S]*?to service_role/
  );
  assert.match(
    sql,
    /grant all privileges on sequence public\.homepage_info_blocks_id_seq[\s\S]*?to service_role/
  );
  assert.match(
    sql,
    /grant execute[\s\S]*?set_homepage_info_blocks_updated_at\(\)[\s\S]*?to service_role/
  );

  const publicObjectNames = [
    ...sql.matchAll(/public\.([a-z_][a-z0-9_]*)/gi),
  ].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(publicObjectNames)].sort(),
    [
      "homepage_info_blocks",
      "homepage_info_blocks_id_seq",
      "set_homepage_info_blocks_updated_at",
    ]
  );
});

test("public ordering index and initial records are deterministic and idempotent", async () => {
  const sql = await readInitialMigration();

  assert.match(
    sql,
    /homepage_info_blocks_active_order_idx[\s\S]*?\(display_order, id\)[\s\S]*?where is_active = true/
  );
  assert.match(sql, /'about'/);
  assert.match(sql, /'how-it-works'/);
  assert.match(
    sql,
    /CancerCulture is a community-driven meme competition built around creativity and chaos\./
  );
  assert.match(sql, /Winners choose: keep it, donate, or split\./);
  assert.match(sql, /on conflict \(seed_key\) do nothing/);
  assert.equal(sql.match(/'about'/g)?.length, 1);
  assert.equal(sql.match(/'how-it-works'/g)?.length, 1);
});
