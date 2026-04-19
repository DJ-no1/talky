# Contributing to Talky

Thanks for your interest in contributing! Talky is a personal-use open-source project — contributions that make it more useful, stable, or private-friendly are very welcome.

## Before You Start

- Check the [feature requests & roadmap](FEATURE_REQUESTS.md) to see what's already planned.
- Open an issue before starting large changes so we can align on approach.
- Keep contributions focused. One feature or fix per PR.

## Development Setup

```bash
# Prerequisites: Bun >= 1.1, Node >= 20 (for type checking)
bun install

# Type check
bun run typecheck

# Run in watch mode (auto-restarts on file change)
bun run dev

# Build + preview the web UI
bun run ui:build && bun run ui:preview
```

Copy `config.example.yaml` to `config.yaml` and fill in your settings before running.

## Project Structure

```
src/
  cli.ts          — Entry point, Commander CLI commands
  whatsapp.ts     — Baileys client, message ingestion loop
  decision.ts     — Reply decision engine (hard + soft rules)
  gemini.ts       — Gemini SDK wrapper (text, multimodal, TTS)
  persona.ts      — Persona file loader & scaffold creator
  memory.ts       — Memory read/write, Mem0 integration, local fallback
  storage.ts      — Chat history & log file I/O
  tool-executor.ts — Tool call dispatch loop
  tools.ts        — File tool implementations + security layer
  config.ts       — Config loader with defaults
  types.ts        — Shared TypeScript types
  web/
    control-server.ts — REST API for the web control panel
web-ui/           — Vite + React control panel (separate package)
persona/          — Gitignored user persona files (soul, rules, contacts, groups)
data/             — Gitignored runtime data (chats, memory, logs)
```

## Guidelines

### Code style
- TypeScript strict mode is enabled. No `any` casts without justification.
- No comments explaining *what* code does — only *why* if non-obvious.
- Keep functions small and single-purpose.
- No new dependencies without discussion — bundle size and audit surface matter.

### Privacy first
- Never log or store message content beyond the existing `data/chats/` pattern.
- Never add telemetry, analytics, or any outbound calls beyond Gemini/Mem0/Klipy.
- All new features that touch contacts or chat content must be opt-in via `config.yaml`.

### What not to do
- Do not add features that require root/admin privileges.
- Do not bundle credentials, stickers, or any user-specific content.
- Do not change the `.gitignore` in a way that could accidentally expose `data/`, `wa_auth/`, or `config.yaml`.

## Pull Request Checklist

- [ ] `bun run typecheck` passes with no errors
- [ ] No new `any` types introduced
- [ ] `config.example.yaml` updated if a new config key is added
- [ ] README updated if a new CLI command or setup step is added
- [ ] No PII, credentials, or personal data in any committed file

## Reporting Issues

Open a GitHub issue with:
- What you did
- What you expected
- What happened (logs from `data/logs/` are helpful — redact any personal info first)
- Your OS, Bun version, and Talky version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
