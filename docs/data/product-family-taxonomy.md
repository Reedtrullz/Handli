# Reviewed product-family taxonomy

`product-family-taxonomy.v1.json` is the source-controlled seed for reviewed
Norwegian grocery-family definitions. Its identifiers are stable ASCII keys;
Norwegian display text and search aliases remain separate. A retired family
keeps its identity and history but is not eligible for new membership use.

## Version and checksum

`versionId` is exactly `taxonomyId@taxonomyVersion`. A published version is
immutable: changing any family descriptor requires a new taxonomy version and
version ID. `contentSha256` is SHA-256 over the UTF-8 bytes of the canonical
JSON representation of `families`. Canonical JSON recursively sorts object
keys, preserves array order and Unicode code points, and has no insignificant
whitespace.

Families and aliases are ordered in the checked-in artifact so that independent
seed and validation tools produce the same bytes. Family IDs, slugs, and lookup
aliases are unique within a version. Parent IDs refer to a family in the same
version and the parent graph must be acyclic.

## Deliberate boundary

This artifact defines vocabulary only. It does not contain product memberships,
does not approve any source product, and does not enable flexible matching in
the planner or user interface. Membership decisions require separate immutable
review provenance before a product can resolve to one of these families.
