<p align="center">
  <img src="packages/vscode/assets/marketplace-icon.png" width="96" alt="SimpleCode">
</p>

<h1 align="center">SimpleCode</h1>

<p align="center">A long-term coding coworker. Two entry points: the VS Code sidebar and the terminal <code>sc</code>.</p>

<p align="center"><a href="https://github.com/lnexp/simple-code/blob/main/README.md">中文</a></p>

---

## What it is

SimpleCode (SC) is a coding agent: it takes a request, reads code, runs commands, edits files, and reports what it changed.

SC does not aim to be the strongest at any single task. It aims to be a **long-term coworker** — the longer you work together on a project, the better it knows what you decided, what you rejected, and where it went wrong before. Everything is invested in three things:

- **Continuity: remember, and recall at the right moment.** An approach you rejected last week should not be offered again this week; the lesson from the time it broke the approval logic should surface by itself the next time it touches that file. SC has a single continuous context; decisions, lessons and event archives are written as files in your project, and relevant entries are surfaced to the agent by keyword and by the files it touches.
- **Boundaries: trust matched to risk.** Reading and writing inside the workspace never interrupts you; crossing the boundary asks first; `git push` needs your approval by default; MCP secrets are expanded only inside the host process and are invisible to the agent's bash. Open where it is safe, nothing slips through where it is not.
- **Verification: growth needs evidence.** Whether the collaboration keeps getting smoother cannot rest on a feeling. During reflection SC reviews the corrections you made in that period and counts **how often the same kind of mistake happened a second time**, recording it in a ledger file in your project.

Equally clear is what it does not do: no "new session", no piling up features for single tasks, no long-term investment in working around a particular model's current weaknesses.

## Design philosophy

Two principles run through the whole product; the three points above are built on them.

### One session

The product has exactly one continuous context. There is no "new session".

A new session does not solve the problem — it hides it. You want a fresh session because the current one grew too long, too messy, or drifted off topic; but after starting over, every conclusion, problem and agreement reached so far sits on the other side, out of reach. SC instead lets the context metabolize: older conversation is summarized automatically, reduced in resolution, and offloaded to disk, to be retrieved when needed. **What drops is resolution, not data.**

This rests on **file system is memory**: memory does not live in a vector database or a private format, but in ordinary files on disk. The conversation is written turn by turn as JSONL, summaries are markdown, and conclusions, lessons and event archives are `.md` files, one directory each. The agent searches its memory with `grep`, `sed` and `cat` — the file system is itself a battle-tested memory system. It also means a human can read and edit all of it at any time.

### One tool

The model is given exactly one tool: `bash`. (Strictly, one and a half — there is also `view_image` for reading images, because binary pixels cannot travel through a pipe into the context.)

The point of **bash only** is not "fewer tools", but that the tool surface itself should be the command line: web fetching, patch application, memory search, symbol lookup, MCP calls and image generation are all commands inside bash in SC, not tool definitions injected into the context one by one. They can be piped and combined freely, and adding a command never changes the model's tool list.

The deeper reason: the command line is the interface models know best. Invent a new tool protocol for an agent and the model has to learn it; hand it a shell and it already knows how.

## Quick start

### 1. Install

macOS and Linux are supported; on Windows, use it inside WSL.

Search for `SimpleCode` in the VS Code Extensions view and install it (Cursor, VSCodium and other editors install it from Open VSX under the same name). No separate Node.js install is needed; the tool scripts run on the editor's bundled Node.

### 2. Configure a model

