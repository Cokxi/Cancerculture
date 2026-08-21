do $repair$
declare
  v_signature regprocedure;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.get_simple_team_payouts(text,boolean)'::regprocedure,
    'public.get_public_submission_payout(bigint)'::regprocedure
  ]
  loop
    select pg_get_functiondef(v_signature) into v_definition;
    if position('order by candidate.created_at desc, candidate.id desc' in v_definition) = 0 then
      raise exception using message = 'PAYOUT_EVIDENCE_TIMESTAMP_BASELINE_MISSING';
    end if;
    v_definition := replace(
      v_definition,
      'order by candidate.created_at desc, candidate.id desc',
      'order by candidate.uploaded_at desc, candidate.id desc'
    );
    execute v_definition;
  end loop;
end;
$repair$;

comment on function public.get_simple_team_payouts(text,boolean) is
  'Capability-protected Cycle-grouped payout projection with deterministic evidence ordering by uploaded_at.';
comment on function public.get_public_submission_payout(bigint) is
  'Public allowlisted payout result projection with deterministic public receipt ordering by uploaded_at.';
