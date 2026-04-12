# Talky

Local WhatsApp AI agent using Bun + TypeScript.

**🔥 NEW: Talky now features a built-in Web Control Panel!**
Simply run `bun run start` and navigate to `http://127.0.0.1:4173/` in your browser.
Enjoy full UI control: config/allowlists, one-click allow for unauthorized groups/direct messages, interactive persona markdown editing, and session relink/repair—all without typing commands!

## What It Does

- Connects to your personal WhatsApp account via QR (`@whiskeysockets/baileys`)
- Reads incoming messages (text + image/audio/video + sticker + document analysis via Gemini input parts)
- Applies reply decision logic:
  - always replies if you are explicitly mentioned
  - supports `replyOnlyOnMention` mode
  - skips muted/blocked chats via config
- Generates concise style-aware replies with Gemini
- Supports automatic Gemini tool-calling for local file listing/reading/sharing and sticker actions
- 1:1 chats are forced-reply mode with funny Banglish/Benglish tone
- Can send multi-burst replies from one inbound (use `|||` chunking in model output)
- Can send sticker replies from recent incoming stickers or local `.webp` sticker packs
- Can share local files as WhatsApp documents (policy + size constrained)
- Stores local chat history, decisions, and memories in Markdown files under `data/`
- Uses Mem0 API key if available, with local Markdown fallback always active
- Persona layer (Clawbot-style): `persona/` folder with `soul.md`, communication rules, recent memory, contact/group profiles

## Setup

1. Install dependencies:

```bash
bun install
```

2. Ensure `.env` contains:

```bash
GOOGLE_GENERATIVE_AI_API_KEY=...
memo_api_key=...   # optional but supported
```

Supported env aliases:
- Gemini: `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`
- Mem0: `MEM0_API_KEY` or `memo_api_key` or `MEMO_API_KEY`

3. Create default config:

```bash
bun run config:init
```

4. Edit `config.yaml`:
- Add `allowedGroupJids` to restrict to specific groups
- Use `mutedGroupJids` to suppress groups
- Set 1:1 control using:
  - `directChatMode: allowlist` (recommended, only `allowedDirectJids`)
  - `directChatMode: all` (reply to all direct chats)
  - `directChatMode: none` (disable direct chat replies)
- Set `replyOnlyOnMention: true` if needed
- Set `runtimeLogMode` to control console noise:
  - `minimal` (default): clean USER/AI/ME flow lines only
  - `verbose`: full internal runtime info logs
- For groups, force reply on every message in allowed groups:
  - `alwaysReplyInAllowedGroups: true`
- If your own group messages appear with a `@lid` sender, add that id to:
  - `selfSenderJids: [34312661561356@lid]`
  so bot reads those messages for context but does not reply to them.
- `selfHistoryWindow: 3` controls how many of your own latest messages are injected into prompt context.
- Optional proactive startup ping (without inbound):
  - `proactiveOnStartupEnabled: true`
  - `proactiveOnStartupDirectJids: [91987xxxxxxx@s.whatsapp.net]`
- `senderHistoryWindow: 5` controls how many recent messages from that person are passed to LLM
- Tool calling and local file controls:
  - `toolCallingEnabled: true`
  - `toolLoopMaxSteps: 4`
  - `maxToolReadFileBytes` (LLM read cap)
  - `maxShareFileBytes` (document-share cap; supports up to 150000000)
  - `localFileAllowedRoots` (allowed absolute roots)
  - `localFileBlockedExtensions` and `localFileBlockedPathFragments`
  - `allowShareToAllowedGroups: true` to allow document/sticker sends in groups
- Sticker controls:
  - `stickerPackDir: data/stickers`
  - `allowForwardIncomingStickers: true`
  - `stickerReplyMode: model` (`model`, `always-sticker`, `explicit-only`)

5. Set up your personal voice files:

```bash
bun run persona:init
```

Then edit:
- `persona/soul.md` (who you are)
- `persona/communication_rules.md` (how you talk)
- `persona/recent_memory.md` (current context)
- `persona/contacts/*.md` and `persona/groups/*.md` (relationship + role context; contact files include `Name:` and `JID:`)

## Run

```bash
bun run start
```

Then scan the QR in WhatsApp -> Linked devices.

Windows one-click start:
- Double-click [start-talky.bat](C:/Users/Suman%20Jana/Desktop/talky/start-talky.bat)

## Commands

```bash
bun run config:show
bun run relink
bun run src/cli.ts relink --start
bun run persona:init
bun run persona:paths
bun run persona:dump
bun run groups:list
bun run groups:active
bun run direct:active
bun run direct:list
bun run direct:allow -- 91987xxxxxxx@s.whatsapp.net
bun run direct:allow -- 91987xxxxxxx@s.whatsapp.net "Riya"
bun run direct:allow -- 91987xxxxxxx
bun run direct:allow -- 34312661561356@lid
bun run direct:disallow -- 91987xxxxxxx@s.whatsapp.net
bun run self:add -- 34312661561356@lid
bun run self:remove -- 34312661561356@lid
bun run logs:mode -- minimal
bun run logs:mode -- verbose
bun run logs:toggle
bun run direct:poke -- 91987xxxxxxx@s.whatsapp.net
bun run memory:list
bun run memory:list 12345@s.whatsapp.net
bun run memory:export
bun run memory:clear
bun run memory:clear 12345@s.whatsapp.net
```

## Local Files

- `config.yaml` - behavior settings
- `wa_auth/` - WhatsApp session auth data
- `data/chats/*.md` - chat history per JID
- `data/logs/decisions.md` - decision log
- `data/logs/tool-actions.md` - tool/file-share/sticker action log
- `data/memory/*.md` - local memory facts
- `data/stickers/*.webp` - local sticker pack source files
- `persona/soul.md` - your identity/background
- `persona/communication_rules.md` - style/rules/examples
- `persona/recent_memory.md` - current life/work context
- `persona/contacts/*.md` - per-contact relationship memory
- `persona/groups/*.md` - your role/position in each group

## Notes

- WhatsApp automation is unofficial. Keep delays and limits conservative.
- This project is local-first. Only Gemini/Mem0 API calls leave your machine.
- Run only one Talky WA command at a time (`start` or `groups:list`), otherwise WhatsApp can return `conflict/replaced`.
- `stream:error` with code `515` right after pairing is normal; Baileys reconnects automatically.
- To relink or switch WhatsApp account quickly:
  - `bun run relink` (clear old auth, then run start manually)
  - `bun run src/cli.ts relink --start` (clear old auth and start QR flow immediately)
