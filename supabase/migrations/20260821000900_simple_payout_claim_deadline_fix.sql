do $repair$
declare
  v_signature regprocedure := 'public.get_simple_team_payouts(text,boolean)'::regprocedure;
  v_definition text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('claim.deadline_at' in v_definition) = 0 then
    raise exception using message = 'SIMPLE_PAYOUT_CLAIM_DEADLINE_BASELINE_MISSING';
  end if;
  v_definition := replace(
    v_definition,
    'claim.deadline_at',
    'claim.claim_deadline_at'
  );
  execute v_definition;
end;
$repair$;

comment on function public.get_simple_team_payouts(text,boolean) is
  'Capability-protected Cycle-grouped payout projection using the canonical Winner Claim deadline.';
