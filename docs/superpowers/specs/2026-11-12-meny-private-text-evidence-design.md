# MENY private text evidence

The owner selected implementation of safe text-evidence review on 2026-11-12, keeping production review access and actual offer approval separate. Current MENY captures are HTML, source permission does not grant privateReview, and the renderer/receipt boundary accepts images only.

Use the original checksum-verified HTML bytes, served as UTF-8 text/plain and rendered as escaped React text in the protected review workspace. The complete raw bytes remain the browser SHA-256 input. A reviewer explicitly acknowledges the displayed text before the existing candidate/version/session-bound challenge becomes a short-lived, one-use receipt. No HTML execution, iframe, retailer navigation, derived-data digest substitution, product inference, or automatic approval.

The existing full-capture proof is preferable to extracting and hashing a different text document, which would need a second transform/digest contract. Executing the original HTML is unsafe and unnecessary. This implementation choice belongs to the agent; the owner authorized the text-review outcome and retained operational gates.

Allow text/html captures only for MENY's content-addressed source namespace, valid UTF-8, and at most 1 MiB. The server returns text/plain;charset=utf-8 with no-store, nosniff and sandbox headers. Image behavior and image decode acknowledgements remain unchanged; PDF and other-source HTML remain unsupported. SQL independently binds text receipts to the original MENY capture, checksum and byte length. Keep all current rights, permission, version, actor/session, expiry and consumption checks. Historical migrations/receipts remain immutable.

No source permission, live database, ingestion, deployment, or existing candidate decision changes. A future operational activation and human offer review remain necessary. Synthetic fixtures only; no production source bytes or signed provider URLs enter commits.
