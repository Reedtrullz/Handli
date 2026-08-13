-- Expand the supported grocery chain set to match the chains the live
-- Kassalapp source actually serves.
--
-- The launch catalog was scoped to bunnpris/rema-1000/extra, but live price
-- and product data is dominated by other chains (FUDI, MENY, JOKER, SPAR,
-- EUROPRIS, HAVARISTEN, HOLDBART, FASTCANDY, ENGROSSNETT, ODA). Every price
-- outside the three-chain set was quarantined as UNKNOWN_CHAIN, so products
-- showed no prices at all. The canonical chain identifiers below are stable
-- and match CHAIN_BY_CODE in the kassalapp adapter and SupportedChain in the
-- ingestion contract.

lock table public.price_cache in access exclusive mode;
lock table public.price_observations in access exclusive mode;
lock table public.price_coverage_checks in access exclusive mode;
lock table public.physical_stores in access exclusive mode;
lock table public.publications in access exclusive mode;
lock table public.approved_offers in access exclusive mode;
lock table public.historical_price_statistics in access exclusive mode;
lock table public.source_record_outcomes in access exclusive mode;
lock table public.physical_store_observations in access exclusive mode;
lock table public.physical_store_coverage_checks in access exclusive mode;

alter table public.price_cache
  drop constraint price_cache_chain_supported;

alter table public.price_observations
  drop constraint price_observations_chain_supported;

alter table public.price_coverage_checks
  drop constraint price_coverage_checks_chain_supported;

alter table public.physical_stores
  drop constraint physical_stores_chain_supported;

alter table public.publications
  drop constraint publications_chain_supported;

alter table public.approved_offers
  drop constraint approved_offers_chain_supported;

alter table public.historical_price_statistics
  drop constraint historical_price_statistics_chain_supported;

alter table public.source_record_outcomes
  drop constraint source_record_outcomes_chain_supported;

alter table public.physical_store_observations
  drop constraint physical_store_observations_chain_supported;

alter table public.physical_store_coverage_checks
  drop constraint physical_store_coverage_checks_chain_supported;

alter table public.price_cache
  add constraint price_cache_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.price_observations
  add constraint price_observations_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.price_coverage_checks
  add constraint price_coverage_checks_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.physical_stores
  add constraint physical_stores_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.publications
  add constraint publications_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.approved_offers
  add constraint approved_offers_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.historical_price_statistics
  add constraint historical_price_statistics_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.source_record_outcomes
  add constraint source_record_outcomes_chain_supported check (
    subject_chain is null
    or subject_chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.physical_store_observations
  add constraint physical_store_observations_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );

alter table public.physical_store_coverage_checks
  add constraint physical_store_coverage_checks_chain_supported check (
    chain in (
      'bunnpris', 'extra', 'rema-1000', 'fudi', 'holdbart', 'meny',
      'havaristen', 'joker', 'spar', 'fastcandy', 'europris',
      'engrossnett', 'oda'
    )
  );
