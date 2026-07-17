# DEV and LIVE object inventory

Observed from the approved DEV and LIVE databases on 2026-07-17. Definitions,
columns, defaults, generated/identity metadata, constraints, indexes, function
bodies, trigger definitions, policies, and ACL statements are preserved in
`dev-schema.sql` and `live-schema.sql`.

## Counts

| Object | Count |
|---|---:|
| Public tables | 41 |
| Views | 3 |
| Materialized views | 0 |
| Functions/RPCs | 42 |
| Non-internal triggers | 7 |
| RLS policies | 6 |
| RLS-enabled tables | 39 |
| Indexes | 109 |
| Partial indexes | 14 |
| Unique indexes | 59 |
| Primary keys | 41 |
| Foreign keys | 22 |
| Unique constraints | 10 |
| Check constraints | 61 |
| Sequences | 17 |
| Custom enum types | 1 |

## Schemas and extensions

Observed non-system schemas:

`auth`, `extensions`, `graphql`, `graphql_public`, `public`, `realtime`,
`storage`, `vault`.

Observed extensions:

`pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`.

No `public` foreign key references an `auth` or `storage` table. Provider-owned
relationships inside those schemas are intentionally not reproduced here.

## Tables

`admin_action_logs`, `admin_invites`, `app_config`, `avatar_upload_logs`,
`blocked_cycle_events`, `blocked_user_meta`, `coin_launches`, `cycle_events`,
`cycle_reminders`, `cycle_results`, `cycle_rule_templates`,
`cycle_sponsorships`, `discord_guard_logs`, `discord_member_state`,
`discord_membership_sync_events`, `discord_reconciliation_bans`,
`discord_reconciliation_members`, `discord_reconciliation_snapshots`,
`discord_sync_health`, `invite_auth_logs`, `media_cleanup_queue`,
`moderation_action_logs`, `next_cycle_config`, `rules_meta`, `sessions`,
`social_verification_logs`, `sponsor_tracking_events`,
`submission_private_data`, `submission_social_links`,
`submission_upload_abuse_states`, `submission_upload_operations`,
`submissions`, `team_members`, `upload_logs`, `user_cycle_acceptance`,
`user_logs`, `user_social_links`, `vote_logs`, `votes`, `voting_cycles`,
`winner_public_profiles`.

## Views

- `public_submissions_with_votes`
- `submissions_with_votes`
- `user_logs_with_stats`

## Sequences

`avatar_upload_logs_id_seq`, `coin_launches_id_seq`, `cycle_results_id_seq`,
`cycle_rule_templates_id_seq`, `cycle_sponsorships_id_seq`,
`discord_guard_logs_id_seq`, `invite_auth_logs_id_seq`,
`media_cleanup_queue_id_seq`, `social_verification_logs_id_seq`,
`sponsor_tracking_events_id_seq`, `submission_private_data_id_seq`,
`submission_social_links_id_seq`, `submissions_id_seq`,
`user_social_links_id_seq`, `votes_id_seq`, `voting_cycles_id_seq`,
`winner_public_profiles_id_seq`.

## Custom type

`public.voting_cycle_status` contains, in stored enum order:

`active`, `finalizing`, `finished`, `draft`, `submission_open`,
`submission_closed`, `voting_open`, `voting_closed`, `completed`, `archived`,
`cancelled`, `paused`.

## Function security

All 42 complete definitions and signatures are in `dev-schema.sql`.

- 39 functions are `SECURITY DEFINER`.
- 38 of those pin `search_path` to `public, pg_temp`.
- `sync_discord_user_context(text,text,text,text)` is `SECURITY DEFINER` with
  `search_path=public` and remains executable through PUBLIC.
- `media_cleanup_retry_delay(integer)` is immutable and invoker-security.
- `reset_social_verification_on_change()` and
  `set_user_logs_updated_at()` are invoker-security trigger functions.
- 30 functions are executable by `service_role`.
- `anon` and `authenticated` can execute only the three PUBLIC legacy/helper
  functions above; application RPCs are not executable by those roles.
- `discord_bot` has the same PUBLIC helper access and no dedicated application
  RPC grant. Its only direct table privilege is INSERT on `discord_guard_logs`.

Security-sensitive RPC groups:

