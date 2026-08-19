# backend/tests

Run these with `npm test` (which is `TZ=UTC jest`) — never a bare `npx jest`. The
`TZ` pin is load-bearing.

**Authoritative guidance lives in `.kiro/skills/test-suites/SKILL.md`.** Read it
before running, adding or judging a suite. It covers which suites are offline and
which write to the live production café, the `ZZTEST_` marker contract, the
browser-probe harness rule, and cleanup.

Two rules from it that apply to every file in this directory:

1. **Every test file must be a MODULE.** If it has no top-level `import` or
   `export`, add `export {};` at the bottom. Otherwise TypeScript compiles it as a
   global script and its top-level `const`s collide with every other script-mode
   suite (`TS2451`).
2. **Verify on a COLD cache**, because that collision is invisible on a warm one:

   ```bash
   cd backend && npx jest --clearCache && npm test    # cold
   cd backend && npm test                             # warm — the two must AGREE
   ```

The reasoning, the production consequence and the history are in the skill. They
are deliberately **not** repeated here — a rule that survives in two copies drifts,
and the copies then disagree about which one is current.
