begin;

do $migration$
declare
  v_signature regprocedure :=
    'public.get_simple_team_payouts_v2(text,boolean)'::regprocedure;
  v_definition text;
begin
  select pg_get_functiondef(v_signature) into v_definition;

  if v_definition is null
    or (length(v_definition) - length(replace(v_definition, 'claim.deadline_at', ''))) / length('claim.deadline_at') <> 1
    or position('claim.claim_deadline_at' in v_definition) <> 0
  then
    raise exception using message = 'PAYOUT_V2_CLAIM_DEADLINE_BASELINE_MISMATCH';
  end if;

  execute replace(
    v_definition,
    'claim.deadline_at',
    'claim.claim_deadline_at'
  );
end;
$migration$;

comment on function public.get_simple_team_payouts_v2(text,boolean) is
  'Returns Cycle-grouped Team payout data with all verified transfer parts, the canonical Winner Claim deadline, and receipt evidence ordered by its canonical upload timestamp.';

commit;
