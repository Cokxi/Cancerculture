begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regclass('public.sessions') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.submissions') is null
    or to_regclass('public.voting_cycles') is null
    or to_regclass('public.cycle_results') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regclass('public.account_saved_memes') is not null
    or to_regprocedure('public.is_saved_meme_publicly_available(bigint)') is not null
    or to_regprocedure('public.set_account_saved_meme(uuid,bigint,boolean)') is not null
    or to_regprocedure('public.get_account_saved_meme_status(uuid,bigint[])') is not null
    or to_regprocedure('public.list_account_saved_memes(uuid,timestamptz,bigint,integer)') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SAVED_MEMES_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create table public.account_saved_memes (
  id bigint generated always as identity primary key,
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  submission_id bigint
    references public.submissions(id) on delete set null,
  original_submission_id bigint not null check (original_submission_id > 0),
  saved_at timestamptz not null default transaction_timestamp(),
  constraint account_saved_memes_submission_identity_check check (
    submission_id is null or submission_id = original_submission_id
  ),
  unique (discord_user_id, original_submission_id)
);

create index account_saved_memes_owner_page_idx
  on public.account_saved_memes(discord_user_id, saved_at desc, id desc);

alter table public.account_saved_memes enable row level security;
revoke all on table public.account_saved_memes
  from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.account_saved_memes_id_seq
  from public, anon, authenticated, discord_bot, service_role;

