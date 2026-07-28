begin;

create index if not exists winner_public_profiles_wall_created_at_id_idx
  on public.winner_public_profiles (wall, created_at desc, id desc);

create index if not exists submissions_cycle_id_id_idx
  on public.submissions (cycle_id, id);

commit;
