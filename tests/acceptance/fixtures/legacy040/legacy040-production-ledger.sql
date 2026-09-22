--
-- PostgreSQL database dump
--

\restrict 8BuPbTE3n99aydaVZhTz1j7cSRABGRUcrA5uIojI3kICTWR1iVdhZclIGfPa2rg

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: handleplan_schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('001_price_cache.sql', 'c1803a5179f3379a19fd3384561ee25ba8fc46dfa70779d63bd06f034ea20d9a', '2026-08-11 13:02:40.141215+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('002_sources_catalog.sql', 'c5c5e7f7864cb1701835a7b93761545a4627a2e1b6f983ea53e64a13a61d3a05', '2026-08-11 13:02:40.296228+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('003_price_evidence_coverage.sql', '5e9ac6e2c21b2290d0160f45aa4c76c3b47a36ecbd3f738774faa80ab93f0f06', '2026-08-11 13:02:40.578298+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('004_geography_publications.sql', 'f49d9d2ab8cd3f4e47f2453bd6d2b2d8313e94d8bda0ff1e53996b351ffe5943', '2026-08-11 13:02:40.708593+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('005_offers_reviews.sql', 'e60b9d73561fc5c0e72ac5f5d0495b7c34dc8134ceba57f3e96871fa0b6b73bd', '2026-08-11 13:02:40.978224+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('006_source_health.sql', '490910604aa75a68910b22e5f4af1638890b2baf13b887a5233c7de1b14719dc', '2026-08-11 13:02:41.455402+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('007_append_only_guards.sql', '9c6ac9301b3a11dbbd800c6da87e57e811c2a9e37b4365ccbbfbcb95f977cb87', '2026-08-11 13:02:41.617189+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('008_provider_request_budget.sql', '4c51a2d5443b01323a36104eaff1d1c9fdc0f637fc2ef98c9a705621315d37ec', '2026-08-11 13:02:41.638768+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('009_ingestion_outcomes.sql', 'b35d2c465283c7fd514f41566a0e514b896e31a5831cf0c9fef77e3b012dc469', '2026-08-11 13:02:41.655872+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('010_worker_job_results.sql', '8c99f7a11d8c33825c8e90d12f77ffb58a42d6b23d622447720c846cb586d6b4', '2026-08-11 13:02:41.688897+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('011_catalog_observations.sql', '0c5a8b06b9b71859990366864351705d772e6d47bbd2047fa839fef318d38dec', '2026-08-11 13:02:41.729291+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('012_reviewed_family_taxonomy.sql', '70101ad7f170617de7d26614661c69e208293601388f6259c6441a40c941fda3', '2026-08-11 13:02:41.811248+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('013_physical_store_directory.sql', '5a223d407b24d9848f35336ede86c8ab2be456273ac44e17b69860cf7d1a9088', '2026-08-11 13:02:42.156612+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('014_ingestion_completion_clock.sql', '52808f3e778e129a84928994f1d47acde58e134438aa390458506b2ee23b4a7a', '2026-08-11 13:02:42.353386+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('015_catalog_category_path.sql', '4a94b671f6a45cc04a0563a45952468a123a372381cbbccd33a0222cffbb79d6', '2026-08-11 13:02:42.369329+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('016_worker_source_health.sql', 'bc84b6b41db1ea5ef01e3c60eb84b9be3027d728f9989362548bc199cd055d1a', '2026-08-11 13:02:42.400825+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('017_geographic_directory_region_proof.sql', '4fe8c7ce3aefb46d2af7f335f30b789d9a25bd662884713619247fdb448368c8', '2026-08-11 13:02:42.437857+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('018_review_candidate_immutability.sql', '67ebf517236564b41d825da519d9d10b524f6c34119288f02bbca2711a10c307', '2026-08-11 13:02:42.533639+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('019_public_api_request_budget.sql', '7ffc33c1e129134570437bbe6b2f185b4130734f1a55a7184e33edb1aed70f05', '2026-08-11 13:02:42.568471+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('020_official_offer_trust_fences.sql', '203a5c5b66b2ebdd50f9e2a94f7477d2b0b9c3c253f893744fa5d7d90ee2c931', '2026-08-11 13:02:42.585602+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('021_private_review_decision_boundary.sql', '6f34f5e4b211378942d4dabc9b95bbb0bbe66968b8fc8c3f2ff7138244443f3b', '2026-08-11 13:02:42.67747+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('022_public_official_offer_projection.sql', '4fb9f560ff89f062bf0a025118d582f7c3b3b60f63ce5b5917a91f63c6427249', '2026-08-11 13:02:42.701533+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('023_official_offer_worker_jobs.sql', '2eaf73fcc4298a308ba7e8074cb6a2a44ad11b9a23a18b940083d4bd35f5f15a', '2026-08-11 13:02:42.726527+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('024_operations_runtime_boundary.sql', '15df6f98c99fc81bb4750169613f288d9cb4b640d5f020bbdf648ad189b34336', '2026-08-11 13:02:42.740692+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('025_private_review_evidence_renderer.sql', '3d4da7bd3c35cce0393b0a98e52dea02f2b3a3c15425a623330ff443871e6417', '2026-08-11 13:02:42.807336+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('026_official_offer_publication_runtime.sql', 'fd9b961e452e5ad2d42bca44a2d619321be78c7f93e9f97732e7f443a7c119de', '2026-08-11 13:02:42.917105+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('027_official_offer_publication_health.sql', '11a5cba1f7abd6e55f9899ca50c18684742012858423ee1a3060a1c5b1af15ea', '2026-08-11 13:02:43.016185+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('028_private_review_image_evidence_only.sql', '6654c9070920607e91e9ff70069fd3c3ca49a7109d80cf59ec5f9c04cc3fe4b7', '2026-08-11 13:02:43.096512+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('029_kassalapp_source_approval.sql', '49bc92e50fe08bdfd592e1ea386c791fb77c2a4ae2723fa25b7909f705e062bc', '2026-08-11 13:50:18.012686+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('030_catalog_measure_optional.sql', '5581093485475c44122652135b53e2aaca14eb68a1662fbe3cf2c1bc5802005c', '2026-08-13 10:24:59.722672+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('031_supported_chain_expansion.sql', '88b1edf5c1090f8a213546bead97d3413292d31c90e67ceb5a3dbd16004c36eb', '2026-08-13 15:14:12.527953+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('032_seed_national_scope.sql', '7e85910142e61a2e26bb07357debcb3883c28fa277bedd72e1c4cde2877a18b5', '2026-08-13 23:00:55.002569+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('033_open_prices_source.sql', '5b6d865c2dc3d3692e85e17371baa023926200ac5c6ef3b2d8c1c3bf5fdc7376', '2026-08-20 12:54:16.122111+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('035_tjek_source.sql', 'c3735f73530c85a6962e948f02c1da62ea4793a387822380c1baadcb24e70b94', '2026-08-21 05:05:11.777762+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('034_open_prices_job_kind.sql', '3f5276c5a394f6863282cfc801923936a0aff59497f68736512bb86fb25cb4d6', '2026-08-20 18:52:00.01033+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('036_tjek_official_offer_permission.sql', 'cf0752c0839335e5b64eaa3c231470816a97210d563743dbe9a14284cca873e8', '2026-08-21 10:39:46.904637+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('037_worker_official_offer_grants.sql', '7ed7dfe8939482b72a6eccf1958ce70c18af5f2643e600932f10b6bb29d7758c', '2026-08-21 11:33:05.843529+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('038_tjek_function_grants.sql', '58c688d05af7c18384d4aeb0bc037b023fb066bb4b719078c21fc38c2ac8e49c', '2026-08-21 12:48:39.359294+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('039_tjek_null_comparison_fix.sql', 'b92edd7f8c6e23bcea67a28b40c8150c168999ac70b03dce2bb4334bce4002a8', '2026-08-21 17:12:19.735012+00');
INSERT INTO public.handleplan_schema_migrations (id, checksum, applied_at) VALUES ('040_offer_backed_discovery.sql', 'acc7a16e1e4ab4c0eed51df5724cd9cb92d08c8fd467d4d74f6f18f7bded809f', '2026-08-22 07:45:55.07735+00');


--
-- PostgreSQL database dump complete
--

\unrestrict 8BuPbTE3n99aydaVZhTz1j7cSRABGRUcrA5uIojI3kICTWR1iVdhZclIGfPa2rg

