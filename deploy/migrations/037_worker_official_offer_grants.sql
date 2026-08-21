-- Grant the worker role access to official-offer pipeline tables.
-- The Tjek handler inserts into publications, publication_captures,
-- extraction_runs, extracted_offer_candidates, approved_offers,
-- review_actions, and offer_targets during automated catalog processing.

-- Publications and captures are append-only from the worker's perspective
grant select, insert on table publications to handleplan_app;
grant select, insert on table publication_captures to handleplan_app;
grant select, insert on table extraction_runs to handleplan_app;
grant select, insert on table extracted_offer_candidates to handleplan_app;
grant select, insert on table approved_offers to handleplan_app;
grant select, insert on table review_actions to handleplan_app;
grant select, insert on table offer_targets to handleplan_app;
grant select, insert on table offer_conditions to handleplan_app;

-- Sequences for the tables
grant usage on sequence publications_id_seq to handleplan_app;
grant usage on sequence publication_captures_id_seq to handleplan_app;
grant usage on sequence extraction_runs_id_seq to handleplan_app;
grant usage on sequence extracted_offer_candidates_id_seq to handleplan_app;
grant usage on sequence approved_offers_id_seq to handleplan_app;
grant usage on sequence review_actions_id_seq to handleplan_app;
grant usage on sequence offer_targets_id_seq to handleplan_app;
grant usage on sequence offer_conditions_id_seq to handleplan_app;
