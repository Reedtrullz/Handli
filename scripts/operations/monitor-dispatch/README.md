# Monitor dispatch Worker

Cloudflare Worker cron that dispatches the external public monitor every 15
minutes. GitHub's `schedule` event is best-effort and has been dropping most
15-minute ticks, so this is the primary trigger; the workflow's schedule entry
remains a backup.

## Deploy

From this directory:

```sh
npx wrangler@latest secret put GITHUB_TOKEN
npx wrangler@latest deploy
```

The secret is a fine-grained GitHub personal access token with:

- Resource owner: `Reedtrullz`
- Repository access: only `Handli`
- Repository permission: `Actions` read and write
- Expiration: at most 90 days

Rotate it with `wrangler secret put GITHUB_TOKEN`; no redeploy is needed.
Never commit the token.

## Verify

```sh
npx wrangler@latest tail handli-monitor-dispatch
gh run list --repo Reedtrullz/Handli --workflow external-public-monitor.yml --event workflow_dispatch
```

A healthy dispatcher creates a `workflow_dispatch` run every 15 minutes. The
Worker is cron-only (`workers_dev: false`); it has no HTTP endpoint.
