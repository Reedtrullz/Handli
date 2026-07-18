# Security policy

## Supported state

Handleplan is a protected alpha behind Cloudflare Access. No release is claimed
to be suitable for unrestricted public operation. Security, privacy, abuse,
backup, monitoring, dependency, and recovery gates remain open.

## Reporting a vulnerability

Do **not** disclose exploit details, credentials, personal data, baskets,
addresses, coordinates, Access identities, private captures, or production
configuration in a public GitHub issue.

A confidential vulnerability-reporting channel, named security owner, service
level, and backup contact have not yet been published. That is an explicit
blocker: public access must not be opened until a tested private channel exists
and this section contains its real address or URL. A maintainer should not
invent an email or imply that an unverified GitHub feature is enabled.

Until that channel exists:

- use public issues only for non-sensitive hardening suggestions that do not
  reveal an exploitable weakness;
- do not probe the VPS, Cloudflare configuration, providers, or user data
  without explicit written authorization; and
- if a report cannot be made safely, retain it privately rather than posting
  sensitive content publicly.

Once a confidential report is received, the required process is to acknowledge
it privately, preserve minimal evidence, assess affected revisions/data,
contain the issue, add a regression test where safe, rotate or revoke exposed
capabilities, communicate impact without leaking reporter or exploit details,
and publish a remediation record. Exact response targets and disclosure timing
must be adopted with the real reporting channel.

The current architecture and open risks are documented in
[`docs/security/data-flow-threat-model.md`](docs/security/data-flow-threat-model.md).
Repository checks now reject known high/critical dependency advisories, unknown
dependency license expressions, and several high-confidence committed-secret
formats, but that does not prove Git history, container layers, the VPS,
Cloudflare, provider dashboards, or a release candidate are clean. Publishing
this policy still does not mean a penetration test or legal/security review has
passed.
