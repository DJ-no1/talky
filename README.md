# Talky

> Local-first personal WhatsApp AI agent — runs entirely on your machine, replies in your voice.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Runtime-Bun-black.svg)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Talky connects to your personal WhatsApp account, reads your messages, and replies on your behalf using Google Gemini. It knows who your contacts are, remembers things about them, and mimics your tone and style. Everything runs locally — no cloud storage, no message relay, no SaaS fees.

---

## How It Works

```
WhatsApp ──► Baileys client ──► Decision engine ──► Gemini (text / multimodal / TTS)
                                       │                       │
                              persona/soul.md          tool-executor
                              persona/contacts/         (files, stickers, GIFs)
                              data/memory/
                              data/chats/
```

1. Incoming messages are read via the unofficial [Baileys](https://github.com/whiskeysockets/baileys) library.
2. The decision engine decides whether to reply (hard rules: @mention, allowlist; soft rule: Gemini relevance score).
3. If replying, Gemini generates a response grounded in your persona files and retrieved memories.
4. The reply is sent back with a human-like typing delay.

All chat history, memories, and persona data stay in local Markdown files under `data/` and `persona/` — human-readable and version-control friendly.

---

## Features

- **WhatsApp connectivity** — QR-based auth, persistent session, auto-reconnect
- **Multimodal input** — text, images, voice notes, documents, stickers, videos via Gemini
- **Persona layer** — `soul.md`, communication rules, recent memory, per-contact and per-group profiles
- **Dual memory** — [Mem0](https://mem0.ai) API (when key provided) + local Markdown fallback always active
- **Smart reply decisions** — always replies on @mention; LLM-scored relevance for group chatter
- **Tool calling** — local file read/share, sticker send, KLIPY GIF search, image/voice generation
- **Multi-burst replies** — split one model output into multiple messages with `|||` separator
- **Web control panel** — live config editor, chat browser, persona editor, unauthorized inbox
- **Self-chat mode** — message your own number to control the bot and get group summaries
- **Fully local** — only Gemini and optional Mem0/Klipy API calls leave your machine

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| [Bun](https://bun.sh) | >= 1.1 |
| Google Gemini API key | [Get one free](https://aistudio.google.com/) |
| WhatsApp account | Any personal account |

Optional:
- `MEM0_API_KEY` — upgrades memory to semantic vector search via [Mem0](https://mem0.ai)
- `KLIPY_APP_KEY` — enables GIF search and send via [Klipy](https://klipy.co)

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/rocker1166/talky.git
cd talky

# 2. Install dependencies
bun install

# 3. Create your .env
cp .env.example .env        # then fill in your API keys

# 4. Create default config
bun run config:init         # writes config.yaml from defaults
# Edit config.yaml — add your allowed group/contact JIDs

# 5. Set up your persona
bun run persona:init        # creates blank persona/ files
# Edit persona/soul.md, communication_rules.md, recent_memory.md

# 6. Start
bun run start
# Scan the QR code in WhatsApp → Linked Devices
```

Web control panel is available at `http://127.0.0.1:4173/` while the bot is running.

Windows users: double-click `start-talky.bat`.

---

## Environment Variables

Create a `.env` file in the project root (see `.env.example`):

```bash
# Required
GOOGLE_GENERATIVE_AI_API_KEY=your_key_here   # or GEMINI_API_KEY

# Optional
MEM0_API_KEY=your_key_here      # enables semantic memory search
KLIPY_APP_KEY=your_key_here     # enables GIF reactions
GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts   # override TTS model
KLIPY_LOCALE=en                 # GIF locale
KLIPY_CONTENT_FILTER=medium     # off | low | medium | high
```

---

## Configuration

`config.yaml` controls all bot behaviour. Run `bun run config:init` to generate it with defaults, then edit. Key fields:

| Field | Default | Description |
|-------|---------|-------------|
| `botName` | `talky` | Bot identity name |
| `model` | `gemini-2.0-flash` | Gemini model |
| `directChatMode` | `allowlist` | `allowlist` / `all` / `none` |
| `replyOnlyOnMention` | `false` | Suppress all non-@mention replies |
| `alwaysReplyInAllowedGroups` | `true` | Skip LLM decision check in groups |
| `allowedGroupJids` | `[]` | Groups the bot is active in |
| `allowedDirectJids` | `[]` | Contacts the bot can DM |
| `selfSenderJids` | `[]` | Your own JIDs — bot reads but never replies |
| `historyWindow` | `15` | Messages of context per reply |
| `memoryTopK` | `5` | Memories injected per reply |
| `toolCallingEnabled` | `true` | Enable Gemini tool use |
| `stickerReplyMode` | `always-sticker` | `always-sticker` / `model` / `explicit-only` |
| `dailyMessageLimit` | `300` | Max group replies per day |

See `config.example.yaml` for the full annotated reference.

---

## Persona Files

All persona files are gitignored and local-only. They are auto-created with blank templates on first run.

```
persona/
  soul.md                    ← who you are (background, values, tone)
  communication_rules.md     ← how you write (style, phrases, emoji use)
  recent_memory.md           ← current life context (priorities, commitments)
  contacts/{jid}.md          ← per-contact relationship profile
  groups/{jid}.md            ← your role and tone in each group
```

The more detail you add, the more accurately the bot sounds like you.

---

## CLI Commands

```bash
bun run start                          # start the bot
bun run dev                            # start with file-watch reload
bun run relink                         # clear session and re-scan QR

# Config
bun run config:show
bun run config:init

# Persona
bun run persona:init                   # create blank persona files
bun run persona:paths                  # show file paths
bun run persona:dump                   # export persona to a single markdown

# Groups & Contacts
bun run groups:list                    # list all WhatsApp groups
bun run groups:active                  # list allowed groups
bun run direct:list                    # list allowed direct contacts
bun run direct:active
bun run direct:allow -- 91987xxxxxxx@s.whatsapp.net "Name"
bun run direct:disallow -- 91987xxxxxxx@s.whatsapp.net
bun run direct:poke -- 91987xxxxxxx@s.whatsapp.net   # send a one-off message

# Self-sender
bun run self:add -- 34312661561356@lid
bun run self:remove -- 34312661561356@lid

# Logs
bun run logs:mode -- minimal           # or verbose
bun run logs:toggle

# Memory
bun run memory:list
bun run memory:list 12345@s.whatsapp.net
bun run memory:export
bun run memory:clear
bun run memory:clear 12345@s.whatsapp.net

# Web UI
bun run ui:dev                         # dev server for the control panel
bun run ui:build                       # build the control panel
```

---

## Data Files

All runtime data lives in gitignored local directories:

```
data/
  chats/{jid}.md             ← chat history per contact/group
  memory/{jid}.md            ← extracted memory facts per contact
  logs/decisions.md          ← decision log (why replied or skipped)
  logs/tool-actions.md       ← tool call log (files sent, stickers, GIFs)
  stickers/*.webp            ← local sticker pack (optional)
wa_auth/                     ← WhatsApp session tokens (keep private)
config.yaml                  ← your personal bot config (keep private)
```

---

## Web Control Panel

Start the bot with `bun run start`, then open `http://127.0.0.1:4173/`.

| Tab | What it does |
|-----|-------------|
| Dashboard | Connection status, uptime, runtime config |
| Chats | Per-contact message history + debug events |
| Config | Live config editor |
| Inbox | Unauthorized contacts/groups — one-click allow or discard |
| Persona | Inline editor for soul, communication rules, recent memory |
| Actions | Session relink / repair |

---

## Project Structure

```
src/
  cli.ts              ← Commander CLI entry point
  whatsapp.ts         ← Baileys client & message loop
  decision.ts         ← Reply decision logic
  gemini.ts           ← Gemini SDK wrapper (text, multimodal, TTS, function calling)
  persona.ts          ← Persona file loader & auto-scaffold
  memory.ts           ← Memory read/write, Mem0 + local fallback
  storage.ts          ← Chat history & log I/O
  tool-executor.ts    ← Tool call dispatch loop
  tools.ts            ← File tool implementations + security layer
  config.ts           ← Config loader with typed defaults
  types.ts            ← Shared TypeScript types
  web/
    control-server.ts ← REST API for the web control panel
web-ui/               ← Vite + React control panel (separate package)
persona/              ← Your persona files (gitignored)
data/                 ← Runtime data (gitignored)
```

---

## Important Notes

- **WhatsApp automation is unofficial.** Use conservative delays and daily limits. Do not use this for spam or mass messaging.
- **Only Gemini (and optional Mem0/Klipy) API calls leave your machine.** All chat data, memories, and persona files stay local.
- Run only one Talky instance at a time per WhatsApp account — two instances cause `conflict/replaced` errors.
- A `stream:error` code `515` immediately after QR pairing is normal; Baileys reconnects automatically.
- To switch WhatsApp accounts: `bun run relink` (clears `wa_auth/` and prompts for a new QR).

---

## Roadmap

See [FEATURE_REQUESTS.md](FEATURE_REQUESTS.md) for the full backlog — including planned local hybrid memory (SQLite + embeddings), self-chat personal assistant mode, UI overhaul, and production hardening.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

- Bug reports and feature requests → [GitHub Issues](https://github.com/rocker1166/talky/issues)
- Large changes → open an issue first to discuss approach

---

## License

[MIT](LICENSE) © 2026 [Suman Jana](https://github.com/rocker1166)
