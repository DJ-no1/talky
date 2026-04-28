# Talky

> Local-first personal WhatsApp AI agent — runs entirely on your machine, replies in your voice.

[License: MIT](LICENSE)
[TypeScript](https://www.typescriptlang.org/)
[Bun](https://bun.sh)
[PRs Welcome](CONTRIBUTING.md)

Talky connects to your personal WhatsApp account, reads your messages, and replies on your behalf using Google Gemini. It knows who your contacts are, remembers things about them, and mimics your tone and style. Chat history, persona, and memory files stay on disk under `data/` and `persona/`; only the LLM provider (and optional Mem0, Klipy, or a local Voicebox server) receives outbound API traffic.

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
- **Hybrid memory** — OpenClaw-style SQLite + FTS5 (BM25) + Gemini embeddings with cosine similarity, MMR dedup, and temporal decay. Markdown stays the source of truth; the SQLite index auto-rebuilds from it. Mem0 still layers on top when a key is present.
- **Self-chat assistant** — DM your own number to drive the bot in natural language: on-demand group summaries, daily digest push, reminder engine, and live config/persona tuning via slash commands or plain text.
- **Smart reply decisions** — always replies on @mention; LLM-scored relevance for group chatter
- **Tool calling** — local file read/share, sticker send, Klipy GIF search, image generation, Gemini TTS; optional Voicebox-compatible server for voice notes when `VOICEBOX_BASE_URL` and `VOICEBOX_PROFILE_ID` are set
- **Multi-burst replies** — split one model output into multiple messages with `|||` separator
- **Web control panel** — live config editor, chat browser, persona editor, unauthorized inbox
- **Privacy-minded** — chat logs and persona stay on disk; outbound calls are only to Gemini (required) and optional Mem0, Klipy, or a Voicebox server you configure

---

## Prerequisites


| Requirement           | Version                                      |
| --------------------- | -------------------------------------------- |
| [Bun](https://bun.sh) | >= 1.1                                       |
| Google Gemini API key | [Get one free](https://aistudio.google.com/) |
| WhatsApp account      | Any personal account                         |


Optional:

- `MEM0_API_KEY` — upgrades memory to semantic vector search via [Mem0](https://mem0.ai)
- `KLIPY_APP_KEY` — enables GIF search and send via [Klipy](https://klipy.co)
- Voicebox — set `VOICEBOX_BASE_URL` and `VOICEBOX_PROFILE_ID` (see `.env.example`) to generate voice notes via your own Voicebox instance instead of Gemini TTS alone

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

Web control panel defaults to `http://127.0.0.1:4173/` while the bot is running (override with `WEB_UI_PORT` in the environment).

Windows users: double-click `start-talky.bat`.

---

## Environment Variables

Create a `.env` from `[.env.example](.env.example)`:

```bash
# Required
GOOGLE_GENERATIVE_AI_API_KEY=your_key_here   # or GEMINI_API_KEY

# Optional
MEM0_API_KEY=your_key_here      # enables semantic memory search
KLIPY_APP_KEY=your_key_here     # enables GIF reactions

# Optional overrides (uncomment to use)
# GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts
# KLIPY_LOCALE=en
# KLIPY_CONTENT_FILTER=medium   # off | low | medium | high

# Optional Voicebox (voice notes)
# VOICEBOX_BASE_URL=http://127.0.0.1:8000
# VOICEBOX_PROFILE_ID=replace-with-profile-id
# VOICEBOX_LANGUAGE=en
# VOICEBOX_ENGINE=qwen
# VOICEBOX_MODEL_SIZE=1.7B

# Web UI (read by the control server when the bot starts)
# WEB_UI_PORT=4173
```

---

## Configuration

`config.yaml` controls all bot behaviour. Run `bun run config:init` to generate it with defaults, then edit. Key fields:


| Field                        | Default            | Description                                  |
| ---------------------------- | ------------------ | -------------------------------------------- |
| `botName`                    | `talky`            | Bot identity name                            |
| `model`                      | `gemini-2.0-flash` | Gemini model                                 |
| `directChatMode`             | `allowlist`        | `allowlist` / `all` / `none`                 |
| `replyOnlyOnMention`         | `false`            | Suppress all non-@mention replies            |
| `alwaysReplyInAllowedGroups` | `true`             | Skip LLM decision check in groups            |
| `allowedGroupJids`           | `[]`               | Groups the bot is active in                  |
| `allowedDirectJids`          | `[]`               | Contacts the bot can DM                      |
| `selfSenderJids`             | `[]`               | Your own JIDs — bot reads but never replies  |
| `historyWindow`              | `15`               | Messages of context per reply                |
| `memoryTopK`                 | `5`                | Memories injected per reply                  |
| `toolCallingEnabled`         | `true`             | Enable Gemini tool use                       |
| `stickerReplyMode`           | `always-sticker`   | `always-sticker` / `model` / `explicit-only` |
| `dailyMessageLimit`          | `300`              | Max group replies per day                    |


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
bun src/cli.ts session:repair          # purge stale WA session files; keeps creds (then run start)

# Config
bun run config:show
bun run config:init

# Persona
bun run persona:init                   # create blank persona files
bun run persona:paths                  # show file paths
bun run persona:dump                   # export persona to a single markdown

# Groups & Contacts
bun run groups:list                                    # list all WhatsApp groups
bun run groups:active                                  # list allowed groups
bun run direct:list                                    # list allowed direct contacts
bun run direct:active

# All commands below accept a plain phone number (with or without +, spaces, dashes)
# OR a full JID. Bare digits are auto-converted to <digits>@s.whatsapp.net.
bun run direct:allow -- 919876543210 "Deep"            # phone number form
bun run direct:allow -- "+91 98765 43210" "Deep"       # formatted form
bun run direct:allow -- 919876543210@s.whatsapp.net    # raw JID form
bun run direct:disallow -- 919876543210
bun run direct:poke -- 919876543210                    # send a one-off message

# Self-sender (accepts phone number OR @lid JID)
bun run self:add -- 919732915928                       # phone form
bun run self:add -- 34312661561356@lid                 # @lid form (from logs)
bun run self:remove -- 919732915928

# Resolve a phone number to both @s.whatsapp.net and @lid forms (needs a live
# wa_auth session — run `bun run start` at least once so the session exists).
bun run contact:resolve -- 919876543210
bun run contact:resolve -- 919876543210 --add-self     # also add to selfSenderJids
bun run contact:resolve -- 919876543210 --allow-direct "Deep"   # also allow DM + save profile

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

# Quality
bun run typecheck                     # TypeScript — no emit```

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

## Adding Contacts & Self-Senders

You do not need to hand-copy WhatsApp JIDs from logs any more. The `direct:*`, `self:*`, and `contact:resolve` commands accept either:

- a **phone number** in any format — `919876543210`, `+91 98765 43210`, `+91-98765-43210`, `(919) 876 54321` — gets normalised to `<digits>@s.whatsapp.net`
- a **full JID** — `919876543210@s.whatsapp.net`, `34312661561356@lid`, or `120363…@g.us` — stored as-is

### When `@s.whatsapp.net` is enough

DMs and allowlists only need the phone form. These all work identically:

```bash
bun run direct:allow -- 919876543210 "Deep"
bun run direct:allow -- "+91 98765 43210" "Deep"
bun run direct:poke -- 919876543210
```

### When you actually need the `@lid` form

Inside groups, WhatsApp addresses users by their LID (e.g. `34312661561356@lid`), which is a separate server-side identifier — it cannot be derived from a phone number offline. You'll see it in bot logs as `participant: <lid>@lid` alongside `participantAlt: <phone>@s.whatsapp.net`. `selfSenderJids` often needs the LID form so the bot recognises your own messages inside groups.

Use `contact:resolve` to fetch both forms from the cached WhatsApp session without copy-pasting logs:

```bash
# One-shot: just print both forms
bun run contact:resolve -- 919732915928

# Add both forms to selfSenderJids automatically
bun run contact:resolve -- 919732915928 --add-self

# Add the phone form to allowedDirectJids and create a contact profile
bun run contact:resolve -- 919876543210 --allow-direct "Deep"
```

`contact:resolve` needs an existing `wa_auth/` session — run `bun run start` once and scan the QR first. The `@lid` form only prints if you've already exchanged at least one message with that contact (that's when Baileys learns and caches the mapping).

**Groups** — use `bun run groups:list` to print every joined group with its `@g.us` JID, then paste the ones you want into `allowedGroupJids` in `config.yaml`.

---

## Self-Chat Assistant

Message your own WhatsApp number (the same number the bot is linked to) to drive the bot as a personal assistant. Works with both slash commands and plain English.

### Enable self-chat (one-time setup)

1. **Link the bot to your WhatsApp.** Run `bun run start` and scan the QR with the phone that owns the number the bot should speak as.
2. **Register your own JIDs.** WhatsApp treats DMs-to-yourself specially, so the bot needs to know which JIDs are *you*. Easiest path — pass your phone number, the CLI resolves both the `@s.whatsapp.net` and `@lid` forms and writes them to `config.yaml`:
  ```bash
   bun run contact:resolve -- 919876543210 --add-self
  ```
   That populates `selfSenderJids` with both forms. You can also edit `config.yaml` by hand.
3. **Turn on self-chat.** In [config.yaml](config.yaml):
  ```yaml
   selfChatEnabled: true
   selfChatDigestEnabled: true       # optional: daily digest pushed to your DM
   selfChatDigestHour: 9             # local hour (0–23) for the digest
   selfChatReminderPollSeconds: 30   # how often to fire due reminders
  ```
4. **Restart** the bot and message yourself in WhatsApp (open your own chat — the one WhatsApp labels "Message yourself"). Try `/help` to see the command list.

**Troubleshooting** — if the bot doesn't reply to your self-messages:

- Confirm you see `[READY] Listening for new messages as <your-jid>` in the terminal before sending (messages sent during the startup grace window are dropped).
- Check the log for `self-chat allowed (selfChatEnabled=true)`. If instead you see `direct not in allowlist`, your JIDs weren't saved to `selfSenderJids` — re-run `contact:resolve -- <your-number> --add-self`.
- The bot's own outbound sends are tagged `fromMe: true` and skipped; only inbound messages from the same number trigger replies.

### Slash commands


| Command      | Example                                      | What it does                                                         |
| ------------ | -------------------------------------------- | -------------------------------------------------------------------- |
| `/help`      | `/help`                                      | List available commands and intents                                  |
| `/summary`   | `/summary college 24h`                       | Summarise last N hours of a group chat (topics, decisions, mentions) |
| `/digest`    | `/digest`                                    | Build a combined digest across all allowed groups right now          |
| `/remind`    | `/remind call mom tomorrow 7pm`              | Create a reminder (heuristic parser + Gemini fallback)               |
| `/reminders` | `/reminders`                                 | List pending reminders with IDs and due times                        |
| `/cancel`    | `/cancel <id>`                               | Cancel a pending reminder by ID                                      |
| `/tune`      | `/tune be shorter, no emojis`                | Apply a behavior instruction (persona + config mutations)            |
| `/ask`       | `/ask what did Deep say about the hackathon` | Run a memory query across indexed chats/memories                     |


### Natural language

The same intents work without slashes: *"summarise college last 24h"*, *"remind me to call mom tomorrow 7pm"*, *"mute the college group"*, *"add [91987xxxxxxx@s.whatsapp.net](mailto:91987xxxxxxx@s.whatsapp.net) to my allowlist"*, *"stop using emojis"*, *"from now on be more concise"*. Destructive mutations are logged to `data/logs/instructions.md`.

### Daily digest & reminders

- **Daily digest** — at `selfChatDigestHour` (default 9 AM local), the scheduler pushes a combined daily digest to your own DM if `selfChatDigestEnabled: true`.
- **Reminder delivery** — a background poller (`selfChatReminderPollSeconds`, default 30 s) checks `data/reminders.json` and sends due reminders back to you via self-chat.

---

## Memory

Talky ships an OpenClaw-inspired hybrid memory store. Markdown files under `data/memory/` and `data/chats/` remain the human-readable source of truth; the bot maintains a derived SQLite index at `data/memory.db` for fast retrieval.

- **Storage** — `bun:sqlite` with an `FTS5` virtual table for BM25 keyword search and a `Float32Array` BLOB column for 768-dim Gemini embeddings (`text-embedding-004`).
- **Hybrid scoring** — `0.7 × cosine_similarity + 0.3 × bm25_score`, followed by MMR deduplication (Jaccard 0.82 threshold) and a 45-day half-life temporal decay multiplier.
- **Auto-index** — every call to `remember()` writes the fact to Markdown AND indexes it in SQLite with an embedding. On first run, `memory.ensureReady()` backfills from any existing Markdown files.
- **Consolidation** — a scheduler tick runs `rebuildFromMarkdown()` every `memoryConsolidationHours` (default 6 h) so edits made directly to Markdown files get picked up.
- **Fallbacks** — if `memoryEmbeddingsEnabled: false` or no Gemini key is present, retrieval falls back to BM25-only; Mem0 is still layered on top when `MEM0_API_KEY` is set.
- **Config** — `memoryBackend` (`hybrid` or `legacy`), `memoryEmbeddingsEnabled`, `memoryConsolidationHours`, `memoryTopK`. See `config.example.yaml` for annotated defaults.

Drop `data/memory.db` at any time to force a full rebuild from the Markdown files — the index is always derivable.

---

## Web Control Panel

Start the bot with `bun run start`, then open `http://127.0.0.1:4173/` (or the port set in `WEB_UI_PORT`).


| Tab       | What it does                                               |
| --------- | ---------------------------------------------------------- |
| Dashboard | Connection status, uptime, runtime config                  |
| Chats     | Per-contact message history + debug events                 |
| Config    | Live config editor                                         |
| Inbox     | Unauthorized contacts/groups — one-click allow or discard  |
| Persona   | Inline editor for soul, communication rules, recent memory |
| Actions   | Session relink / repair                                    |


---

## Project Structure

```
src/
  cli.ts               ← Commander CLI entry point
  whatsapp.ts          ← Baileys client & message loop
  decision.ts          ← Reply decision logic
  self-chat.ts         ← Self-DM assistant (commands, reminders, digests)
  gemini.ts            ← Gemini SDK wrapper (text, multimodal, TTS, function calling)
  persona.ts           ← Persona loader & auto-scaffold
  memory.ts            ← Memory orchestration (hybrid + Mem0)
  memory-db.ts         ← SQLite + FTS + embedding index
  storage.ts           ← Chat history & log I/O
  tool-executor.ts     ← Tool call dispatch
  tools.ts             ← File tools + security limits
  prompts.ts           ← System / reply prompts
  config.ts            ← Config & env loading
  types.ts             ← Shared TypeScript types
  web/
    control-server.ts  ← REST API for the web control panel
web-ui/                ← Vite + React control panel (separate package.json)
persona/               ← Your persona files (gitignored)
data/                  ← Runtime data (gitignored)
```

---

## Important Notes

- **WhatsApp automation is unofficial.** Use conservative delays and daily limits. Do not use this for spam or mass messaging.
- **Only required and optional API calls leave your machine** — Gemini is required; Mem0, Klipy, and Voicebox are opt-in. Chat data, memories, and persona files stay local unless you enable those services.
- Run only one Talky instance at a time per WhatsApp account — two instances cause `conflict/replaced` errors.
- A `stream:error` code `515` immediately after QR pairing is normal; Baileys reconnects automatically.
- To switch WhatsApp accounts: `bun run relink` (clears `wa_auth/` and prompts for a new QR).
- **Corrupted or stuck session** (e.g. bad session / 500): run `bun src/cli.ts session:repair`, then `bun run start`. Use `relink` only if repair does not recover the link.

---

## Roadmap

Hybrid memory and self-chat are shipped. See [FEATURE_REQUESTS.md](FEATURE_REQUESTS.md) for the remaining backlog (web UI overhaul, production hardening, local embeddings, memory browser, recurring reminders, and related items).

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

- Bug reports and feature requests → [GitHub Issues](https://github.com/rocker1166/talky/issues)
- Large changes → open an issue first to discuss approach

---

## License

[MIT](LICENSE) © 2026 [Suman Jana](https://github.com/rocker1166)