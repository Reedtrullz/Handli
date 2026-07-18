#!/usr/bin/env node

import { createBackup, safeMain } from "./toolkit.mjs";

await safeMain(() => createBackup());
