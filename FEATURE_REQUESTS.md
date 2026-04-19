# Talky — Feature Requests & Roadmap

> Personal production-ready backlog. Covers incomplete features, UI gaps, and hardening work needed before this is a reliable daily driver.

---

## Table of Contents

- [Legend](#legend)
- [1. Web UI — Overhaul](#1-web-ui--overhaul)
- [2. Persona & Memory UX](#2-persona--memory-ux)
- [3. Incomplete Core Features](#3-incomplete-core-features)
- [4. Production Hardening](#4-production-hardening)
- [5. AI Quality Improvements](#5-ai-quality-improvements)
- [6. Observability & Debugging](#6-observability--debugging)
- [7. Future / Nice-to-Have](#7-future--nice-to-have)
- [8. "Remember Everything" — OpenClaw-style Local Hybrid Memory](#8-remember-everything--openclaw-style-local-hybrid-memory)
- [9. Self-Chat — Personal Assistant Mode](#9-self-chat--personal-assistant-mode)

---

## Legend

| Tag | Meaning |
|-----|---------|
| 🔴 **Critical** | Breaks daily use or leaks data without this |
| 🟠 **High** | Noticeably painful without this |
| 🟡 **Medium** | Quality-of-life improvement |
| 🟢 **Low** | Polish / future vision |
| 🔧 **Stub** | Code exists but feature is not wired up yet |
| ✅ **Shipped** | Implemented and in production |

---

## 1. Web UI — Overhaul // use anyy shadcn ui library , usable ui

The current `web-ui/src/App.tsx` is a single 600-line file with no component breakdown, raw `any` types throughout, and polling every 3 seconds on every tab load. These are the targeted improvements.

### 1.1 Architecture

| Priority | Request |
|----------|---------|
| 🔴 | **Split into components** — `App.tsx` is monolithic. Extract `StatusBar`, `ChatBrowser`, `PersonaEditor`, `InboxPanel`, `ConfigEditor`, `DebugLog` into separate files. |
| 🟠 | **Replace polling with SSE or WebSocket** — `fetchData()` fires 7 parallel API requests every 3 s regardless of active tab. Wire `EventSource` on the server and push only what changes. |
| 🟠 | **Add proper TypeScript types** — Remove all `any` casts. Define shared types matching the API response shapes. |
| 🟡 | **Route-based navigation** — Replace tab state with `react-router-dom` so each panel has a URL (`/chats`, `/persona`, `/config`). Deep-linking and browser back button will work. |
| 🟡 | **Persistent tab state** — Currently switching tabs loses scroll position and unsaved edits. |

### 1.2 Dashboard / Status Panel

| Priority | Request |
|----------|---------|
| 🟠 | **Live connection indicator** — Show WhatsApp connection state (connected / reconnecting / QR needed) as a persistent header badge, not buried in the status tab. |
| 🟠 | **QR code display in UI** — When session expires, show the QR code inline in the web panel instead of requiring terminal access. |
| 🟡 | **Daily message counter** — Show `messagesUsedToday / dailyMessageLimit` per group as a progress bar. |
| 🟡 | **Uptime + restart count** — Show process uptime and how many reconnects have happened since start. |
| 🟢 | **Gemini token / cost estimate** — Track approximate tokens used per day and show a running cost estimate based on Gemini 2.0 Flash pricing. |

### 1.3 Chat Browser

| Priority | Request |
|----------|---------|
| 🟠 | **Search across chats** — Full-text search over `data/chats/*.md` from the UI. Currently you have to open files manually. |
| 🟠 | **Show contact display name** — JIDs like `8250716094547@lid` are unreadable. Resolve to display names from persona/contacts or WhatsApp store. |
| 🟡 | **Message bubble UI** — Render chat history as a proper conversation (left/right alignment, timestamps) instead of raw markdown. |
| 🟡 | **Filter by group vs direct** — Tab or toggle to separate group chats from DMs. |
| 🟡 | **Send a message from UI** — Ability to send a one-off message to an allowed contact directly from the web panel (calls `direct:poke` equivalent). |

### 1.4 Config Editor

| Priority | Request |
|----------|---------|
| 🟠 | **Form-based config editor** — Replace raw YAML textarea with typed form fields (toggles for booleans, number inputs for limits, JID list management for allowlists). Less error-prone than hand-editing YAML. |
| 🟠 | **Validation before save** — Validate config schema client-side before posting. Currently a typo in YAML silently breaks the config. |
| 🟡 | **Config diff view** — Show what changed since last save before confirming. |
| 🟡 **Stub** | **Hot-reload confirmation** — The server reads config on each message. Add a toast confirming the new config was picked up successfully. |

### 1.5 Inbox (Unauthorized Contacts)

| Priority | Request |
|----------|---------|
| 🟡 | **Batch allow/discard** — Select multiple unauthorized candidates and allow or discard all at once. |
| 🟡 | **Preview last message** — Show the message text that triggered the unauthorized entry, not just the JID and count. |
| 🟡 | **Group info fetch** — For group JIDs in the inbox, fetch and show the group name (currently shows raw JID only). |

### 1.6 Persona Editor

| Priority | Request |
|----------|---------|
| 🟠 | **Contact profile editor** — `persona/contacts/*.md` files are edited on disk only. Add a contacts list in the UI with an inline Markdown editor per contact. |
| 🟠 | **Group profile editor** — Same as above for `persona/groups/*.md`. |
| 🟡 | **Autosave with debounce** — Stop using `alert('Persona saved')`. Autosave after 1.5 s of no typing and show a subtle "saved" indicator. |
| 🟡 | **Markdown preview toggle** — Add a split-pane preview next to the raw markdown editor. |
| 🟢 | **Memory browser** — View, search, and delete individual memory facts from `data/memory/*.md` per contact, without using the CLI. |

---

## 2. Persona & Memory UX

### 2.1 Memory Extraction

| Priority | Request |
|----------|---------|
| 🟠 | **Replace heuristic extraction with LLM extraction** — Current logic saves any message containing `"i "` or `"my "` under 220 chars with hardcoded confidence=0.7. Run a Gemini call to decide if a fact is worth storing and what confidence to assign. |
| 🟠 | **Deduplication** — No dedup exists. The same fact gets appended repeatedly across conversations. Add similarity-check before inserting a new memory. |
| 🟡 | **Memory decay** — Old low-confidence facts should get a staleness penalty over time. Add a `lastReinforced` timestamp and deprioritize stale memories during retrieval. |
| 🟡 | **Per-contact memory** — Memories are currently global (keyed by sender JID) but not surfaced in contact profiles. Link extracted facts to the relevant contact profile automatically. |

### 2.2 Persona Setup Flow

| Priority | Request |
|----------|---------|
| 🟠 | **First-run wizard** — New users face blank `soul.md` and `communication_rules.md`. Add a guided CLI/web onboarding that asks a few questions and writes a starter persona. |
| 🟡 | **Persona quality score** — Warn the user if `soul.md` or `communication_rules.md` are still empty/default so they know the bot is replying without any personal context. |

---

## 3. Incomplete Core Features

These are partially wired in code but not fully functional.

### 3.1 Image Generation 🔧

| Priority | Request |
|----------|---------|
| 🔴 | **Wire a real image backend** — `send_image_reply`, `send_meme_reply`, and `send_styled_quote_card` tools are declared and called by Gemini but the generation layer returns `ok: false`. Options: Gemini 2.0 native image output (now GA), Replicate Flux, or a local Stable Diffusion endpoint. |
| 🟡 | **Meme template library** — `send_meme_reply` needs a set of base templates. Provide 10–15 common meme formats as local `.webp` / `.png` files with text overlay using `sharp` or `canvas`. |

### 3.2 Sticker System 🔧

| Priority | Request |
|----------|---------|
| 🟠 | **Provide a default sticker pack** — `stickerPackDir` is configurable but the directory is empty. Bundle at least one small pack (10–15 `.webp` files) so the tool works out of the box. |
| 🟠 | **Sticker upload UI** — Add a drag-and-drop sticker pack manager in the web panel to upload `.webp` files without touching the filesystem. |
| 🟡 | **`send_sticker` fallback** — When no matching local sticker exists and no recent incoming sticker is available, fall back to a GIF via Klipy instead of silently failing. |

### 3.3 Voice / Audio 🔧

| Priority | Request |
|----------|---------|
| 🟡 | **Confirm `describeIncomingAudio()` coverage** — Verify that voice notes from all message types (PTT, audio file, video) correctly route through Gemini audio input. Add a test fixture. |
| 🟡 | **Transcription in chat log** — When a voice note is processed, append the Gemini-produced transcript to `data/chats/*.md` so the chat history is searchable text. |


### 3.4 Proactive Messaging

| Priority | Request |
|----------|---------|
| 🟡 | **Scheduled pokes** — Extend `proactiveOnStartupDirectJids` into a proper cron-style scheduler. Example: send a morning check-in to specific contacts at 9 AM. |
| 🟢 | **Event-triggered proactive** — Let the bot notice when a contact hasn't replied in N days and optionally nudge them (with explicit config opt-in). |

---

## 4. Production Hardening

Things that make this reliable as a 24/7 personal service.

### 4.1 Process Management

| Priority | Request |
|----------|---------|
| 🔴 | **Process supervisor** — Add a `pm2` ecosystem config or a `systemd` unit file so talky auto-restarts on crash and starts on system boot. Currently a crash ends the session. | 
| 🟠 | **Graceful shutdown** — Catch `SIGINT`/`SIGTERM` and flush pending messages + close the WhatsApp socket cleanly before exit. Avoids corrupt `wa_auth/` on force-quit. |
| 🟠 | **Health check endpoint** — Add `GET /api/health` returning process uptime, WA connection state, and last message timestamp. Needed for any external monitoring. |

### 4.2 Session Stability

| Priority | Request |
|----------|---------|
| 🟠 | **Reconnect backoff cap** — Current exponential backoff is unbounded. Cap at 5 min so a transient WA outage doesn't cause infinite waits. |
| 🟡 | **Session backup** — Periodically snapshot `wa_auth/` to a timestamped backup folder. If the session corrupts, restore from backup without a new QR scan. |
| 🟡 | **Multi-device detection** — Detect when the WhatsApp account was logged out from another device and alert via a push notification or log before retrying. |

### 4.3 Security

| Priority | Request |
|----------|---------|
| 🔴 | **Web panel auth** — `http://127.0.0.1:4173` has zero authentication. If the machine is on a shared network, anyone can access config + chat history. Add a simple token-based auth (env var `CONTROL_TOKEN`) checked on every API request. |
| 🟠 | **`.env` secret rotation reminder** — On startup, warn if `GOOGLE_GENERATIVE_AI_API_KEY` or `KLIPY_APP_KEY` haven't been rotated in >90 days (check a `lastRotated` field in a local metadata file). |
| 🟡 | **Rate-limit the control API** — The control server has no rate limiting. Add per-IP limits to prevent brute-force on any future auth layer. |
| 🟡 | **Redact secrets from logs** — Ensure API keys, JIDs from config, and file paths don't appear in `data/logs/*.md` in plaintext. |

### 4.4 Data Management

| Priority | Request |
|----------|---------|
| 🟠 | **Chat log rotation** — `data/chats/*.md` grows indefinitely. Add auto-archiving: keep last N messages in the active file, move older content to `data/chats/archive/`. |
| 🟠 | **Decision log rotation** — `data/logs/decisions.md` and `tool-actions.md` grow unbounded. Rotate daily or at size threshold. |
| 🟡 | **Export everything** — Add a single CLI command `bun run talky export` that zips all persona, memory, and chat data into a portable archive for backup or migration. |
| 🟡 | **Delete all data for a contact** — One command to purge `data/chats/{jid}.md`, `data/memory/{jid}.md`, `persona/contacts/{jid}.md` — useful for GDPR-style cleanup. |

### 4.5 Error Handling

| Priority | Request |
|----------|---------|
| 🟠 | **Gemini quota / 429 handling** — When Gemini returns a rate-limit error, queue the reply and retry after the retry-after header delay instead of dropping the message. |
| 🟠 | **Tool execution error surfacing** — When a tool call fails (e.g. image gen returns `ok: false`), the bot should tell the user it failed rather than silently sending nothing. |
| 🟡 | **Structured error log** — Separate `data/logs/errors.md` (or `.json`) for exceptions vs. the decision/tool logs. Makes debugging crashes easier. |

---

## 5. AI Quality Improvements

### 5.1 Reply Quality

| Priority | Request |
|----------|---------|
| 🟠 | **Sender name in prompt** — The system prompt gets contact profile but not the resolved display name prominently. Add `Replying to: {name}` at the top of the context so Gemini can address them by name naturally. |
| 🟡 | **Language detection** — If a contact writes in Hindi or Bangla, the bot should reply in the same language. Add a language hint to the system prompt based on recent message language. |
| 🟡 | **Reply length calibration** — Add a `replyLengthStyle` config: `brief` (1–2 sentences), `normal` (default), `detailed`. Inject into the system prompt. |
| 🟡 | **Emoji / tone calibration** — `communication_rules.md` handles this manually. Add structured config options for emoji frequency and formality level that feed into the prompt automatically. |

### 5.2 Decision Engine

| Priority | Request |
|----------|---------|
| 🟠 | **Per-contact decision override** — Add a `alwaysReply: true` flag per contact profile so close contacts always get a response regardless of group settings. |
| 🟡 | **Feedback loop** — If the user manually replies to a message the bot skipped, treat that as a negative training signal and lower the skip threshold for that contact. |
| 🟡 | **Context window summarization** — When `historyWindow` is large, old messages fill the context without adding value. Run a Gemini summarization pass on messages older than the last 5 and inject a compact summary instead. |

---

## 6. Observability & Debugging

| Priority | Request |
|----------|---------|
| 🟠 | **Structured JSON logs** — Replace Markdown append logs with NDJSON (one JSON object per line). Easier to parse, filter, and export. Keep a human-readable view in the UI. |
| 🟠 | **Decision trace in UI** — The debug event stream shows decisions but not the full reasoning. Add an expandable row in the UI showing the exact prompt context sent for a given decision. |
| 🟡 | **Tool call timeline** — Visualize tool call chains per message (which tools were called, in what order, success/fail) as a mini waterfall in the chat browser. |
| 🟡 | **Uptime/stats API** — Expose `GET /api/stats` with messages processed today, average reply latency, tool call counts, and memory facts stored. |
| 🟢 | **Optional Grafana dashboard** — For power users: publish stats to a local Prometheus scrape endpoint and provide a ready-made Grafana dashboard JSON. |

---

## 7. Future / Nice-to-Have

| Priority | Request |
|----------|---------|
| 🟢 | **Telegram adapter** — Abstract the WhatsApp transport behind a `MessengerAdapter` interface. A Telegram version would share all the memory/persona/decision code. |
| 🟢 | **Plugin system** — Let tools be loaded from an external `plugins/` directory as `.ts` files, so custom tools (e.g. home automation, calendar, Notion) can be added without touching core code. |
| 🟢 | **Mobile companion app** — A minimal React Native app that mirrors the web panel for approving unauthorized contacts or checking chat history on the go. |
| 🟢 | **Local vector DB for memory** — Replace the Mem0 API dependency and the token-overlap fallback with a fully local embedding model + Qdrant/LanceDB. Zero external calls for memory. |
| 🟢 | **Switchable LLM backend** — Abstract Gemini calls behind a `LLMProvider` interface. Allow swapping to Anthropic Claude, local Ollama, or OpenAI with a single config change. |
| 🟢 | **Voice-out style profiles** — Let `send_voice_reply` pick a TTS voice from a set of named profiles configured in `config.yaml` rather than hardcoding one voice per call. |

---

## 8. "Remember Everything" — OpenClaw-style Local Hybrid Memory

> **Status: ✅ Shipped (core).** Core hybrid memory lands in `src/memory-db.ts`, `src/embeddings.ts`, `src/memory.ts`, `src/scheduler.ts`. Markdown under `data/memory/` remains the source of truth; the SQLite index at `data/memory.db` is a derived artifact that auto-rebuilds. Remaining items (local GGUF provider, memory browser UI, full chat indexing, entity linking) tracked in §8.6 below.
>
> OpenClaw's memory system ([docs](https://docs.openclaw.ai/concepts/memory), [deep dive](https://milvus.io/blog/we-extracted-openclaws-memory-system-and-opensourced-it-memsearch.md)) is the gold standard for local-first AI memory. It stores everything in plain Markdown (human-editable, git-friendly), indexes it in a local SQLite file, and retrieves via **hybrid BM25 + vector search** with zero cloud dependency.

### 8.1 Storage Layer — SQLite + sqlite-vec

| Priority | Request |
|----------|---------|
| ✅ 🔴 | **Replace flat `.md` memory files with SQLite index** — Implemented in `src/memory-db.ts` using `bun:sqlite` + built-in FTS5. Vectors stored as `Float32Array` BLOBs (cosine computed in JS) instead of `sqlite-vec` to keep the dependency surface tiny. Markdown remains source of truth; DB is derived. |
| ✅ 🔴 | **Auto-index on write** — `MemoryService.remember()` writes Markdown + indexes into SQLite in the same call. `ensureReady()` runs `rebuildFromMarkdown()` on first use when the DB is empty or stale. |
| ✅ 🟠 | **Chunking strategy** — Implemented (150-token chunks with 30-token overlap). Each row carries `jid`, `source`, `chunkIndex`, `text`, `embedding`, `createdAt`. FTS5 mirror table updated via triggers. |
| 🟡 | **Full conversation indexing** — Chat-history ingestion (`data/chats/*.md`) is still opt-in and not wired into the default consolidation tick. Tracked in §8.6. |

### 8.2 Local Embeddings — No API Key Required

| Priority | Request |
|----------|---------|
| 🔴 | **`node-llama-cpp` local embedding model** — Not shipped. Initial attempt on Windows had native-build issues, so v1 ships with Gemini `text-embedding-004` (768-dim) as the only embedding provider. Tracked in §8.6 for a follow-up pass. |
| ✅ 🟠 | **Provider priority chain** — Implemented a simplified two-step chain in `src/embeddings.ts` + `src/memory.ts`: **Gemini embeddings → BM25-only**. Controlled by `memoryEmbeddingsEnabled` and presence of a Gemini API key. Local-GGUF and OpenAI rungs of the chain remain in §8.6. |
| 🟡 | **Embedding model config** — Partially shipped: `memoryBackend` and `memoryEmbeddingsEnabled` cover the on/off switches. Dedicated `embedding.modelPath` / `dimensions` fields only matter once local GGUF lands. |

### 8.3 Hybrid Retrieval — BM25 + Vector

| Priority | Request |
|----------|---------|
| ✅ 🔴 | **Hybrid search function** — `hybridSearch()` in `src/memory-db.ts` merges BM25 (FTS5 `bm25()` function) and cosine similarity with the exact `0.7 × vec + 0.3 × bm25` weighting. `MemoryService.retrieve()` calls it and falls back to legacy token-match when embeddings are off. |
| ✅ 🟠 | **MMR deduplication** — `dedupeMMR()` uses Jaccard similarity ≥ 0.82 over token sets to strip near-duplicates from the top-K result. |
| ✅ 🟡 | **Temporal decay** — `recencyMultiplier()` applies a 45-day half-life exponential decay (`exp(-ln(2) × days / 45)`) to the final score. Half-life is a module constant; making it a config knob is tracked in §8.6. |
| ✅ 🟡 | **Per-contact scope isolation** — `hybridSearch({ jid, includeGlobal })` filters by JID first and optionally merges globally-scoped rows. |

### 8.4 Background Memory Consolidation

| Priority | Request |
|----------|---------|
| ✅ 🟠 | **Always-on consolidation worker** — Partially shipped. `Scheduler.tickConsolidate()` runs `rebuildFromMarkdown()` every `memoryConsolidationHours` (default 6 h). Per-message heuristic extraction is still the primary write path; LLM-driven fact mining is tracked in §8.6. |
| 🟠 | **Entity extraction & linking** — Not shipped. Tracked in §8.6. |
| 🟡 | **Memory importance scoring** — Not shipped. Tracked in §8.6. |
| 🟡 | **Memory edit from chat** — Partial: `deleteChunksByJid()` / `deleteChunksBySource()` exist, but natural-language *"forget that…"* routing through self-chat is not wired yet. Tracked in §8.6. |

### 8.5 Transparency (OpenClaw's Key Feature)

| Priority | Request |
|----------|---------|
| ✅ 🟡 | **Human-readable memory stays primary** — Shipped. Markdown is the source of truth; `rebuildFromMarkdown()` regenerates the SQLite index from scratch whenever the user deletes or rotates `data/memory.db`. |
| 🟡 | **Memory browser in web UI** — Not shipped. Tracked in §8.6. |
| 🟢 | **Memory export to JSON** — Existing `bun run memory:export` dumps the Markdown side only. A structured JSON dump with embeddings and scores is tracked in §8.6. |

### 8.6 Future Memory Improvements

Follow-on work that complements the shipped core. All lower priority than the implemented base.

| Priority | Request |
|----------|---------|
| 🟠 | **Local GGUF embedding provider** — Ship `node-llama-cpp` with `nomic-embed-text-v1.5.Q4_K_M.gguf` so the bot works fully offline with zero API calls. Gate behind a platform check (skip on Windows without build tools) and auto-download to `data/models/` on first use. |
| 🟠 | **LLM-driven fact extraction in consolidation** — Replace the current heuristic `remember()` write path with a Gemini pass that scans the latest chat chunks, extracts net-new facts, scores importance (1–5), and deduplicates against existing memory rows before writing. |
| 🟠 | **Full conversation indexing** — Wire `data/chats/*.md` into the consolidation tick so `/ask` and normal retrieval can pull from the entire chat corpus, not just extracted facts. Add a `memoryIndexChats: true` config flag. |
| 🟠 | **Memory browser UI** — Web-panel tab to list chunks per contact with score, age, and source, inline-edit the source Markdown, and one-click delete a row (reindexes on save). |
| 🟡 | **Entity extraction & linking** — Named-entity pass over new chunks, store into an `entities` table, and let `hybridSearch()` optionally expand the query with linked entity IDs. |
| 🟡 | **Memory importance tier (cold store)** — Separate low-importance facts (score ≤ 2) into a cold table excluded from default top-K. Surface on explicit `/ask … --all`. |
| 🟡 | **Natural-language memory edits** — Self-chat intents for *"forget that I told you X"* / *"update my age to 22"* that locate the matching row, delete or rewrite, and confirm. |
| 🟡 | **Configurable decay half-life** — Expose `memoryDecayHalfLifeDays` (currently a 45-day module constant) in `config.yaml`. |
| 🟡 | **Structured JSON export** — Extend `memory:export` with `--format json` that dumps chunk text, embedding vectors (base64), scores, jid, source, createdAt. |
| 🟢 | **Embedding cache warm-up** — Pre-embed all Markdown on `memory:warmup` so the first chat reply after a fresh install isn't delayed by batch embedding calls. |
| 🟢 | **Alternative embedding backends** — Plug in OpenAI `text-embedding-3-small` or Voyage as alternate providers. |

---

## 9. Self-Chat — Personal Assistant Mode

> **Status: ✅ Shipped (core).** Implemented in `src/self-chat.ts`, `src/instruction-handler.ts`, `src/reminders.ts`, `src/summarizer.ts`, `src/scheduler.ts`. All 8 slash commands work; natural-language variants route through an intent classifier. Daily digest + reminder delivery drive via the scheduler. Remaining polish items (snooze, recurring reminders, preview/confirm, rule-conflict detection) tracked in §9.5 below.
>
> The user's own WhatsApp number messages the bot (via `selfChatEnabled: true`). This turns self-chat into a full personal assistant: group intelligence hub, reminder engine, and natural-language config terminal — all through WhatsApp itself, no web panel needed.

### 9.1 Group Intelligence Hub

| Priority | Request |
|----------|---------|
| ✅ 🔴 | **On-demand group summary** — Shipped. `/summary [group] [hours]` (and natural-language *"summarise X last 24h"*) route through `Summarizer.summarizeChat()`, which reads `data/chats/{jid}.md`, picks the last N messages, and returns JSON `{summary, actionItems, mentions}`. |
| ✅ 🟠 | **Daily digest push** — Shipped. `Scheduler.tickDigest()` fires once per day at `selfChatDigestHour` (default 9 AM), calls `Summarizer.buildDigest()` across all allowed groups, and self-DMs the formatted result. Gated by `selfChatDigestEnabled`. |
| 🟠 | **Unread catchup** — Not shipped; `/summary` covers the common case. Dedicated "since-last-read" tracking is tracked in §9.5. |
| ✅ 🟡 | **Cross-group topic search** — Shipped via `/ask <query>`, which runs hybrid memory search across indexed memories. Full chat-corpus indexing is tracked in §8.6. |
| 🟡 | **Who said what** — Partial: `/ask` already returns matching chunks, but there is no resolved-name filter. Tracked in §9.5. |

### 9.2 Reminder & To-Do Engine

| Priority | Request |
|----------|---------|
| 🔴 | **Commitment detection** — Partial. Explicit *"remind me to …"* works (`/remind` + natural-language), but background commitment mining over group messages (*"I'll send you the doc tomorrow"*) is not yet live. Tracked in §9.5. |
| ✅ 🟠 | **Proactive reminder delivery** — Shipped. `Scheduler.tickReminders()` polls `listPendingDue()` every `selfChatReminderPollSeconds` (default 30 s) and self-DMs `formatReminderDelivery()`. |
| ✅ 🟠 | **Reminder management via chat** — Partially shipped: `/remind`, `/reminders`, `/cancel` cover create/list/cancel. *"done"* dismissal and *"snooze"* are tracked in §9.5. |
| 🟡 | **Reminder source linking** — Not shipped. Tracked in §9.5. |
| 🟢 | **Recurring reminders** — Not shipped. Tracked in §9.5. |

### 9.3 Natural Language Behavior Fine-Tuning

> Instead of editing `config.yaml` or `persona/soul.md` by hand, the user just tells the bot what to change — from WhatsApp.

| Priority | Request |
|----------|---------|
| ✅ 🔴 | **Instruction parser in self-chat** — Shipped. `SelfChatAssistant` classifies `behavior_instruction` intent and routes to `applyNaturalLanguageInstruction()` in `src/instruction-handler.ts`. |
| ✅ 🔴 | **Write back to persona files** — Shipped for the common patterns: tone/style → `persona/communication_rules.md`, *"add to soul"* → `persona/soul.md`, recent-context lines → `persona/recent_memory.md`. Appends carry a `YYYY-MM-DD` prefix. Per-group/per-contact routing is tracked in §9.5. |
| ✅ 🟠 | **Config changes via chat** — Shipped for: mute/unmute group, mention-only mode, reply-tempo slower/faster, daily message limit. `saveConfigSnapshot` validates before writing. Extending the regex vocabulary is a §9.5 item. |
| ✅ 🟠 | **Instruction history log** — Shipped. Every applied instruction appends to `data/logs/instructions.md` with timestamp + raw text. |
| 🟡 | **Instruction preview** — Not shipped (changes apply immediately, then confirm). Tracked in §9.5. |
| 🟡 | **Rule conflict detection** — Not shipped. Tracked in §9.5. |
| 🟢 | **Persona chat** — Not shipped. Tracked in §9.5. |

### 9.4 Self-Chat UX Polish

| Priority | Request |
|----------|---------|
| ✅ 🟡 | **Intent classifier** — Shipped. `SelfChatAssistant.handle()` classifies into 9 intents: `help`, `summary`, `digest`, `reminder_set`, `reminder_list`, `reminder_cancel`, `behavior_instruction`, `memory_query`, `assistant_chat`. Regex-first with a Gemini fallback for reminder parsing. |
| ✅ 🟡 | **Slash command shortcuts** — Shipped: `/help`, `/summary`, `/digest`, `/remind`, `/reminders`, `/cancel`, `/tune`, `/ask`. |
| 🟡 | **Confirm destructive actions** — Not shipped. Tracked in §9.5. |

### 9.5 Future Self-Chat Improvements

Follow-on polish and coverage on top of the shipped core.

| Priority | Request |
|----------|---------|
| 🟠 | **Background commitment mining** — Extend the consolidation tick to scan recent group messages for implicit commitments ("*I'll send you the doc tomorrow*") and auto-create reminders linked to their source chat + message index. |
| 🟠 | **Snooze & done** — Reply *"done"* to dismiss, *"snooze 2h"* / *"snooze until Friday 6pm"* to re-schedule the most recent delivered reminder. Needs last-delivered pointer in scheduler state. |
| 🟠 | **Unread / since-last-read catchup** — Track the timestamp of the user's own last message per group and support *"/missed [group]"* to summarise everything after that. |
| 🟠 | **Extended config vocabulary** — Grow `instruction-handler.ts` regex coverage to: allowlist/disallow contact, toggle `askBeforeReply`, change `model`, set `historyWindow`, manage `stickerReplyMode`. |
| 🟠 | **Per-group / per-contact persona routing** — When a `/tune` instruction names a group or contact, write to `persona/groups/{jid}.md` or `persona/contacts/{jid}.md` instead of the global `communication_rules.md`. |
| 🟡 | **Instruction preview + confirm** — For destructive or persona-rewriting instructions, show a diff preview in chat and wait for *"yes"* before applying. |
| 🟡 | **Confirm destructive actions** — Explicit *"yes"* required to clear memories, remove allowlisted contacts, or overwrite persona files. |
| 🟡 | **Rule conflict detection** — Before appending a new rule, ask Gemini to flag conflicts with existing lines in `communication_rules.md` and surface the clash back to the user. |
| 🟡 | **Reminder source linking** — Carry the originating `chatJid` + chat-log offset on each reminder row; render *"(from: College group, Apr 18)"* in the delivery message. |
| 🟡 | **Recurring reminders** — Parse *"every Monday at 9am"* and store a cron-style `recurrence` field on `Reminder`. Scheduler re-seeds the next occurrence after delivery. |
| 🟡 | **Reminder nudging** — If a reminder goes unacknowledged for N hours, re-deliver with an escalating tone ("still pending — snooze or /cancel?"). |
| 🟡 | **Persona chat** — `/rules`, `/soul` — read current persona files and return a readable summary. |
| 🟡 | **Digest channels** — Per-group digest schedules, not just one combined daily digest. |
| 🟢 | **Attachment-aware digest** — When summarising, include counts of images/docs/voice notes shared in the window so the digest isn't text-blind. |
| 🟢 | **Multi-user self-chat** — Scope instruction history and persona edits per `ownerJid` if the bot serves more than one self-sender JID. |

---

## Quick-Win Checklist (Do These First)

These have the highest impact-to-effort ratio for daily use:

- [ ] Add auth token to web control panel (`CONTROL_TOKEN` env var)
- [ ] Wire `pm2` or a `start.sh` that auto-restarts on crash
- [ ] Wire Gemini 2.0 native image output to unblock `send_image_reply`
- [ ] Add a default sticker pack so `send_sticker` works out of the box
- [ ] Split `App.tsx` into components and fix `any` types
- [ ] Replace `alert('Persona saved')` with a proper toast
- [ ] Add chat log rotation (cap at last 500 messages per file)
- [ ] Add `GET /api/health` for uptime monitoring
- [x] Build SQLite + hybrid memory index with BM25 + vector search (§8.1–8.3) — shipped via `bun:sqlite` FTS5 + Gemini embeddings + cosine similarity
- [x] Add self-chat intent classifier + group summary command (§9.1, §9.4) — shipped as `SelfChatAssistant` with 9 intents and 8 slash commands
- [x] Add behavior instruction parser that writes back to persona files (§9.3) — shipped as `applyNaturalLanguageInstruction()`
