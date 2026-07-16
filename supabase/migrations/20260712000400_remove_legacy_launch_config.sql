delete from public.app_config
where key in (
  'contract_address',
  'pumpfun_url',
  'pumpfun_launch_url',
  'launch_url',
  'coin_launch_url',
  'reward_wallet',
  'reward_wallet_address',
  'marketing_wallet',
  'marketing_wallet_address'
);
