# Talky Engine: Architecture & Overview

Welcome to the **Talky** project! This document breaks down the core architecture, how the engine operates, and how to run it in simple terms.

## 🎯 What is Talky?

Talky is a completely local, self-hosted personal WhatsApp AI agent. Once linked to your personal WhatsApp account via QR code, it reads incoming messages and replies on your behalf using Google Gemini. It acts like a digital clone of you—mimicking your tone and communication style—while keeping all your data private on your machine.

---

## 🧩 Core Architecture & Key Components

Talky is built using **TypeScript** and optimized to run on **Bun**. The engine operates through a series of distinct modular layers:

### 1. 🟢 WhatsApp Integration (`src/whatsapp.ts`)

- **The Connector:** Uses the unofficial `baileys` library to handle persistent WhatsApp web sessions and QR authentication.
- **Human Simulation:** It manages live messaging events and applies deliberate, human-like typing delays so the bot doesn't reply instantly like an emotionless script.

### 2. 🧠 Decision Engine (`src/decision.ts`)

- **The Gatekeeper:** Not every message needs a reply. This engine uses hard rules (like `@mentions` and allowed config lists) and soft rules (LLM-evaluated relevance scores) to decide if Talky should step in or stay quiet. This naturally prevents it from spamming group chats.

### 3. 🎭 Persona Layer (`src/persona.ts`, `/persona` folder)

- **The Soul:** This is what gives the bot your voice. A set of Markdown files (`soul.md`, `communication_rules.md`) define who the bot is, how to speak, and how to treat specific contacts. The agent reads these to ensure it stays in character.

### 4. 🗄️ Memory System (`src/memory.ts`, `src/memory-db.ts`, `src/embeddings.ts`)

- **The Brain:** Talky features a hybrid local memory module. It uses a local SQLite index backed by Gemini generated embeddings.
- **Searching:** When replying, it performs semantic search (cosine similarity) to find past memories relevant to the conversation. It acts as a long-term storage unit that continuously and automatically updates facts over time.
- **Optional Mem0:** Can hook into Mem0 for cloud-based semantic memory.

### 5. ⏰ Scheduling & Reminders (`src/scheduler.ts`, `src/reminders.ts`)

- **The Taskmaster:** Handles asynchronous tasks like sending multi-part "burst" messages, generating daily summary digests, and issuing reminder alerts.
- **Self-Chat:** A unique feature where you can DM your own number to command the bot behind the scenes.

### 6. 🛠️ Tools (`src/tools.ts`)

- **The Hands:** Allows Talky to reach outside of just text generation. Talky can send Klipy GIFs, interact with your local file system, and share media.

---

## ⚙️ How the Engine Processes a Message (The Loop)

1.  **Receive:** An incoming message hits the Baileys socket inside `whatsapp.ts`.
2.  **Filter Noise:** Basic spam/status messages are dropped by `log-noise-filter.ts`.
3.  **Decide:** `decision.ts` scores the message to see if a response is needed or allowed.
4.  **Recall Context:** If returning a reply, `memory.ts` and `embeddings.ts` fetch relevant past interactions and facts about the user.
5.  **Inject Persona:** The fetched memories, recent chat history, and your `/persona/soul.md` are combined into a massive prompt bundle via `prompts.ts`.
6.  **Generate:** `gemini.ts` sends this bundle to the Gemini AI to formulate the exact human-like reply.
7.  **Respond:** A human-like typing delay is applied, and the message is sent back to the chat via `whatsapp.ts`. `memory.ts` updates its database with this new interaction.

---

## 🚀 How to Run It!

I've already initialized the base configurations for you! Here is what you need to do next to actually launch the AI:

1. **Provide an API Key:**
   Open the `.env` file in the root of the project. Put your free Gemini API key on the line that says:
   `GOOGLE_GENERATIVE_AI_API_KEY=your_key_here`

2. **Configure your Soul (Optional but recommended):**
   Head into the `persona/soul.md` file and tweak the personality to match your exact tone.

3. **Start the Engine:**
   Run this in your terminal:

   ```bash
   bun run start
   ```

4. **Connect WhatsApp:**
   The terminal will output a QR Code. Open WhatsApp on your phone, navigate to **Linked Devices -> Link a Device**, and scan the QR code. You're now online! 🤖
