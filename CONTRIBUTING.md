# Contributing

Thanks for helping improve `deepseek-web-api`.

## Before opening an issue

- Search existing issues first.
- Remove tokens, cookies, API keys, profile paths, and account details from logs.
- State the operating system, Node.js version, Chrome/Chromium version, request path, and whether the request is streaming.
- For upstream breakage, include the HTTP status and sanitized error text, but never attach `data/auth.json` or the Chrome profile.

## Development

Requirements: Node.js 20+, pnpm, and Chrome/Chromium for optional manual login testing.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Unit tests must not require a real DeepSeek account. Keep browser/login smoke tests manual or explicitly opt-in.

## Branches

- `main` — stable release branch, protected. Only accepts merges from `dev` via pull request.
- `dev` — active development branch. All feature/fix commits go here first.

Daily workflow:
```bash
git checkout dev
git add -A && git commit -m "..."
git push origin dev
# open PR: dev → main when ready to release
```

Never commit directly to `main`. Always work on `dev` and merge to `main` via PR.

## Pull requests

- Keep changes focused; do not refactor unrelated modules.
- Add or update tests for behavior changes.
- Keep every `src/**/*.ts` file at 300 lines or fewer.
- Preserve TypeScript strictness; do not use `any` or unsafe assertions to bypass boundary validation.
- Explain protocol decisions, especially PoW, SSE, session lineage, and tool-call mapping.
- Update README/docs when public behavior or configuration changes.

By contributing, you agree that your contribution is licensed under the MIT License.
