# 📄 PRODUCT REQUIREMENTS DOCUMENT (PRD)
**Project:** Personal WhatsApp AI Agent (Local + Mem0 + Gemini)  
**Version:** 1.0  
**Status:** Draft  
**Author:** AI Assistant  

---

## 🎯 1. Overview
A fully local, self-hosted AI agent that connects to your personal WhatsApp account via QR code authentication. It reads incoming messages (text, images, voice), maintains your persistent memories using **Mem0**, and decides whether to reply on your behalf using **Google Gemini API** for multimodal understanding and response generation. The agent mimics your communication style, respects context, and only replies when appropriate.

---

## 📌 2. Objectives
| Goal | Description |
|------|-------------|
| ✅ Seamless WA Auth | QR-based login with persistent local session |
| 🧠 Personal Memory | Mem0-powered, searchable, self-updating memory of your preferences, facts, and past interactions |
| 🤖 Context-Aware Replies | AI decides when to respond based on @mentions, group dynamics, and relevance to your memory |
| 🌐 Multimodal Support | Understand & respond to text, images, voice notes via Gemini API |
| 🖥️ Fully Local Execution | All infrastructure (WA client, memory store, orchestrator, logs) runs locally. Only Gemini API call is external |
| 🔒 Privacy & Control | Zero data sharing beyond Gemini API. Full export/delete control over memories & session |

---

## 🧩 3. Core Features

### 3.1 WhatsApp Connectivity
- QR code generation & scan via terminal/UI
- Automatic session persistence & recovery on restart
- Message ingestion: text, images, documents, voice notes, group metadata
- Outgoing message delivery with typing indicator & human-like delay

### 3.2 Memory System (Mem0)
- Local Mem0 instance backed by local vector DB (Chroma/Qdrant)
- Auto-extract & store facts from conversations (user style, preferences, relationships, commitments)
- Semantic retrieval: fetch top-k relevant memories per message
- Manual memory management: CLI/UI to view, edit, delete, or export memories

### 3.3 Decision Engine (When to Reply)
- **Hard Rule:** Always reply if explicitly `@mentioned`
- **Soft Rule:** LLM-assisted relevance scoring using memory + recent chat context
- **Silence Rules:** Ignore spam, broadcast lists, low-relevance group chatter
- Configurable thresholds, mute lists, and "ask before reply" mode for edge cases

### 3.4 Gemini Multimodal AI
- Input: Text, images, voice notes (native Gemini 2.0 audio/image support)
- System Prompt: Grounded in user profile + retrieved memories + recent context
- Output: Natural, concise, style-matched replies
- Fallback: `"NO_REPLY"` token if context doesn't warrant a response

### 3.5 Local Orchestration & Safety
- Message queue & rate limiting to avoid WA flags
- Local logging of all decisions & replies
- Health checks, auto-reconnect on WA disconnect
- Config file (`config.yaml`) for model, memory, behavior, and safety settings

---

## 🔄 4. Data Flow
```
[User] → Scans QR → WA Session Saved Locally
   ↓
[Incoming Message] → Parsed → @mention? / Group? / Direct?
   ↓
[Context Builder] → Fetches recent messages + Mem0 memories
   ↓
[Decision Engine] → Scores relevance → Reply? (Yes/No/Defer)
   ↓
[Gemini API] → Generates reply (text/media) grounded in memory
   ↓
[WA Client] → Sends reply → Logs interaction → Updates Mem0
   ↓
[Loop] → Waits for next message
```

---

## 🛠️ 5. Technical Stack (Fully Local)
| Component | Technology |
|-----------|------------|
| WhatsApp Client | `@whiskeysockets/baileys` (Node.js) or `whatsapp-web.js` |
| Orchestration | Python (FastAPI/CLI) or Node.js (single process) |
| Memory Engine | Mem0 (self-hosted) + ChromaDB/Qdrant (local) |
| AI Model | Google Gemini 2.0 Flash/Pro (API only) |
| Storage | SQLite/JSON (sessions, configs, logs) |
| Runtime | Docker Compose or direct local install |
| Voice Handling | Gemini native audio input OR local Whisper.cpp (optional) |

> ⚠️ Note: WhatsApp Web protocol is unofficial. Implement exponential backoff, random delays (2–5s), and typing simulation to minimize ban risk.

---

## 🧠 6. Memory & Context Specification

### 6.1 Memory Structure
```json
{
  "user_id": "whatsapp_jid",
  "memories": [
    {"fact": "Prefers short replies under 2 lines", "confidence": 0.95, "source": "manual"},
    {"fact": "Works at TechCorp as PM", "confidence": 0.88, "source": "chat_2024_10"},
    {"fact": "Avoids replying to weekend messages", "confidence": 0.92, "source": "rule"}
  ],
  "conversational_history": "last_50_messages_per_chat"
}
```

### 6.2 Context Window Assembly
1. Recent chat messages (last 10–15)
2. Top 5 Mem0 memories matching query
3. User profile (name, tone, rules)
4. System prompt template (strict grounding instruction)

---

## 🎛️ 7. Reply Decision Logic
| Condition | Action |
|-----------|--------|
| `@your_number` in text | ✅ Always reply |
| Direct question to you | ✅ Reply (LLM confirms) |
| Group message + matches your role/memory | ✅ Reply if relevant |
| Low relevance / spam / broadcast | ❌ Skip |
| Ambiguous context | ⏸️ Defer or ask for clarification |
| Config: `reply_only_on_mention=true` | 🔒 Only @mentions |

Decision prompt example:
```
Based on the conversation and user memory, should I reply? 
Output only: YES, NO, or DEFER.
```

---

## 🔐 8. Security & Privacy
- All sessions, memories, logs stored locally
- No telemetry, no third-party analytics
- Gemini API calls use HTTPS; user can proxy via local LLM later
- Memory export/delete via CLI (`mem0 export/delete --all`)
- Optional local-only mode (swap Gemini for Ollama/Llama)

---

## 🚧 9. Constraints & Risks
| Risk | Mitigation |
|------|------------|
| WhatsApp ToS violation | Random delays, human-like typing, no bulk actions, session rotation |
| Memory hallucination/drift | Confidence scoring, memory review mode, grounding prompts |
| Gemini rate limits/costs | Use `gemini-2.0-flash`, cache similar prompts, daily budget cap |
| Context window overflow | Sliding window + memory summarization |
| Voice note latency | Async processing, local Whisper fallback option |

---

## 📈 10. Success Metrics
| Metric | Target |
|--------|--------|
| Reply appropriateness | ≥85% (user feedback) |
| Response latency (text) | <5 seconds |
| Memory retrieval precision | ≥90% relevant matches |
| Session uptime | ≥95% (auto-reconnect) |
| User intervention rate | <10% of replies edited/corrected |

---

## ❓ 12. Open Questions
1. Preferred language for orchestration? (Node vs Python)
2. Should voice notes be transcribed locally or sent to Gemini?
3. Do you want a web UI for memory/config management, or CLI-only?
4. Should the agent learn from your corrections? (Reinforcement loop)
5. Max daily message limit before rate-limiting?

---
