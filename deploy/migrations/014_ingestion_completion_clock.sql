-- Completion is supplied by the worker, while terminalized_at is stamped by
-- PostgreSQL. Reject a caller-controlled future completion before it can make
-- evidence appear complete at an as-of boundary that has not happened yet.
lock table ingestion_runs in share row exclusive mode;

do $validate_existing_ingestion_completion_clocks$
begin
  if exists (
    select 1
    from ingestion_runs
    where status <> 'running'
      and (
        completed_at > statement_timestamp()
        or terminalized_at < completed_at
      )
  ) then
    raise exception 'existing ingestion run completion clock is inconsistent'
      using errcode = '23514';
  end if;
end;
$validate_existing_ingestion_completion_clocks$;

create or replace function enforce_ingestion_run_lifecycle()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  terminal_time timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'ingestion_runs lifecycle forbids deletion'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'running'
       or new.completed_at is not null
       or new.terminalized_at is not null then
      raise exception 'ingestion_runs lifecycle requires a running insert'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.job_id is distinct from old.job_id
     or new.source_id is distinct from old.source_id
     or new.run_type is distinct from old.run_type
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'ingestion_runs lifecycle identity is immutable'
      using errcode = '55000';
  end if;

  if old.status <> 'running' then
    raise exception 'ingestion_runs lifecycle terminal row is immutable'
      using errcode = '55000';
  end if;

  if new.status not in ('completed', 'degraded', 'failed', 'cancelled')
     or new.completed_at is null
     or new.terminalized_at is not null then
    raise exception 'ingestion_runs lifecycle allows only one running-to-terminal transition'
      using errcode = '55000';
  end if;

  terminal_time := statement_timestamp();
  if new.completed_at > terminal_time then
    raise exception 'ingestion_runs completion cannot be in the future'
      using errcode = '23514';
  end if;

  new.terminalized_at := terminal_time;
  return new;
end;
$$;

alter table ingestion_runs
  add constraint ingestion_runs_completion_not_after_terminalization check (
    status = 'running'
    or completed_at <= terminalized_at
  );
