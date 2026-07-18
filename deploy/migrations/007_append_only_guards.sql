create or replace function reject_append_only_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

create trigger source_permissions_append_only
before update or delete on source_permissions
for each row execute function reject_append_only_mutation();

create trigger price_observations_append_only
before update or delete on price_observations
for each row execute function reject_append_only_mutation();

create trigger price_coverage_checks_append_only
before update or delete on price_coverage_checks
for each row execute function reject_append_only_mutation();

create trigger publication_captures_append_only
before update or delete on publication_captures
for each row execute function reject_append_only_mutation();

create trigger review_actions_append_only
before update or delete on review_actions
for each row execute function reject_append_only_mutation();