create function public.is_saved_meme_publicly_available(
  p_submission_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists (
    select 1
    from public.submissions submission
    join public.voting_cycles cycle on cycle.id = submission.cycle_id
    where submission.id = p_submission_id
      and submission.public_visibility_status = 'visible'
      and coalesce(submission.is_disqualified, false) = false
      and cycle.public_number is not null
      and (
        cycle.status in (
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'active'
        )
        or (
          cycle.status = 'finished'
          and exists (
            select 1
            from public.cycle_results result
            where result.submission_id = submission.id
              and result.cycle_id = submission.cycle_id
              and result.feed_classification_version = 1
              and result.feed_eligible = true
              and result.final_vote_count > 0
              and result.rank_in_cycle is not null
              and result.finalized_at is not null
          )
        )
      )
  );
$function$;

create function public.set_account_saved_meme(
  p_session_id uuid,
  p_submission_id bigint,
  p_saved boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_outcome text;
  v_changed boolean := false;
begin
  if p_submission_id is null
    or p_submission_id <= 0
    or p_saved is null
  then
    raise exception using
      errcode = '22023',
      message = 'ACCOUNT_SAVED_MEME_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);
  perform pg_advisory_xact_lock(
    hashtextextended(
      'account-saved-meme:' || v_owner_id || ':' || p_submission_id::text,
      0
    )
  );

  if not p_saved then
    delete from public.account_saved_memes
    where discord_user_id = v_owner_id
      and original_submission_id = p_submission_id;
    v_changed := found;
    v_outcome := case when v_changed then 'removed' else 'unchanged' end;

    return jsonb_build_object(
      'outcome', v_outcome,
      'submissionId', p_submission_id,
      'saved', false,
      'changed', v_changed
    );
  end if;

  if not public.is_saved_meme_publicly_available(p_submission_id) then
    v_outcome := 'not_public';
    return jsonb_build_object(
      'outcome', v_outcome,
      'submissionId', p_submission_id,
      'saved', false,
      'changed', false
    );
  end if;

  insert into public.account_saved_memes (
    discord_user_id,
    submission_id,
    original_submission_id
  )
  values (v_owner_id, p_submission_id, p_submission_id)
  on conflict (discord_user_id, original_submission_id) do nothing;
  v_changed := found;
  v_outcome := case when v_changed then 'saved' else 'unchanged' end;

  return jsonb_build_object(
    'outcome', v_outcome,
    'submissionId', p_submission_id,
    'saved', true,
    'changed', v_changed
  );
end;
$function$;

create function public.get_account_saved_meme_status(
  p_session_id uuid,
  p_submission_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_saved_ids jsonb;
begin
  if p_submission_ids is null
    or cardinality(p_submission_ids) > 100
    or exists (
      select 1
      from unnest(p_submission_ids) value
      where value is null or value <= 0
    )
  then
    raise exception using
      errcode = '22023',
      message = 'ACCOUNT_SAVED_MEME_STATUS_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);

  select coalesce(
    jsonb_agg(saved.original_submission_id order by saved.original_submission_id),
    '[]'::jsonb
  )
  into v_saved_ids
  from public.account_saved_memes saved
  where saved.discord_user_id = v_owner_id
    and saved.original_submission_id = any(p_submission_ids);

  return jsonb_build_object(
    'outcome', 'ok',
    'savedSubmissionIds', v_saved_ids
  );
end;
$function$;

create function public.list_account_saved_memes(
  p_session_id uuid,
  p_before_saved_at timestamptz,
  p_before_id bigint,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_items jsonb;
  v_last_saved_at timestamptz;
  v_last_id bigint;
  v_has_more boolean := false;
begin
  if p_limit is null
    or p_limit not between 1 and 48
    or ((p_before_saved_at is null) <> (p_before_id is null))
    or (p_before_id is not null and p_before_id <= 0)
  then
    raise exception using
      errcode = '22023',
      message = 'ACCOUNT_SAVED_MEME_PAGE_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);

  with page_rows as (
    select
      saved.id,
      saved.original_submission_id,
      saved.saved_at,
      available.is_public,
      case when available.is_public then cycle.public_number else null end
        as cycle_number,
      case when available.is_public then submission.media_width else null end
        as media_width,
      case when available.is_public then submission.media_height else null end
        as media_height
    from public.account_saved_memes saved
    left join public.submissions submission
      on submission.id = saved.submission_id
    left join public.voting_cycles cycle
      on cycle.id = submission.cycle_id
    cross join lateral (
      select public.is_saved_meme_publicly_available(
        saved.original_submission_id
      ) as is_public
    ) available
    where saved.discord_user_id = v_owner_id
      and (
        p_before_saved_at is null
        or (saved.saved_at, saved.id) < (p_before_saved_at, p_before_id)
      )
    order by saved.saved_at desc, saved.id desc
    limit p_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'bookmarkId', page_rows.id,
          'submissionId', page_rows.original_submission_id,
          'savedAt', page_rows.saved_at,
          'available', page_rows.is_public,
          'cycleNumber', page_rows.cycle_number,
          'mediaWidth', page_rows.media_width,
          'mediaHeight', page_rows.media_height
        )
        order by page_rows.saved_at desc, page_rows.id desc
      ),
      '[]'::jsonb
    ),
    (array_agg(page_rows.saved_at order by page_rows.saved_at desc, page_rows.id desc))[p_limit],
    (array_agg(page_rows.id order by page_rows.saved_at desc, page_rows.id desc))[p_limit]
  into v_items, v_last_saved_at, v_last_id
  from page_rows;

  if v_last_id is not null then
    select exists (
      select 1
      from public.account_saved_memes saved
      where saved.discord_user_id = v_owner_id
        and (saved.saved_at, saved.id) < (v_last_saved_at, v_last_id)
    ) into v_has_more;
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'items', v_items,
    'nextCursor', case
      when v_has_more then jsonb_build_object(
        'savedAt', v_last_saved_at,
        'bookmarkId', v_last_id
      )
      else null
    end
  );
end;
$function$;

alter table public.account_saved_memes owner to postgres;
alter sequence public.account_saved_memes_id_seq owner to postgres;
alter function public.is_saved_meme_publicly_available(bigint) owner to postgres;
alter function public.set_account_saved_meme(uuid,bigint,boolean) owner to postgres;
alter function public.get_account_saved_meme_status(uuid,bigint[]) owner to postgres;
alter function public.list_account_saved_memes(uuid,timestamptz,bigint,integer) owner to postgres;

revoke all on function public.is_saved_meme_publicly_available(bigint)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_account_saved_meme(uuid,bigint,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_account_saved_meme_status(uuid,bigint[])
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_account_saved_memes(uuid,timestamptz,bigint,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.set_account_saved_meme(uuid,bigint,boolean)
  to service_role;
grant execute on function public.get_account_saved_meme_status(uuid,bigint[])
  to service_role;
grant execute on function public.list_account_saved_memes(uuid,timestamptz,bigint,integer)
  to service_role;

do $security_postflight$
declare
  v_signature text;
  v_service_signatures text[] := array[
    'public.set_account_saved_meme(uuid,bigint,boolean)',
    'public.get_account_saved_meme_status(uuid,bigint[])',
    'public.list_account_saved_memes(uuid,timestamptz,bigint,integer)'
  ];
  v_internal_signatures text[] := array[
    'public.is_saved_meme_publicly_available(bigint)'
  ];
begin
  foreach v_signature in array v_service_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc p
        where p.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef
          and p.proconfig @> array['search_path=public, pg_temp']
      )
      or exists (
        select 1
        from pg_proc p
        cross join lateral aclexplode(
          coalesce(p.proacl, acldefault('f', p.proowner))
        ) acl
        where p.oid = to_regprocedure(v_signature)
          and acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'ACCOUNT_SAVED_MEMES_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc p
        where p.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef
          and p.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'ACCOUNT_SAVED_MEMES_INTERNAL_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'is_saved_meme_publicly_available',
        'set_account_saved_meme',
        'get_account_saved_meme_status',
        'list_account_saved_memes'
      )
      and p.oid <> all(
        (v_service_signatures || v_internal_signatures)::regprocedure[]
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SAVED_MEMES_FUNCTION_OVERLOAD_MISMATCH';
  end if;

  if not exists (
    select 1
    from pg_class c
    where c.oid = 'public.account_saved_memes'::regclass
      and c.relrowsecurity
  )
    or exists (
      select 1
      from pg_policy p
      where p.polrelid = 'public.account_saved_memes'::regclass
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SAVED_MEMES_RLS_MISMATCH';
  end if;

  if has_table_privilege('anon', 'public.account_saved_memes', 'SELECT')
    or has_table_privilege('authenticated', 'public.account_saved_memes', 'SELECT')
    or has_table_privilege('discord_bot', 'public.account_saved_memes', 'SELECT')
    or has_table_privilege('service_role', 'public.account_saved_memes', 'SELECT')
    or has_table_privilege('service_role', 'public.account_saved_memes', 'INSERT')
    or has_table_privilege('service_role', 'public.account_saved_memes', 'UPDATE')
    or has_table_privilege('service_role', 'public.account_saved_memes', 'DELETE')
    or has_sequence_privilege(
      'service_role',
      'public.account_saved_memes_id_seq',
      'USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SAVED_MEMES_TABLE_ACL_MISMATCH';
  end if;
end;
$security_postflight$;

comment on table public.account_saved_memes is
  'Private owner bookmarks to canonical Submission IDs. No media, moderation reason, actor, analytics identifier, or copied public content is stored.';
comment on function public.set_account_saved_meme(uuid,bigint,boolean) is
  'Atomically saves only a currently public Feed meme or removes an owner bookmark even after the Submission becomes unavailable.';
comment on function public.list_account_saved_memes(uuid,timestamptz,bigint,integer) is
  'Returns a bounded owner-only saved-meme page. Unavailable originals are neutral tombstones without moderation or storage detail.';

commit;
