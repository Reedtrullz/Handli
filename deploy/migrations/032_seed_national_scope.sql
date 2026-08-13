-- Seed the canonical national Norway geographic scope.
--
-- The price read model inner-joins price_observations to geographic_scopes
-- and requires an active national NO scope. No migration ever seeded one, so
-- the table stayed empty and no price observation could ever surface, even
-- after the worker began persisting them. This forward-only seed creates the
-- single canonical scope the reader already filters for.

lock table public.geographic_scopes in access exclusive mode;

insert into public.geographic_scopes (
  scope_key, scope_kind, label, country_code, status
) values (
  'no-national', 'national', 'Norge (nasjonalt)', 'NO', 'active'
)
on conflict (scope_key) do nothing;
