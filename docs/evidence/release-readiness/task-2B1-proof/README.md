# Task 2B1 canonical generation proof

This bundle is the retained output of
`scripts/release/prove-040-bootstrap.mjs`. It is rerunnable only against a
disposable PostgreSQL container named by `TASK2B1_CONTAINER`; the harness drops
and recreates four named databases and never targets production.

The harness creates two independent canonical-history databases by applying
001–034 in one transaction, 035 separately, 036–038 in one transaction, then
explicit 041 and immutable 040. It creates two independent artifact databases
from `deploy/bootstrap/040_schema.sql`. It emits exact query readbacks in
`readback.json`, raw schema-only dumps, normalized generated schema outputs,
and both diffs.

The proof normalizes only the enumerated historical clock columns in the
eight non-empty seed tables to `__installer_transaction_timestamp__`. It does
not normalize fixed semantic dates such as taxonomy `published_at`, and it
does not normalize schema text. The generated schema output removes only
PostgreSQL's random `\\restrict` and `\\unrestrict` session guards. The raw
diff retains those guards and is therefore reviewable.

The exact readback queries are embedded in the harness. They cover:

- public relation/column/constraint/index/trigger/function/sequence counts;
- both corrected function definition hashes from `pg_get_functiondef`;
- ordered rows from all eight non-empty reference tables;
- ordered `pg_sequences` state;
- PUBLIC ACLs and function security/parallel flags from `aclexplode` and
  `pg_proc`;
- installer owner shape and runtime-role denial counts.

Recorded output:

```text
canonical-1.sql / canonical-2.sql: a481183f674e97e0b00a114be1b0e1261b602422edc0d313a6e6e6ee1c46e598
artifact.sql / artifact-2.sql:       b097f01ca5b22001f797056ea395a0039789fb89ae5970c675d5b25956b152a9
canonical-generated.diff:           empty
artifact-generated.diff:            empty
canonical-raw.diff:                 only the two random pg_dump guard lines
canonical-artifact.raw.diff:        retained raw canonical/artifact dump diff
canonical-artifact.diff:            132 changed definition lines; exact diff retained
canonical-artifact.diff.check.json: every changed line is a constraint/index deparser line
canonical-raw.diff sha256:          f3e5b1bdbea0490d5d6548f58fa60c5e534848978e62d676ff43064c2b51e71f
readback sha256:                    5d545f4051eaa6c6ece96ef004accf75db4d40b6b8637908e61c590c5a14984f
```

Both canonical databases and both artifact databases produced 52 relations,
499 columns, 339 constraints, 105 indexes, 87 triggers, 47 public functions,
and 26 sequences. Canonical and artifact readbacks matched on the normalized
seed, sequence, PUBLIC/security ACL, owner, and function contracts. Canonical
history retained 26 runtime ACL rows; both artifact databases retained zero.
The Tjek pointer remained behind the latest permission row in all four
databases, so the current-rights fence stayed fail-closed.

The canonical/artifact raw dump differences are PostgreSQL 16.10 deparser
round-trip forms: redundant boolean parentheses and varchar-array cast
parenthesization, plus one index predicate in the same form. The retained
`canonical-artifact.diff.check.json` checks every changed line is a constraint
or index definition; no table, column, function, trigger, or ownership line
changed. Independent platform round-trips are byte-identical for both the
canonical and artifact installs, providing the deterministic comparison
boundary without treating textual deparser spelling as schema semantics.
