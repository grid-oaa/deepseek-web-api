# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- chatglm.cn upstream served through the `glm-4-flash` and `glm-4-plus` model ids, dispatched by the `glm` model prefix.
- Optional `GLM_*` settings for the chatglm.cn endpoint, assistant id, user agent, and access/refresh tokens.

### Fixed

- `glm-*` requests now authenticate with the same three-step ladder as DeepSeek: the `.env` refresh token, then the `chatglm_refresh_token` cookie in the managed Chrome profile, then an interactive login in a visible browser whose result is written back to `.env`.
- Removed the chatglm.cn guest fallback, which the upstream rate limits with business code 10061.
- Interactive login no longer reuses a leftover headless Chrome, so a visible window is shown when a login is required.
- Session lineage fingerprints are hashed, so `data/sessions.json` no longer grows with the square of the conversation length.

## [0.1.0] - 2026-07-25

### Added

- Local OpenAI-compatible `POST /v1/responses` and `POST /v1/chat/completions` endpoints with streaming and non-streaming modes.
- Chrome/CDP login bootstrap, reusable auth snapshots, DeepSeek Web PoW solving, and persistent session lineage.
- Reasoning/output mapping, prompt-based function-call compatibility, Web search toggling, API-key protection, and model discovery.
- Pi integration guidance for both `openai-completions` and `openai-responses`.
- CI, contributor/security policy, architecture/API documentation, and release metadata.

### Security

- Loopback binding by default and owner-only runtime credential files.
- Runtime credentials, sessions, API keys, and Chrome profiles excluded from Git.

[Unreleased]: https://github.com/kittors/deepseek-web-api/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kittors/deepseek-web-api/releases/tag/v0.1.0