- Cycle: `cast_cycle_vote`, `finalize_cycle`, `process_due_cycle_transitions`,
  `reset_cycle`, `start_cycle`.
- Upload: `reserve_submission_upload`,
  `mark_submission_upload_r2_uploaded`, `commit_submission_upload`,
  `enqueue_submission_upload_cleanup`, `recover_stale_submission_uploads`,
  `get_submission_upload_abuse_status`, `register_invalid_submission_upload`,
  `unblock_submission_upload`.
- Cleanup: `claim_media_cleanup_jobs`, `complete_media_cleanup_job`,
  `fail_media_cleanup_job`, `media_cleanup_retry_delay`.
- Discord: membership live-event wrappers, reconciliation snapshot functions,
  session access/session creation, Ban enforcement, and Admin republish.

## Triggers

| Table | Trigger | Function |
|---|---|---|
| `discord_member_state` | `discord_member_state_submission_enforcement_trigger` | `enforce_discord_ban_submissions_trigger()` |
| `submission_upload_operations` | `submission_upload_operations_abuse_block_trigger` | `enforce_submission_upload_abuse_block()` |
| `submission_upload_operations` | `submission_upload_operations_discord_access_trigger` | `enforce_discord_authenticated_action()` |
| `submissions` | `submissions_discord_ban_republish_guard_trigger` | `protect_discord_ban_republish()` |
| `submissions` | `submissions_enqueue_deleted_media` | `enqueue_deleted_submission_media()` |
| `user_logs` | `trg_user_logs_updated_at` | `set_user_logs_updated_at()` |
| `user_social_links` | `user_social_links_reset_verification_trigger` | `reset_social_verification_on_change()` |

The compatibility migration correctly removed the earlier Vote and Submission
authenticated-action triggers; Vote enforcement is inside `cast_cycle_vote`,
and Submission writes are mediated by the upload operation trigger/RPC path.

## RLS and policies

RLS is enabled on 39 of 41 public tables. `cycle_events` and
`cycle_reminders` have RLS disabled, but neither `anon` nor `authenticated`
currently has table privileges.

Policies:

- `cycle_results.public_read`: SELECT for `anon`, `authenticated`.
- `discord_guard_logs.discord_bot_insert_guard_logs`: INSERT for
  `discord_bot`.
- `discord_member_state.discord_bot_full_access_member_state`: ALL for
  `discord_bot`.
- `votes.Allow realtime read access to votes`: SELECT for `anon`,
  `authenticated`.
- `voting_cycles.public_read`: SELECT for `anon`, `authenticated`.
- `winner_public_profiles.public_read`: SELECT for `anon`, `authenticated`.

The read policies are currently inert for `anon` and `authenticated`, because
those roles have no table/view privileges. `discord_bot` likewise has no table
privilege on `discord_member_state`, so that legacy policy does not provide
direct access.

## Effective table/view grants

| Role | SELECT objects | INSERT objects | UPDATE objects | DELETE objects |
|---|---:|---:|---:|---:|
| `anon` | 0 | 0 | 0 | 0 |
| `authenticated` | 0 | 0 | 0 | 0 |
| `discord_bot` | 0 | 1 | 0 | 0 |
| `service_role` | 44 | 44 | 44 | 44 |

The 44 service-role objects are the 41 tables plus 3 views.

## Final LIVE parity

DEV and LIVE each contain 41 tables, 3 views, 42 functions, 7 non-internal
triggers, and 6 policies. Canonical comparison confirms identical column
definitions, constraints, indexes, views, trigger definitions, RLS flags,
policies, and 309 relevant table/view grant rows.

LIVE differs intentionally in two non-functional ways:

- 35 columns on pre-existing tables have different ordinal positions because
  LIVE received them through `ALTER TABLE`; names, types, defaults, nullability,
  generated/identity state, constraints, and application behavior match DEV.
- `sync_discord_user_context(text,text,text,text)` is hardened on LIVE with
  `search_path=public,pg_temp`, no PUBLIC/anon/authenticated execute, and
  explicit execute only for `service_role` and `discord_bot`. This is stricter
  than the observed DEV snapshot and is encoded in catch-up package F.

After the reset, all 41 public tables are empty except the required singleton
row in `discord_sync_health`. There is no active Cycle, Auth user, or Storage
object.
