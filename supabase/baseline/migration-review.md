# LIVE catch-up execution record

Executed on 2026-07-17 against the explicitly verified LIVE project. This file
records the completed operation; it is not a general reset procedure.

## Backup and preflight

- Read-only preflight: successful (`SELECT 1`, database `postgres`, role
  `postgres`).
- Pre-catch-up schema hash:
  `1BC4A23868F394DF48FDD7EA2D5D0773144F6326F9ED04CC09783C4B277BED5C`.
- External backup ID: `20260717T080535-pre-catchup`.
- Backup contains one full `public` schema-only SQL file and one compressed
  custom-format data dump with 30 public TABLE DATA and 15 sequence entries.
- Backup validation found zero foreign-schema data entries and zero connection
  strings in the schema dump.
- Supabase platform-backup availability could not be established safely from
  the database connection alone; no Management API token was used.

## Explicit reset scope

The following 30 CancerCulture `public` tables were truncated once, in one
transaction, with `RESTART IDENTITY CASCADE`:

`admin_action_logs`, `admin_invites`, `app_config`, `avatar_upload_logs`,
`blocked_cycle_events`, `blocked_user_meta`, `cycle_results`,
`cycle_rule_templates`, `cycle_sponsorships`, `discord_guard_logs`,
`discord_member_state`, `invite_auth_logs`, `moderation_action_logs`,
`next_cycle_config`, `rules_meta`, `sessions`, `social_verification_logs`,
`sponsor_tracking_events`, `submission_private_data`,
`submission_social_links`, `submissions`, `team_members`, `upload_logs`,
`user_cycle_acceptance`, `user_logs`, `user_social_links`, `vote_logs`,
`votes`, `voting_cycles`, `winner_public_profiles`.

Preflight confirmed zero cross-schema foreign keys, zero TRUNCATE triggers, and
zero non-public tables depending on this scope. Postflight confirmed all 30
tables empty and Auth/Storage unchanged.

## Applied packages

| Package | Migration | Result | Postflight |
|---|---|---|---|
| A | `20260717000100_live_catchup_public_boot.sql` | Applied | Cycle events/reminders and Coin Launch present |
| B | `20260717000200_live_catchup_discord_sessions_bans.sql` | Applied | 5 sync tables, secure Submission view, Ban and republish triggers present |
| C | `20260717000300_live_catchup_cycle_infrastructure.sql` | Applied | Vote, finalization, reset, start and automation RPCs present; compatibility triggers absent |
| D | `20260717000400_live_catchup_upload_media.sql` | Applied | Upload, abuse and cleanup tables/trigger present and empty |
| E | `20260717000500_live_catchup_retained_legacy.sql` | Applied | 25 tables, 2 views and 3 Legacy functions verified |
| F | `20260717000600_live_catchup_security.sql` | Applied | PUBLIC execute on privileged functions: 0; browser table grants: 0 |

All package applications used `psql`, `ON_ERROR_STOP`, and a freshly redacted
LIVE/DEV project-ref comparison. No Recovery, cleanup, upload, Vote,
finalization, Cycle reset, or Discord action was invoked.

## Website milestones

- Before catch-up: `/` 500, `/submissions` 500, `/cycle-history` 200,
  Fame/Shame 200.
- After packages A and B: `/` and `/submissions` remained 500.
- After package C: `/`, `/submissions`, `/cycle-history`, Fame and Shame all
  returned 200.
- After packages D, E and F: all five routes remained 200 with no detected
  server-side crash marker.

## Final state

- No neutral `app_config` row or Draft Cycle was inserted because the current
  Website renders successfully without either.
- The only non-empty public table is `discord_sync_health` with its required
  singleton reconciliation-health row.
- Final LIVE schema hash:
  `CAA8FF402A51C3BA3896FA6F16928A757B31CD214DDD339685B74166614819A6`.
- No full launch approval is implied by this database catch-up.
