# Handleplan Superdesign Workspace

**Status:** Public flow generated and awaiting visual approval
**Project:** https://superdesign.dev/teams/b37fb15f-e8c8-4c88-b4f5-1ba0798edc4c/projects/9e007215-3c47-4ce2-8eda-4fe524307c61

## Drafts

| Direction | Draft ID | Preview | Review note |
|---|---|---|---|
| Initial plan result | `0807e347-db16-42dd-994b-fc04eb84d154` | https://p.superdesign.dev/draft/0807e347-db16-42dd-994b-fc04eb84d154 | Strong first structure; introduced shadows and one inconsistent total. |
| Horizontal decision band | `7435a09e-0542-4641-b2fa-375a5813fb7a` | https://p.superdesign.dev/draft/7435a09e-0542-4641-b2fa-375a5813fb7a | Makes trade-offs immediately visible; generated bottom summary still shows `824,50 kr` instead of `824,60 kr`. |
| Workspace with sticky plan rail | `94532647-7d54-49fc-87b8-65ab0423bbe1` | https://p.superdesign.dev/draft/94532647-7d54-49fc-87b8-65ab0423bbe1 | **Approved baseline:** stable basket workspace, vertical discrete alternatives, consistent key totals, and no shadow dependency. |

## Public flow drafts

| Route | Final draft ID | Preview | Readback checks |
|---|---|---|---|
| `/planlegg` | `e70c7978-04ed-4f97-809b-bfd215864238` | https://p.superdesign.dev/draft/e70c7978-04ed-4f97-809b-bfd215864238 | Flat surfaces; 12-item basket; explicit matching modes; temporary origin and local-storage copy; no account prompt. |
| `/planlegg/handle` | `89c63bc5-106f-4d8d-8bf5-8cfae6e20e1d` | https://p.superdesign.dev/draft/89c63bc5-106f-4d8d-8bf5-8cfae6e20e1d | Edge-to-edge 390px checklist; offline state; route order; readable completed item; only permitted sticky-bar shadow. |
| `/oppdag` | `fb896f7a-f310-4555-9476-1887eed97bc2` | https://p.superdesign.dev/draft/fb896f7a-f310-4555-9476-1887eed97bc2 | Norwegian offer conditions; 34/11/22 kr plan impacts; 824,60 kr current plan; no card shadows; non-sponsored statement. |

Superdesign CLI `0.5.1` could not resolve the approved branch directly as an `execute-flow-pages` source despite returning it through `fetch-design-nodes`. The flow therefore used the root canvas node while passing the complete approved workspace HTML as explicit context. The generated page HTML was then read back and corrected in child branches; two successful correction jobs returned empty draft arrays, so their generated IDs were recovered and verified through `fetch-design-nodes`.

## Next design gate

Review and approve the three public flow pages before implementation planning.
