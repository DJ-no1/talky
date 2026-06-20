# Talky — Claude Code Project Guide

Local-first personal WhatsApp AI agent. Bun + TypeScript. Connects to a personal
WhatsApp account via the unofficial Baileys library (WhatsApp Web protocol — no
official API). See `README.md` and `TALKY_ENGINE_ARCHITECTURE.md` for full docs.

## Dev commands

```bash
bun install            # install deps
bun run start          # start the bot (QR pairing on first run)
bun run typecheck      # tsc --noEmit
bun run ui:build       # build the web control panel (served at http://127.0.0.1:4173)
```

Run only ONE Talky instance per WhatsApp account (two cause `conflict/replaced`).
`config.yaml`, `data/`, `persona/`, and `wa_auth/` are local-only and gitignored.

---

## WhatsApp Mediator Protocol (Claude acts as the responder)

When `claudeMediatorEnabled: true` in `config.yaml`, Talky queues every allowed
inbound message for Claude instead of (or alongside) its own Gemini auto-reply,
and exposes a local HTTP bridge so Claude can read chats, see attachments, and
send replies through the live Baileys session.

### Data flow

```
incoming msg → Talky policy checks → data/claude/pending.jsonl   (event queue)
                                   → data/media/<file>           (attachments)
Claude → GET  /api/claude/pending  → decide → POST /api/claude/send → WhatsApp
       → POST /api/claude/ack      (mark handled)
```

Base URL: `http://127.0.0.1:4173` (override port with `WEB_UI_PORT`). The server
binds 127.0.0.1 only. The bot must be running (`bun run start`) for the API and
for sending; the queue files under `data/claude/` are readable even when it isn't.

### Endpoints

| Method | Route | Purpose |
| ------ | ----- | ------- |
| GET  | `/api/claude/status` | `{ mediatorEnabled, mediatorExclusive, connected, ownJid, pendingCount }` |
| GET  | `/api/claude/pending` | Array of pending events (see shape below) |
| GET  | `/api/claude/chat?jid=<jid>&limit=50` | Last N messages of any chat (from `data/chats/`) |
| GET  | `/api/claude/media?file=<basename>` | Raw bytes of a saved attachment from `data/media/` |
| POST | `/api/claude/send` | Body `{ "to": "<jid or phone>", "text": "..." }` — sends with human typing delay; `\|\|\|` splits into multiple messages (max 5) |
| POST | `/api/claude/ack` | Body `{ "ids": ["..."] }` — removes events from pending, archives to `handled.jsonl` |

Event shape (one per inbound message):

```json
{
  "id": "1759650000000-ABCDEF123456",
  "timestampISO": "2026-06-05T10:15:00.000Z",
  "chatJid": "919876543210@s.whatsapp.net",
  "senderJid": "919876543210@s.whatsapp.net",
  "senderName": "Deep",
  "chatName": "Deep",
  "isGroup": false,
  "mentionedMe": false,
  "text": "hey, did you see the pdf I sent?",
  "media": {
    "kind": "document",
    "mimeType": "application/pdf",
    "path": "C:\\...\\talky\\data\\media\\2026-06-05T10-15-00-000Z_919876543210atswhatsappnet_ABC.pdf",
    "fileName": "notes.pdf",
    "caption": ""
  }
}
```

`media.path` is an absolute local path — Claude can Read it directly (images,
PDFs) without going through the HTTP media endpoint.

### Mediator loop (how a Claude session should operate)

1. Start the watcher in the background — it exits the moment events arrive,
   which wakes the session:
   ```bash
   bun scripts/wait-for-events.ts --timeout-seconds 3600
   ```
2. On wake: `GET /api/claude/pending` (or parse the watcher's stdout JSON).
3. For context, pull history: `GET /api/claude/chat?jid=<chatJid>&limit=30`.
   Read attachments from `media.path` when relevant.
4. Compose the reply **in the user's voice**: follow `persona/soul.md`,
   `persona/communication_rules.md`, and the per-contact profile in
   `persona/contacts/<jid>.md`. Keep replies short and human; this is a personal
   WhatsApp account, not a support bot.
5. `POST /api/claude/send` with `{ to: event.chatJid, text }`.
6. `POST /api/claude/ack` with all handled event ids — even ones you chose not
   to reply to (deciding to stay silent is a valid handling).
7. Restart the watcher (step 1) and repeat.

Etiquette / safety:
- Groups: only reply when addressed (`mentionedMe`) or clearly relevant; never spam.
- Never send to a chat the user hasn't allowed unless explicitly instructed.
- When unsure how the user would respond to something personal/sensitive, skip
  the reply, ack the event, and surface it to the user instead.

### Concurrent subagent mediation (how to scale replies)

When the watcher/monitor reports pending events, do NOT serialize replies in the main
loop. Group events by `chatJid` and spawn **one subagent per chat, in parallel** (multiple
Agent calls in a single message). Each subagent must:

1. `GET /api/claude/context?jid=<chatJid>&senderJid=<senderJid>&query=<incoming text>&limit=20`
   — returns persona (soul, communication rules, contact/group profile), recent history,
   contact-scope memories, AND owner-scope memories in one call. **Always use this** —
   it is how per-contact style rules and Suman's personal memory stay in every reply.
2. Compose ≤2 messages (`|||` separator) following `persona.communicationRules` exactly
   (language mix, tone, emoji); ground in `history` + `memories` + `ownerMemories`.
3. Send via temp-file body (UTF-8 safety):
   `cat > /tmp/wa-<chat>.json` then `curl --data-binary @/tmp/wa-<chat>.json -X POST .../api/claude/send`
4. `POST /api/claude/ack` with its event ids.
5. Report the exact text sent + API confirmations back to the main agent.

Constraints per subagent: only message its assigned JID, max 2 messages, one retry max,
escalate to the main agent on errors or sensitive content instead of improvising.

### Config keys (config.yaml)

```yaml
claudeMediatorEnabled: true     # master switch
claudeMediatorExclusive: true   # true = Gemini auto-reply suppressed in mediated chats
claudeMediatorChats: []         # restrict to specific JIDs (empty = all allowed chats)
claudeTriggerCommand: ""        # optional shell command spawned on new events
                                # (e.g. headless: claude -p "Handle pending WhatsApp events per CLAUDE.md")
claudeTriggerCooldownSeconds: 30
```

Which chats reach the queue is still governed by the normal Talky policy
(`directChatMode`, `allowedDirectJids`, `allowedGroupJids`, mutes) — the mediator
sits after those checks. Set `directChatMode: all` to mediate every DM.

Notes:
- **LID-aware matching** — `src/lid-map.ts` consults `wa_auth/lid-mapping-*.json`, so an
  allowlist entry in either form (`<phone>@s.whatsapp.net` or `<lid>@lid`) matches both
  identities of the same contact.
- **Self-chat routing** — when the mediator is enabled, slash commands in the owner's
  self-DM go to the built-in assistant; all other self-messages are queued for Claude.
- **Sending non-ASCII** — write the send JSON to a temp file and POST with
  `curl --data-binary @file`; emoji/dashes passed as shell arguments get mangled on Windows.

### Files

- `src/claude-bridge.ts` — queue, media persistence, trigger spawn
- `src/whatsapp.ts` — `enqueueForClaudeMediator()` hook in `handleMessage`, `sendMediatedText()`
- `src/web/control-server.ts` — `/api/claude/*` routes
- `scripts/wait-for-events.ts` — blocking watcher used as the wake-up signal
- `data/claude/pending.jsonl` / `handled.jsonl` / `signal.json` — runtime queue state
