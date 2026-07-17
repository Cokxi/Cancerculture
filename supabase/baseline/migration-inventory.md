# Git migration inventory

The repository contains 13 historical migrations plus 6 reviewed LIVE
catch-up packages. Historical files were not modified.

| Migration | Main objects and effects | Security/overlap notes |
|---|---|---|
| `20260712000100_phase_based_cycle_foundation.sql` | Adds `pgcrypto`, extends `voting_cycle_status`, alters `voting_cycles`, creates `cycle_events` and `cycle_reminders`, adds timing/sponsorship metadata and 5 indexes. | Assumes `voting_cycles`, `app_config`, and optional `cycle_sponsorships` already exist. |
| `20260712000200_cycle_pause_and_multi_vote.sql` | Adds `paused` behavior and constraints, changes Vote uniqueness, replaces `cast_cycle_vote`. | First of three definitions of `cast_cycle_vote`; later corrected by migrations 007 and 008. |
| `20260712000300_coin_launch_links.sql` | Creates `coin_launches`, 2 indexes, enables RLS. | No public policy is created. |
| `20260712000400_remove_legacy_launch_config.sql` | Deletes legacy launch/wallet keys from `app_config`. | Data-changing cleanup; potentially destructive if replayed. |
| `20260714000100_transactional_cycle_finalization.sql` | Extends `cycle_results`, adds 2 result indexes, creates `finalize_cycle`. | Service-role-only RPC. |
| `20260715000100_reset_cycle_recovery.sql` | Adds reset metadata to `voting_cycles`, creates `media_cleanup_queue`, queue index, and `reset_cycle`. | Queue is later substantially tightened by migration 003. |
| `20260715000200_transactional_cycle_start_and_phase_automation.sql` | Adds one-current-cycle partial unique index, creates `start_cycle` and `process_due_cycle_transitions`. | Service-role-only; depends on pre-existing config/audit tables. |
| `20260715000300_lease_based_media_cleanup_worker.sql` | Reworks `media_cleanup_queue` status/lease/retry constraints, adds 2 indexes and 4 worker functions. | Corrective/expanding migration over reset recovery. |
| `20260715000400_transactional_submission_upload_saga.sql` | Creates `submission_upload_operations`, 5 indexes, 7 functions and `submissions_enqueue_deleted_media`. | Depends on pre-existing Submission, private/social, session, and user tables. |
| `20260715000500_static_media_upload_abuse_protection.sql` | Creates `submission_upload_abuse_states`, 2 indexes, 4 functions and abuse-block trigger. | Extends the upload saga and tightens RPC grants. |
| `20260715000600_discord_ban_membership_sync.sql` | Extends `discord_member_state`; creates 5 sync/snapshot tables, 4 indexes, 15 functions and 3 authenticated-action triggers. | Migration 007 intentionally removes 2 of these triggers and replaces Vote behavior. File is unchanged. |
| `20260716000100_discord_authenticated_action_trigger_compatibility.sql` | Drops Vote/Submission authenticated-action triggers and replaces `cast_cycle_vote`. | Corrective compatibility migration; must follow 006. File is unchanged. |
| `20260716000200_discord_ban_submission_enforcement.sql` | Extends `submissions`, creates `public_submissions_with_votes`, 2 indexes, 5 functions and 2 Ban/republish triggers. | Replaces `cast_cycle_vote` again and declares public-view SELECT grants. |

## Overlaps and corrections

- `cast_cycle_vote` is defined in migrations
  `20260712000200`, `20260716000100`, and `20260716000200`; only the final
  definition is authoritative.
- `media_cleanup_queue` is created in `20260715000100` and structurally
  tightened in `20260715000300`.
- `submission_upload_operations` is created in `20260715000400` and receives
  abuse and Discord access triggers in later migrations.
- Migration 006 creates three authenticated-action triggers; migration 007
  intentionally drops the Vote and direct Submission triggers.
- Migration 008 adds Submission visibility/disqualification enforcement and
  replaces the Vote RPC after migration 007.
- Migration 004 is not schema-only: it removes legacy `app_config` data.

## Reproducibility limitation

The migrations mention 16 of the 41 DEV tables, 1 of 3 views, and 39 of 42
functions. They therefore cannot bootstrap an empty database. The observed DEV
baseline captures the missing pre-migration layer but is not itself an approved
bootstrap migration.

DEV also lacks `supabase_migrations.schema_migrations`, so no standard ledger
confirms which files were applied or whether they were applied manually.

## LIVE catch-up packages applied on 2026-07-17

| Order | Migration | Purpose | Result |
|---:|---|---|---|
| A | `20260717000100_live_catchup_public_boot.sql` | Phase/Cycle foundation and Coin Launch schema | Applied |
| B | `20260717000200_live_catchup_discord_sessions_bans.sql` | Discord sync, sessions, Ban hide/disqualification and republish | Applied |
| C | `20260717000300_live_catchup_cycle_infrastructure.sql` | Multi-vote, finalization, reset, start, automation, final Vote RPC | Applied |
| D | `20260717000400_live_catchup_upload_media.sql` | Media lease worker, upload saga, abuse guard, deferred Discord trigger | Applied |
| E | `20260717000500_live_catchup_retained_legacy.sql` | Fail-closed verification of 25 tables, 2 views and 3 retained Legacy functions | Applied |
| F | `20260717000600_live_catchup_security.sql` | RLS/grants/search-path/PUBLIC-execute hardening | Applied |

The packages were applied directly to the explicitly verified LIVE target with
`psql`, `ON_ERROR_STOP`, and per-package postflight introspection. The
data-changing historical migration `20260712000400` was not replayed; its
obsolete keys were absent after the authorized application-data reset.
