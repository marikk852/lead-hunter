<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:project-conventions -->

## Lead Hunter project conventions

- **Read [docs/SPEC.md](docs/SPEC.md) before changing behaviour.** It is the
  normative requirement extract; the phase plan in `docs/IMPLEMENTATION.md`
  says what is in scope.
- **Never add automatic sending.** Messages are drafted into `Outreach` rows and
  the owner sends them. Compliance rules in SPEC.md §2 are non-negotiable.
- **Prisma 7:** the datasource URL lives in `prisma7.config.ts`, not in the schema.
  The client is generated into `src/generated/prisma` (gitignored, rebuilt by the
  `postinstall` script). Re-run `npm run db:generate` after editing the schema.
- **AI providers:** only `src/ai/providers/*` may import a vendor SDK. Everything
  else goes through `getAIProvider()`.
- **Prompts are frozen for caching.** `src/ai/prompts.ts` must contain no dates,
  ids or per-lead data, and per-lead JSON keys must keep a fixed order. Tests in
  `tests/prompts.test.ts` enforce this.
- **All output is schema-validated** by Zod, and the same schema is sent to the
  model as the structured-output format.
- **Never put `$` in a `.env` value.** `@next/env` and dotenv expand `$VAR` inside
  .env values, quotes do not protect against it, and it silently truncates secrets.
- **Server actions re-check the session** via `requireOwner()` — they are public
  POST endpoints.
- Run `npm run typecheck && npm test && npm run lint` before claiming a change works.

<!-- END:project-conventions -->