Create `~/.simple-code/settings.json`. The example below uses DeepSeek over the OpenAI Chat Completions protocol:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "providers": {
    "deepseek": {
      "protocol": "openai-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "${SIMPLE_CODE_API_KEY}",
      "models": {
        "deepseek-flash": { "contextWindow": 1000000 }
      }
    }
  }
}
```

Put the key in an environment variable — add it to `~/.zshrc` (bash users: `~/.bashrc`), then **fully quit and reopen VS Code**:

```bash
export SIMPLE_CODE_API_KEY=sk-...
```

- **There is no default model**: `provider`, `model`, `protocol`, `baseUrl` and `apiKey` are required, and every model must set `contextWindow` (the offload trigger is derived from it). If anything is missing, startup fails — SC does not guess.
- Write `baseUrl` up to, but not including, `/v1`; SC appends `/v1/chat/completions` itself. Any service compatible with that path is configured the same way.
- Three protocols: `openai-chat`, `anthropic-messages`, `openai-responses`.
- `apiKey` written as `${ENV_VAR_NAME}` is read from the environment; anything else is taken literally — don't put plaintext keys in the file.
- For a complete example (multiple providers, reasoning effort, timeouts, memory parameters), see [`settings.example.json`](settings.example.json); the `$comment` block at the top explains every field.

### 3. Start

Click the SimpleCode icon in the sidebar and just say what you need, e.g. "look at this project's structure and run the tests". The first time a project is used, SC creates `.simple-code/` in its root, where all memory lives; SC adds it to `.git/info/exclude` automatically so it never gets committed by accident (your `.gitignore` is untouched).

To have it follow your rules from day one, put an `AGENTS.md` in the project root (see "Conventions" below).

## Memory

### Tiered compression

As the conversation grows, history is compressed **in tiers**:

| Tier | State | What you can do |
|---|---|---|
| Hot | Original text in the context | Read directly |
| Warm | Summary in the context, original offloaded to disk | Follow the summary's pointer back to the original |
| Cold | Archived as an event | Search by event name or keyword |

Warm summaries carry the location of the original; cold archives carry the event name — **what stays in the context is always the clue for finding it again**, not the content itself. Click "Context" in the bottom bar to see a snapshot of one request's tiers; when the agent is stopped you can trigger "compact now" from there.

### Layout

Everything lives inside the project directory, almost all plain text:

```
.simple-code/
├── memory/
│   ├── turns/000/turn-000123.jsonl   # full transcript per turn, never truncated
│   ├── summaries/                    # segment summaries, markdown
│   └── state.db                      # SQLite: runtime index and full-text search
├── notes/                            # general records in the root
│   ├── lesson/                       # lessons: one symptom per file
│   ├── principle/                    # principles: judgment, scope and evidence
│   └── goal/                         # goals: work, outcome, boundaries and completion criteria
├── events/                           # event archives: one event per file
├── skills/                           # skills: how to do a certain kind of task
├── diagnosis/                        # self-diagnosis ledger
├── tmp/                              # the agent's scratch files
└── approval.json                     # project-level approval rules
```

SQLite is only an **acceleration layer**; the same content is also written turn by turn as JSONL, and **the plain-text copy is the source of truth**. The database can be rebuilt; readability never depends on it.

Use `"$SIMPLE_CODE_NOTE" list/read/search/write` with `--type general|lesson|principle|goal`.
Legacy `lessons/` and `principles/` remain readable in place; upgrades do not move files or overwrite conflicts.
The old LESSON command is removed. Set `current: true` and `status: active` on one goal to make it current;
reading historical goals does not switch it. Use `paused` or `completed` for paused or finished goals.
Principles start as `candidate`; activate only with verified user approval, and supersede rejected principles
while preserving their evidence. The current goal and LRU-selected active principles enter system context
at existing compaction points; evidence is read on demand. All four types share `memory.noteBudgetTokens`
(2100 estimated tokens by default), with configurable `memory.noteRatios` of 35%/10%/20%/35%.
The current goal may borrow other types' space without exceeding the total or truncating its boundaries.

### Recalling at the right moment

Remembering is easy; recalling when it matters is the hard part. SC surfaces hints in two places, both as `〔recall·async〕` lines after a tool result:

- **By topic**: after you send a message, a side model compares it against the four note types, skills and events, picks the relevant entries, and matches history summaries using the keywords it produces.
- **By action**: when a command the agent runs touches a file or program (e.g. editing `approval.ts`, running `gh`), entries whose description mentions it are surfaced as "read this first", marked "触及" (touched) at the end of the line.

These are only hints; the agent decides whether to read them. **Off by default**: topic matching costs one extra side-model request per turn. Enable it with `"recall": { "mode": "on" }` in your settings (action hints follow the same switch).

### Conventions

`AGENTS.md` goes into the system prompt on every request. Put in it what is "used repeatedly and cannot be read from the code":

- `AGENTS.md` in the project root: this project's conventions and rejected proposals.
- `~/.simple-code/AGENTS.md`: personal conventions shared across projects.

Both are loaded, user-level first; on conflict the project wins. Each is capped at 2048 tokens and truncated beyond that — move what does not fit into notes.

### Reflection

The "Memory" button in the bottom bar opens the memory panel, where "Reflect" launches a background task that tidies notes, lessons and events: correcting stale entries, merging event fragments, writing an overview on one topic, and running a self-diagnosis — reviewing your corrections since the last reflection, deciding which were repeat mistakes ("it was in the library, yet happened again"), and recording them in `.simple-code/diagnosis/self-diagnosis.md`. It ends with a report — what it wrote, what it changed, what it dropped — which you can correct on the spot.

## Approvals

Default rule: **free inside the workspace, ask before crossing the boundary**.

- **Inside the project**: reads and writes run directly. Relative paths after `cd` (e.g. `cd packages && ls ..`) are judged by where they actually point.
- **Outside the project**: both reads and writes ask — the leak surface of other projects' source, `~/.ssh` and `/etc` is on the read side. The user-level `~/.simple-code/settings.json` is outside the project too, so it asks as well.
- **Hidden paths** (`.env`, `.ssh`, `.git`, and nested ones like `src/.env`): ask; only paths that actually exist are intercepted.
- **`.simple-code/`**: `notes/ lessons/ events/ skills/ tmp/ diagnosis/` are free to read and write — the agent's self-improvement area; the rest is free to read but asks before writing — planting false memories into turn files is a real attack surface.
- **Network commands** (`curl`, `wget`, `ssh`, `scp`, `rsync`, …), **interpreters** (`python`, `sudo`, `osascript`), and **commands with `$( )` or inline code such as `node -e`**: ask. `npm`, `pnpm`, `yarn` and `git` do go online but don't prompt in daily use.
- **Publishing**: `git push` and `gh` always ask by default; `askCommands` in `approval.json` can add your own (e.g. a private deploy CLI).

An approval card offers "always allow", recorded in `approval.json` by command shape (two copies: user-level `~/.simple-code/` and project-level `.simple-code/`).

The approval switch in the bottom bar is on by default; turning it off approves **everything** directly (including `git push`) — useful when you are watching and don't want to be interrupted.

## Terminal `sc`

When the extension activates it creates command entry points in `~/.simple-code/bin/`; add it to your `PATH`:

```bash
export PATH="$HOME/.simple-code/bin:$PATH"
```

```bash
sc                         # interactive chat, /exit to quit
sc "add tests for utils.ts"   # run one turn and exit
sc -m deepseek/deepseek-flash -e high "refactor this module"
cat error.log | sc "what causes this error"
sc --models                # list available models
```

It shares the same settings as the panel. Memory follows the directory: wherever you run it, it reads and writes that directory's `.simple-code/`. **Only one session can use a directory at a time** — while the panel has the project open, running `sc` in the same directory reports that it is already occupied by another simple-code process.

The terminal does not inherit VS Code's environment, so keys referenced in your settings must be exported in the shell. In one-shot mode **approvals are always denied** (nobody is there to approve), confining it to the workspace — which also makes `sc` a good sub-agent: create a directory, write a task brief, `sc > result.md &`.

## Multi-folder workspaces

When a VS Code workspace has several folders, SC runs **an independent agent per folder**, switched via the tab bar at the top, each with its own history, memory, model choice and background processes. An agent you switch away from **keeps running** — start a long task in A and switch to B for something else.

Approval cards from background folders do not pop up in the current view; the tab shows a pending badge, and you see and answer the card after switching over (auto-denied after 5 minutes without an answer) — approvals have to be judged in the context of the conversation, and moving them elsewhere only lowers the quality of that judgment.

## Images and image generation

- **Show it an image**: paste into the input box (Cmd/Ctrl+V); the agent can also read images from disk with `view_image`, or fetch images from web pages via `webfetch`. Images are compressed to at most 2048 px on the long edge and under 5 MB before sending.
- **Declare whether a model can see images**: by default it is treated as unable. For models that can (such as `deepseek-flash` above), add `"capabilities": { "images": true }` to the model config.
- **Main model without vision**: configure a vision model; images are first transcribed into text by it, then handed to the main model:

  ```json
  { "visionModel": { "provider": "provider name", "model": "model name" } }
  ```

- **Image generation**: once `imageModel` is configured (same shape as `visionModel`), the agent can generate images with `$SIMPLE_CODE_IMAGEGEN`; images are saved inside the project directory. Currently only services with the OpenAI image API (`/v1/images/generations`) are supported.

## MCP

MCP servers are configured in `~/.simple-code/mcp.json` (user-level only — a cloned repository cannot smuggle in executable commands through config); the agent calls them in bash via `$SIMPLE_CODE_MCP`. Write `${VAR}` in a remote server's `headers`; it is expanded only inside the host process, so the secret never enters the agent's bash environment.

## Development

```bash
pnpm install
pnpm test
pnpm run build
node scripts/deploy.mjs   # install into ~/.vscode/extensions
```

## License

MIT
