-- Extracted candidates are source evidence. Review decisions are separate,
-- append-only review_actions; approval must never rewrite the extraction.
create trigger extracted_offer_candidates_append_only
before update or delete on extracted_offer_candidates
for each row execute function reject_append_only_mutation();

-- The private review queue pages by database-owned creation time and id.
-- Keep these partial so rejected extraction output does not bloat the queue path.
create index extracted_offer_candidates_pending_queue_idx
  on extracted_offer_candidates (created_at, id)
  include (extraction_run_id, confidence)
  where status = 'pending';

create index extracted_offer_candidates_pending_confidence_idx
  on extracted_offer_candidates (confidence, created_at, id)
  where status = 'pending';

create index extracted_offer_candidates_pending_anomalies_idx
  on extracted_offer_candidates using gin (anomaly_codes jsonb_path_ops)
  where status = 'pending';

create index publications_review_scope_idx
  on publications (chain, geographic_scope_id, id);

-- A public offer can only be reached through the separately guarded UPDATE
-- publisher. No caller may INSERT a row directly into a public state, and a
-- published row must retain its immutable extraction candidate binding.
alter table approved_offers
  add constraint approved_offers_published_candidate_binding check (
    status <> 'published' or candidate_id is not null
  );

create function enforce_approved_offer_insert_boundary()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.status is distinct from 'approved' then
    raise exception 'approved_offers must begin approved; publication requires the guarded update path'
      using errcode = '23514';
  end if;

  if (session_user = 'handleplan_review' or current_user = 'handleplan_review')
     and new.candidate_id is null then
    raise exception 'handleplan_review offers require an extracted candidate'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger approved_offers_insert_boundary
before insert on approved_offers
for each row execute function enforce_approved_offer_insert_boundary();
