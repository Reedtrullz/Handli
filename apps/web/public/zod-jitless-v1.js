// Zod checks this shared object before probing whether Function() is allowed.
// Keep validation JIT-free so the public CSP can continue to forbid unsafe-eval.
globalThis.__zod_globalConfig ??= {};
globalThis.__zod_globalConfig.jitless = true;
