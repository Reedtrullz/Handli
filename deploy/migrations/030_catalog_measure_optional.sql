-- Make the package measure optional for catalog products.
--
-- The live Kassalapp listing does not provide weight/unit data for the vast
-- majority of products (96%+ on sampled pages, and the by-EAN endpoint does
-- not reliably rescue it). Requiring a measure meant almost every real
-- product was downgraded to an audited unknown and never appeared in the
-- catalog. A catalog product now needs a display name and a valid GTIN;
-- the package measure is present only when the source provided it.
--
-- Both tables keep their positive/unit checks; they simply allow NULL, which
-- is the explicit "measure unknown" state. Consumers that need a measure
-- (planning quantity math) treat NULL as "cannot plan" rather than crash.

lock table public.canonical_products in access exclusive mode;
lock table public.catalog_observations in access exclusive mode;

alter table public.canonical_products
  alter column package_amount drop not null,
  alter column package_unit drop not null;

alter table public.catalog_observations
  alter column package_amount drop not null,
  alter column package_unit drop not null;

alter table public.canonical_products
  drop constraint canonical_products_package_amount_positive,
  drop constraint canonical_products_package_unit;

alter table public.canonical_products
  add constraint canonical_products_package_amount_positive check (
    package_amount is null or package_amount > 0
  ),
  add constraint canonical_products_package_unit check (
    package_unit is null or package_unit in ('g', 'ml', 'piece', 'package')
  );

alter table public.catalog_observations
  drop constraint catalog_observations_package_amount_positive,
  drop constraint catalog_observations_package_unit;

alter table public.catalog_observations
  add constraint catalog_observations_package_amount_positive check (
    package_amount is null or package_amount > 0
  ),
  add constraint catalog_observations_package_unit check (
    package_unit is null or package_unit in ('g', 'ml', 'piece', 'package')
  );
