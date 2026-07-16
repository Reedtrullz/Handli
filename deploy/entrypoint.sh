#!/bin/sh
set -eu

node /app/deploy/migrate.mjs
exec node /app/apps/web/server.js
