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

> OpenClaw's memory system ([docs](https://docs.openclaw.ai/concepts/memory), [deep dive](https://milvus.io/blog/we-extracted-openclaws-memory-system-and-opensourced-it-memsearch.md)) is the gold standard for local-first AI memory. It stores everything in plain Markdown (human-editable, git-friendly), indexes it in a local SQLite file, and retrieves via **hybrid BM25 + vector search** with zero cloud dependency. Talky should adopt the same architecture.

### 8.1 Storage Layer — SQLite + sqlite-vec

| Priority | Request |
|----------|---------|
| 🔴 | **Replace flat `.md` memory files with SQLite index** — Keep Markdown as the human-readable source of truth (it's already there in `data/memory/*.md`) but build a parallel SQLite index (`data/memory.db`) using `sqlite-vec` for fast vector retrieval and `FTS5` for BM25 keyword search. No Qdrant, no Chroma, no server — just a single portable file. |
| 🔴 | **Auto-index on write** — Whenever a memory fact is written to `data/memory/{jid}.md`, immediately chunk and embed it into `memory.db`. On startup, detect any `.md` files not yet indexed and backfill. |
| 🟠 | **Chunking strategy** — Split each memory file into overlapping chunks (e.g. 150-token chunks, 30-token overlap). Each chunk gets its own vector row in SQLite. Store `jid`, `file`, `chunkIndex`, `text`, `embedding`, `createdAt` per row. |
| 🟡 | **Full conversation indexing** — Optionally index `data/chats/*.md` the same way so the bot can recall *"what did I tell Deep about X last month"* across the full chat history, not just extracted facts. |

### 8.2 Local Embeddings — No API Key Required

| Priority | Request |
|----------|---------|
| 🔴 | **`node-llama-cpp` local embedding model** — Use `node-llama-cpp` (already in the JS ecosystem) with a small GGUF embedding model. Recommended: `nomic-embed-text-v1.5.Q4_K_M.gguf` (~270 MB) or `embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB). Auto-download on first use from HuggingFace if the file is missing, cache to `data/models/`. |
| 🟠 | **Provider priority chain** — `config.yaml` field `embeddingProvider: "local" \| "gemini" \| "openai" \| "bm25-only"`. Auto-fallback order: local GGUF → Gemini text-embedding-004 → OpenAI → BM25-only. This means zero memory features are lost even without a GPU. |
| 🟡 | **Embedding model config** — Add `embedding.modelPath`, `embedding.modelCacheDir`, and `embedding.dimensions` to `config.yaml` so users can swap models without touching code. |

### 8.3 Hybrid Retrieval — BM25 + Vector

| Priority | Request |
|----------|---------|
| 🔴 | **Hybrid search function** — Replace the current token-overlap fallback with a proper hybrid scorer: `score = 0.7 × cosine_similarity + 0.3 × bm25_score`. Both signals run in the same SQLite query. Return top-K ranked chunks. This mirrors OpenClaw's exact weighting. |
| 🟠 | **MMR deduplication** — After scoring, apply Maximal Marginal Relevance to remove near-duplicate chunks from the top-K result so the context window gets diverse information. |
| 🟡 | **Temporal decay** — Multiply the final score by `exp(-λ × days_since_written)` so recent memories naturally rank higher than stale ones. Make `λ` configurable (`memory.decayRate` in config). |
| 🟡 | **Per-contact scope isolation** — Retrieval for a conversation with contact A should search A's memory first, then fall back to global memories. Implement as a `WHERE jid = ? OR jid = 'global'` filter. |

### 8.4 Background Memory Consolidation

| Priority | Request |
|----------|---------|
| 🟠 | **Always-on consolidation worker** — Inspired by [Google's Always On Memory Agent](https://venturebase.com/orchestration/google-pm-open-sources-always-on-memory-agent-ditching-vector-databases-for): run a background interval (every 30 min) that reads recent chat chunks, asks Gemini to extract new facts, deduplicates against existing memories, and writes only net-new facts. This replaces the per-message heuristic extraction. |
| 🟠 | **Entity extraction & linking** — When extracting facts, identify named entities (people, places, dates, projects). Link facts about the same entity so retrieval for "what does Anand like?" pulls facts from multiple conversations. |
| 🟡 | **Memory importance scoring** — Gemini assigns an importance score (1–5) to each extracted fact. Low-importance facts (score ≤ 2) are written to a "cold" store and excluded from the default top-K retrieval. |
| 🟡 | **Memory edit from chat** — If the user says *"forget that I told you X"* or *"update my age to 22"*, the bot should locate the relevant memory row and delete or update it, then confirm. |

### 8.5 Transparency (OpenClaw's Key Feature)

| Priority | Request |
|----------|---------|
| 🟡 | **Human-readable memory stays primary** — `data/memory/*.md` files remain the source of truth. The SQLite index is a derived artifact — if deleted, it rebuilds from the Markdown files. Users can open, read, and hand-edit memories in any text editor. |
| 🟡 | **Memory browser in web UI** — List all facts per contact, show their score, age, and source chunk. Allow one-click delete or inline edit. Rebuild the SQLite index after any edit. |
| 🟢 | **Memory export to JSON** — `bun run talky memory:export --format json` dumps every memory fact with metadata (confidence, entity links, timestamps) for portability. |

---

## 9. Self-Chat — Personal Assistant Mode

> The user's own WhatsApp number messages the bot (via `selfChatEnabled: true`). This turns self-chat into a full personal assistant: group intelligence hub, reminder engine, and natural-language config terminal — all through WhatsApp itself, no web panel needed.

### 9.1 Group Intelligence Hub

| Priority | Request |
|----------|---------|
| 🔴 | **On-demand group summary** — User sends: *"summarise [group name] last 24h"*. Bot reads `data/chats/{groupJid}.md`, picks the last N messages, and returns a bullet-point digest: key topics discussed, decisions made, anything unresolved. |
| 🟠 | **Daily digest push** — Every morning at a configurable time, the bot proactively sends the user a combined summary of all active groups: new threads, decisions, and anything mentioning the user. Config: `selfChat.dailyDigestTime: "08:00"`. |
| 🟠 | **Unread catchup** — *"What did I miss in [group]?"* — summarise everything since the user's last message in that group, highlighting any @mentions of the user. |
| 🟡 | **Cross-group topic search** — *"Has anyone mentioned the project deadline across any group?"* — search `data/chats/*.md` with hybrid memory search and return matches with group names and timestamps. |
| 🟡 | **Who said what** — *"What did Anand say about the hackathon?"* — filter by resolved contact name and return relevant quotes with dates. |

### 9.2 Reminder & To-Do Engine

| Priority | Request |
|----------|---------|
| 🔴 | **Commitment detection** — Background consolidation worker scans new messages for implicit commitments: *"I'll send you the doc tomorrow"*, *"remind me to call him Friday"*, *"I need to submit by Monday"*. Extracts them and stores in `data/reminders.json` with a due date. |
| 🟠 | **Proactive reminder delivery** — At the scheduled time (or morning digest), bot pushes pending reminders to the user via self-chat: *"📌 Reminder: submit assignment — due today (from chat with Deep, 2 days ago)"*. |
| 🟠 | **Reminder management via chat** — User can reply *"done"* to dismiss, *"snooze 2h"* to delay, or *"add reminder: call mom at 6pm"* to create manually. |
| 🟡 | **Reminder source linking** — Each reminder links back to the originating conversation: *"(from: College group, Apr 18)"* so the user can verify context. |
| 🟢 | **Recurring reminders** — *"Every Monday morning remind me to check the group"* — parse recurrence expressions and store a cron-style schedule in `data/reminders.json`. |

### 9.3 Natural Language Behavior Fine-Tuning

> Instead of editing `config.yaml` or `persona/soul.md` by hand, the user just tells the bot what to change — from WhatsApp.

| Priority | Request |
|----------|---------|
| 🔴 | **Instruction parser in self-chat** — Detect when a self-chat message is a behavior instruction: starts with *"from now on"*, *"stop"*, *"always"*, *"never"*, *"be more"*, *"don't"*, etc. Route these to a dedicated `handleBehaviorInstruction()` function instead of the normal reply path. |
| 🔴 | **Write back to persona files** — Behavior instructions update the right file: tone/style instructions → `persona/communication_rules.md`, identity facts → `persona/soul.md`, group-specific rules → `persona/groups/{jid}.md`, contact-specific rules → `persona/contacts/{jid}.md`. Gemini generates the updated content and the bot confirms: *"Got it — I've updated my rules for this group."* |
| 🟠 | **Config changes via chat** — *"mute the college group"*, *"add Deep to my allowlist"*, *"set reply delay to 3 seconds"* — parse these as config mutations, apply to `config.yaml`, and confirm. Validate before writing so a typo doesn't break the bot. |
| 🟠 | **Instruction history log** — Every behavior change is appended to `data/logs/instructions.md` with timestamp and original message. User can review what rules have been added over time. |
| 🟡 | **Instruction preview** — Before applying, bot shows what it will write and asks *"Does this look right? Reply yes to confirm."* Prevents accidental persona overrides. |
| 🟡 | **Rule conflict detection** — If a new instruction contradicts an existing rule (e.g. *"always reply quickly"* vs *"take at least 5 seconds"*), flag the conflict and ask which should win. |
| 🟢 | **Persona chat** — *"Show me my current soul"* or *"What are my communication rules?"* — bot reads and summarises the current persona files back to the user in a readable format. |

### 9.4 Self-Chat UX Polish

| Priority | Request |
|----------|---------|
| 🟡 | **Intent classifier** — First, classify the self-chat message into one of: `SUMMARY_REQUEST`, `REMINDER_MGMT`, `BEHAVIOR_INSTRUCTION`, `CONFIG_CHANGE`, `GENERAL_QUERY`. Route each to the right handler. Prevents the general reply path from mishandling administrative messages. |
| 🟡 | **Slash command shortcuts** — `/summary [group]`, `/reminders`, `/missed`, `/rules`, `/config` — quick shorthands so the user doesn't have to write full sentences every time. |
| 🟡 | **Confirm destructive actions** — Any instruction that deletes memories, removes a contact from allowlist, or clears a persona file requires an explicit *"yes"* confirmation reply before executing. |

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
- [ ] Build SQLite + sqlite-vec memory index with BM25 hybrid search (§8.1–8.3)
- [ ] Add self-chat intent classifier + group summary command (§9.1, §9.4)
- [ ] Add behavior instruction parser that writes back to persona files (§9.3)
