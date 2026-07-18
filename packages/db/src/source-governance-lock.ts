/**
 * Shared PostgreSQL advisory-lock namespace for source governance changes.
 *
 * Every source-permission append and runtime source-state change takes this
 * transaction-scoped lock for its source ID. Rights-sensitive transactions
 * must take the same lock before their final current-rights check and retain it
 * until commit.
 */
export const SOURCE_GOVERNANCE_ADVISORY_LOCK_SEED = 7_229_164_304;
