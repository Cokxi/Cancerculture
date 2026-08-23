begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $correction$
declare
  v_signature text;
  v_definition text;
  v_corrected text;
  v_signatures text[] := array[
    'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean)',
    'public.delete_community_comment(uuid,uuid,bigint,uuid,boolean)'
  ];
begin
  if to_regprocedure('extensions.digest(bytea,text)') is null
    or to_regclass('public.community_comment_settings') is null
    or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_DIGEST_CORRECTION_BASELINE_MISMATCH';
  end if;

  foreach v_signature in array v_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
    then
      raise exception using
        errcode = '55000',
        message = 'COMMUNITY_COMMENT_DIGEST_CORRECTION_FUNCTION_MISMATCH',
        detail = v_signature;
    end if;

    select pg_get_functiondef(to_regprocedure(v_signature))
    into strict v_definition;

    if v_definition like '%extensions.digest(%'
      or (
        length(v_definition) - length(replace(v_definition, 'digest(', ''))
      ) / length('digest(') <> 1
    then
      raise exception using
        errcode = '55000',
        message = 'COMMUNITY_COMMENT_DIGEST_CORRECTION_DEFINITION_MISMATCH',
        detail = v_signature;
    end if;

    v_corrected := replace(
      v_definition,
      'digest(',
      'extensions.digest('
    );
    execute v_corrected;
  end loop;
end;
$correction$;

do $postflight$
declare
  v_signature text;
  v_definition text;
  v_signatures text[] := array[
    'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean)',
    'public.delete_community_comment(uuid,uuid,bigint,uuid,boolean)'
  ];
begin
  foreach v_signature in array v_signatures loop
    select pg_get_functiondef(to_regprocedure(v_signature))
    into strict v_definition;

    if v_definition not like '%extensions.digest(%'
      or (
        length(v_definition) - length(replace(v_definition, 'extensions.digest(', ''))
      ) / length('extensions.digest(') <> 1
      or not exists (
        select 1
        from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'COMMUNITY_COMMENT_DIGEST_CORRECTION_POSTFLIGHT_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace on namespace.oid = function_row.pronamespace
    where namespace.nspname = 'public'
      and function_row.proname in (
        'create_community_comment_root',
        'create_community_comment_reply',
        'edit_community_comment',
        'delete_community_comment'
      )
      and function_row.oid <> all(v_signatures::regprocedure[])
  )
    or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_DIGEST_CORRECTION_SECURITY_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean) is
  'Atomically creates one text Root; idempotency hashing explicitly resolves the trusted pgcrypto digest from the extensions schema.';
comment on function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean) is
  'Atomically creates one Reply; idempotency hashing explicitly resolves the trusted pgcrypto digest from the extensions schema.';
comment on function public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean) is
  'Atomically edits one author-owned Comment within fifteen minutes; idempotency hashing explicitly resolves extensions.digest.';
comment on function public.delete_community_comment(uuid,uuid,bigint,uuid,boolean) is
  'Atomically creates an irreversible author tombstone; idempotency hashing explicitly resolves extensions.digest.';

commit;
