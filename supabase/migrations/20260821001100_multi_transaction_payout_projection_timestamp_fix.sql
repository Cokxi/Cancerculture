begin;

do $migration$
declare
  v_team_definition text;
  v_public_definition text;
begin
  select pg_get_functiondef(
    'public.get_simple_team_payouts_v2(text,boolean)'::regprocedure
  ) into v_team_definition;
  select pg_get_functiondef(
    'public.get_public_submission_payout_v2(bigint)'::regprocedure
  ) into v_public_definition;

  if v_team_definition is null
    or v_public_definition is null
    or (length(v_team_definition) - length(replace(v_team_definition, 'candidate.created_at', ''))) / length('candidate.created_at') <> 1
    or (length(v_public_definition) - length(replace(v_public_definition, 'candidate.created_at', ''))) / length('candidate.created_at') <> 1
  then
    raise exception using message = 'PAYOUT_V2_PROJECTION_BASELINE_MISMATCH';
  end if;

  execute replace(
    v_team_definition,
    'candidate.created_at',
    'candidate.uploaded_at'
  );
  execute replace(
    v_public_definition,
    'candidate.created_at',
    'candidate.uploaded_at'
  );
end;
$migration$;

comment on function public.get_simple_team_payouts_v2(text,boolean) is
  'Returns Cycle-grouped Team payout data with all verified transfer parts and receipt evidence ordered by its canonical upload timestamp.';
comment on function public.get_public_submission_payout_v2(bigint) is
  'Returns allowlisted public payout details with all verified transfer parts and receipt evidence ordered by its canonical upload timestamp.';

commit;
