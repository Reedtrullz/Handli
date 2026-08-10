-- Category evidence belongs to the immutable catalog observation that carried
-- it. NULL means the source category state was not captured; [] means the
-- source explicitly returned an empty category path.
alter table catalog_observations
  add column category_path jsonb,
  add constraint catalog_observations_category_path_shape check (
    category_path is null
    or case
      when jsonb_typeof(category_path) = 'array'
        then jsonb_array_length(category_path) <= 100
      else false
    end
  );

comment on column catalog_observations.category_path is
  'Nullable source category evidence: NULL is unknown/not captured; [] is explicitly observed empty.';

create function enforce_catalog_observation_category_path()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  category_entry jsonb;
  source_category_id text;
  source_category_numeric bigint;
  category_depth_text text;
  category_depth integer;
  category_name text;
  seen_source_category_ids text[] := array[]::text[];
  previous_category_depth integer;
  previous_source_category_numeric bigint;
  has_previous_category boolean := false;
begin
  if new.category_path is null then
    return new;
  end if;

  if jsonb_typeof(new.category_path) is distinct from 'array' then
    raise exception 'catalog observation category path has an invalid container'
      using
        errcode = '23514',
        constraint = 'catalog_observations_category_path_shape';
  end if;
  if jsonb_array_length(new.category_path) > 100 then
    raise exception 'catalog observation category path has an invalid container'
      using
        errcode = '23514',
        constraint = 'catalog_observations_category_path_shape';
  end if;

  for category_entry in
    select value
    from jsonb_array_elements(new.category_path)
  loop
    if jsonb_typeof(category_entry) is distinct from 'object' then
      raise exception 'catalog observation category path entry has an invalid shape'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    if not (category_entry ?& array['sourceCategoryId', 'depth', 'name'])
       or (
         select count(*)
         from jsonb_object_keys(category_entry)
       ) <> 3 then
      raise exception 'catalog observation category path entry has an invalid shape'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    if jsonb_typeof(category_entry -> 'sourceCategoryId') is distinct from 'string' then
      raise exception 'catalog observation category path source id is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    source_category_id := category_entry ->> 'sourceCategoryId';
    if source_category_id is distinct from btrim(source_category_id)
       or source_category_id !~ '^(0|[1-9][0-9]{0,15})$' then
      raise exception 'catalog observation category path source id is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    source_category_numeric := source_category_id::bigint;
    if source_category_numeric > 9007199254740991 then
      raise exception 'catalog observation category path source id is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    if source_category_id = any(seen_source_category_ids) then
      raise exception 'catalog observation category path source ids must be unique'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    seen_source_category_ids := array_append(
      seen_source_category_ids,
      source_category_id
    );

    if jsonb_typeof(category_entry -> 'depth') is distinct from 'number' then
      raise exception 'catalog observation category path depth is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    category_depth_text := category_entry ->> 'depth';
    if category_depth_text !~ '^(0|[1-9][0-9]{0,2})$' then
      raise exception 'catalog observation category path depth is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    category_depth := category_depth_text::integer;
    if category_depth not between 0 and 100 then
      raise exception 'catalog observation category path depth is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    if has_previous_category
       and (
         category_depth < previous_category_depth
         or (
           category_depth = previous_category_depth
           and source_category_numeric <= previous_source_category_numeric
         )
       ) then
      raise exception 'catalog observation category path order is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
    previous_category_depth := category_depth;
    previous_source_category_numeric := source_category_numeric;
    has_previous_category := true;

    if jsonb_typeof(category_entry -> 'name') is distinct from 'string' then
      raise exception 'catalog observation category path name is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;

    category_name := category_entry ->> 'name';
    if category_name is distinct from btrim(category_name)
       or char_length(category_name) not between 1 and 500 then
      raise exception 'catalog observation category path name is invalid'
        using
          errcode = '23514',
          constraint = 'catalog_observations_category_path_entries';
    end if;
  end loop;

  return new;
end;
$$;

create trigger catalog_observations_category_path_guard
before insert or update of category_path on catalog_observations
for each row execute function enforce_catalog_observation_category_path();

create index catalog_observations_category_path_gin_idx
  on catalog_observations using gin (category_path jsonb_path_ops)
  where category_path is not null;
