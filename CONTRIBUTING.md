# Contributing

Thanks for helping improve TSWoW WebClient. The project targets TSWoW/TrinityCore WoW 3.3.5a build
12340 and favors changes that are measurable, testable and reproducible from a clean checkout.

## Set up a development checkout

```powershell
npm ci
Copy-Item .env.example .env
# Set TRINITYCORE_DIR in .env to the matching TSWoW TrinityCore checkout.
npm test
```

The core checkout supplies ignored protocol metadata; no WoW client files are needed for this clean
CI-style path. For runtime or integration work, also configure the original client and TSWoW dataset,
then generate and validate all local data:

```powershell
npm run client-data:generate
npm run doctor
```

Runtime and integration checks use the paths in `.env`; tests that require unavailable external
data skip on a clean checkout.

## Before opening a pull request

- Keep the change focused and add or update deterministic tests.
- Run `npm test` and report any skipped integration checks.
- If you have the matching core and dataset, also run `npm run build:full`.
- Run `git diff --check` and review the complete diff.
- Update README/configuration docs when commands, ports or environment variables change.
- Do not commit generated client or protocol tables, asset caches, MPQs, DBC/FrameXML files,
  database dumps, credentials, `dist/` build output or local absolute paths.
- Do not mix unrelated generated-source updates into a feature change.

Data-free facades and redistributable DBC layouts under `src/generated/` are committed and verified
with `npm run check:generated`. Implementations under `src/generated/client-data/` and
`src/generated/protocol-data/` are local-only, ignored by Git and generated from user-supplied
inputs. Game-derived caches under `data/` and `public/icons` are intentionally ignored as well.

## Reporting results

In a pull request, distinguish:

- what was changed;
- what was verified automatically;
- what requires a local TSWoW/client dataset;
- what still needs manual in-client verification.

Security reports must follow [SECURITY.md](SECURITY.md), not a public issue.
