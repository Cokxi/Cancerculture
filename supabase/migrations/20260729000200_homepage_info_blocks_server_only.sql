drop policy if exists homepage_info_blocks_public_active_select
  on public.homepage_info_blocks;

revoke all privileges on table public.homepage_info_blocks
  from public, anon, authenticated;

revoke select (
  id,
  seed_key,
  title,
  body,
  display_order,
  is_active,
  link_label,
  link_url,
  created_at,
  updated_at,
  created_by,
  updated_by
) on public.homepage_info_blocks from public, anon, authenticated;

revoke insert (
  id,
  seed_key,
  title,
  body,
  display_order,
  is_active,
  link_label,
  link_url,
  created_at,
  updated_at,
  created_by,
  updated_by
) on public.homepage_info_blocks from public, anon, authenticated;

revoke update (
  id,
  seed_key,
  title,
  body,
  display_order,
  is_active,
  link_label,
  link_url,
  created_at,
  updated_at,
  created_by,
  updated_by
) on public.homepage_info_blocks from public, anon, authenticated;

revoke references (
  id,
  seed_key,
  title,
  body,
  display_order,
  is_active,
  link_label,
  link_url,
  created_at,
  updated_at,
  created_by,
  updated_by
) on public.homepage_info_blocks from public, anon, authenticated;

revoke all privileges on sequence public.homepage_info_blocks_id_seq
  from public, anon, authenticated;

revoke execute
  on function public.set_homepage_info_blocks_updated_at()
  from public, anon, authenticated;

grant all privileges on table public.homepage_info_blocks
  to service_role;

grant all privileges on sequence public.homepage_info_blocks_id_seq
  to service_role;

grant execute
  on function public.set_homepage_info_blocks_updated_at()
  to service_role;
