create table if not exists approved_offers (
  id bigserial primary key,
  offer_key varchar(255) not null unique,
  candidate_id bigint references extracted_offer_candidates(id),
  source_id varchar(64) not null references data_sources(id),
  source_reference text not null,
  chain varchar(32) not null,
  geographic_scope_id bigint not null references geographic_scopes(id),
  amount_ore integer not null,
  before_amount_ore integer,
  multibuy_quantity integer,
  multibuy_group_amount_ore integer,
  membership_requirement varchar(24) not null default 'public',
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  status varchar(16) not null default 'approved',
  version integer not null default 1,
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approved_offers_chain_supported check (
    chain in ('bunnpris', 'rema-1000', 'extra')
  ),
  constraint approved_offers_amount_ore_nonnegative check (amount_ore >= 0),
  constraint approved_offers_before_amount_ore_nonnegative check (
    before_amount_ore is null or before_amount_ore >= 0
  ),
  constraint approved_offers_before_not_lower check (
    before_amount_ore is null or before_amount_ore >= amount_ore
  ),
  constraint approved_offers_multibuy_pair check (
    (multibuy_quantity is null and multibuy_group_amount_ore is null)
    or (
      multibuy_quantity is not null
      and multibuy_quantity > 1
      and multibuy_group_amount_ore is not null
      and multibuy_group_amount_ore >= 0
    )
  ),
  constraint approved_offers_membership_requirement check (
    membership_requirement in ('public', 'member')
  ),
  constraint approved_offers_valid_range check (valid_until > valid_from),
  constraint approved_offers_status check (
    status in ('approved', 'published', 'expired', 'revoked')
  ),
  constraint approved_offers_version_positive check (version > 0)
);

create unique index if not exists approved_offers_candidate_unique
  on approved_offers (candidate_id)
  where candidate_id is not null;

create table if not exists offer_targets (
  offer_id bigint not null references approved_offers(id),
  product_id bigint references canonical_products(id),
  family_slug varchar(80) references product_families(slug),
  match_method varchar(24) not null,
  match_confidence smallint not null,
  primary key (offer_id),
  constraint offer_targets_exactly_one_target check (
    (product_id is not null and family_slug is null)
    or (product_id is null and family_slug is not null)
  ),
  constraint offer_targets_match_method check (
    match_method in ('exact_identifier', 'deterministic_rule', 'human_review')
  ),
  constraint offer_targets_confidence_range check (
    match_confidence between 0 and 100
  )
);

create table if not exists offer_conditions (
  id bigserial primary key,
  offer_id bigint not null references approved_offers(id),
  condition_type varchar(32) not null,
  condition_value jsonb not null,
  constraint offer_conditions_type check (
    condition_type in ('membership', 'quantity', 'channel', 'payment', 'other')
  )
);

create table if not exists review_actions (
  id bigserial primary key,
  candidate_id bigint not null references extracted_offer_candidates(id),
  offer_id bigint references approved_offers(id),
  actor_id varchar(160) not null,
  action varchar(24) not null,
  expected_version integer not null,
  previous_values jsonb,
  new_values jsonb,
  reason text not null,
  acted_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint review_actions_action check (
    action in ('approve', 'correct_and_approve', 'reject', 'revoke')
  ),
  constraint review_actions_candidate_version_unique unique (
    candidate_id,
    expected_version
  ),
  constraint review_actions_expected_version_nonnegative check (expected_version >= 0)
);

create index if not exists review_actions_candidate_time_idx
  on review_actions (candidate_id, acted_at, id);
