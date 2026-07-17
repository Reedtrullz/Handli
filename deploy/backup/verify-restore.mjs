#!/usr/bin/env node

import { safeMain, verifyRestore } from "./toolkit.mjs";

await safeMain(() => verifyRestore());
