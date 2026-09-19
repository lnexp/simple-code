<p align="center">
  <img src="packages/vscode/assets/marketplace-icon.png" width="96" alt="SimpleCode">
</p>

<h1 align="center">SimpleCode</h1>

<p align="center">A lightweight coding agent. Two entry points — the VS Code sidebar and the terminal — sharing one continuous context.</p>

<p align="center"><a href="README.md">中文</a></p>

---

## Overview

SimpleCode (SC) is a coding agent: it takes a request, reads code, runs commands, edits files, and reports what was changed.

Functionally it resembles its peers. The difference lies in two design principles that run through the entire product; every other trade-off is derived from them.

## Design principles

### One session

The product maintains exactly one continuous context. There is no "new chat".

Starting a new session does not solve the problem, it merely conceals it: the need for a fresh session arises precisely because the existing one has grown long, cluttered, or off track — and once a new one begins, every conclusion reached, every obstacle encountered, every convention established remains on an inaccessible side. SC lets the context metabolise instead: history is summarised automatically, reduced in resolution, offloaded to disk, and retrieved when required. **What degrades is resolution, not the data itself.**

This is made possible by **file system is memory**: memory resides neither in a vector database nor in a proprietary format, but in ordinary files on disk. Turns are written as JSONL, summaries as markdown, and conclusions, lessons and event archives as `.md` files under their respective directories. The agent retrieves memory with `grep`, `sed` and `cat` — no dedicated mechanism for "memory" is required, the file system being a thoroughly proven one already. It follows that all of it can be inspected and edited directly at any time.

### One tool

The model is exposed to a single tool: `bash`. (One and a half, strictly speaking — `view_image` also exists for reading images, since binary pixels cannot travel into the context through a pipe.)

The point of **bash only** is not a small number of tools, but that the tool surface should itself be a command line. Web fetching, patch application, memory retrieval, symbol lookup and MCP calls are all commands within bash rather than tool definitions injected into the context one by one. Three properties follow: they compose through pipes, they combine freely, and new commands require no change to the model's tool schema.

The more fundamental reason is that the command line is the interface the model knows best. Inventing a new tool protocol for an agent requires the model to learn it; providing a shell requires nothing, as the model already knows one.

## Installation

**VS Code extension**: search for `SimpleCode` in the Extensions panel. Model configuration is required before first use (see below).

**Terminal command `sc`** (optional): the extension does not modify `PATH`, nor does it write anything into the home directory. To use it from a terminal, create the link manually — `sc.js` ships with the extension, under its `dist/` directory:

```bash
mkdir -p ~/.simple-code/bin
ln -sf "$(ls -d ~/.vscode/extensions/lnexp.simplecode-*/dist/sc.js | tail -1)" ~/.simple-code/bin/sc
export PATH="$HOME/.simple-code/bin:$PATH"   # add to ~/.zshrc to persist
```

The extension directory name contains the version, so the `ln` command must be repeated after an upgrade. Installing from source requires none of this: `node scripts/deploy.mjs` creates the link and repoints it on every deployment.

A terminal does not inherit VS Code's settings, so any key referenced as `${ENV_VAR}` in the configuration must be exported in the shell, otherwise the first invocation fails:

```bash
export ZHIPU_API_KEY=...
```

## Configuration

The configuration file is `~/.simple-code/settings.json`. **There is no default model; five fields are mandatory.** A missing field raises an error at startup rather than being guessed:

```json
{
  "provider": "zhipu",
  "model": "glm-5.3",
  "providers": {
    "zhipu": {
      "protocol": "anthropic-messages",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "apiKey": "${ZHIPU_API_KEY}",
      "models": {
        "glm-5.3": { "contextWindow": 1000000 },
        "glm-5.3-flash": { "contextWindow": 1000000, "capabilities": { "images": true } }
      }
    }
  }
}
```

- An `apiKey` of the form `${ENV_VAR}` reads the environment variable; any other value is treated literally
- Three protocols are supported: `anthropic-messages`, `openai-responses`, `openai-chat`
- Every model must declare `contextWindow`; the offload threshold is derived from it

A complete example (reasoning effort, timeouts, approval allowlists, MCP) is provided in [`settings.example.json`](settings.example.json), whose leading `$comment` documents each option and the reasoning behind it.

## Terminal usage

```bash
sc                          # interactive session, /exit to quit
sc "add the missing tests for utils.ts"   # single turn, then exits; suitable for scripts
sc -m zhipu/glm-5.3 -e high "refactor this module"
cat error.log | sc "what causes this error"
sc --models                 # list available models
```

`--models` also expands `${ENV}` references from the configuration, so the key must be exported as well.

In one-shot mode **approvals are always denied**, as no one is present to grant them, confining activity to the workspace. This property also makes `sc` suitable as a sub-agent: create a directory, write a task brief, and run `sc > result.md &`.

## Context and memory: One session in practice

As a conversation grows, its earlier portions are compressed, and the compression is **tiered**:

| Tier | State | Available operations |
|---|---|---|
| Hot | Full text present in context | Read directly |
| Warm | Summary in context, full text offloaded to disk | Follow the summary's pointers back to the original |
| Cold | Filed into event archives | Retrieve by event name or keyword |

Warm summaries carry the location of the original; cold archives carry the event name. **What remains in context is always a pointer to retrieval**, never the content itself.

All of this resides within the project directory, predominantly as plain text:

```
.simple-code/
├── memory/
│   ├── turns/000/turn-000123.jsonl   # every turn verbatim, complete, never truncated
│   ├── summaries/                    # tiered summaries, markdown
│   └── state.db                      # SQLite: runtime index and full-text search
├── events/                           # event archives, one file per event
├── notes/                            # conclusions: decisions, conventions, one-off facts
├── lessons/                          # lessons learned, one file per symptom
└── approval.json                     # approval rules
```

The SQLite file serves only as an **acceleration layer**, handling paging and full-text search. The same content is written turn by turn as JSONL, and **the plain-text copy is the authoritative one for both humans and the agent**: broad searches grep the turns directory directly, and any file opens in an editor. The database can be rebuilt; readability does not depend on it.

## Multi-folder workspaces

A VS Code workspace may contain several folders, and SC runs **an independent agent for each**: switched via the tab bar at the top, each with its own conversation history, memory directory, model selection and background processes.

Crucially, **an agent that is switched away from does not stop**. It continues to run; only its UI updates cease to be pushed. History resides on disk, so switching back re-hydrates and resumes. A long task may therefore be started in folder A while other work proceeds in B, with results reviewed later.

The isolation is thorough: **approval prompts from background folders are not surfaced in the current view.** They wait in place, with a badge on the owning tab indicating how many are pending; switching to that folder reveals the cards and allows a response (after five minutes without one they are denied automatically; that command halts while the rest proceed). Background process status behaves likewise, showing only the current folder. This is a deliberate trade-off — an approval can only be judged against the surrounding conversation, and relocating the card to a view that lacks it would degrade that judgement, so only the signal that something awaits attention is carried across.

Each folder holds its own `.simple-code/`, so memory is isolated by construction. Model selection is likewise recorded per folder (`simpleCode.model:<path>`), allowing different models for a frontend project and a core project without interference.

## Images

A screenshot is frequently more precise than a verbal description — the exact form of an error, the position of a misaligned button, the anomalous point on a chart. One image conveys more than three paragraphs. Accordingly, although the design philosophy is text in and text out, the image path remains open:

- **Supplied by the user**: paste directly into the input field (Cmd+V). Dragging a file from the explorer is a distinct mechanism, producing a line of path text for the agent to read itself
- **Read by the agent**: `view_image <path>` reads an image from disk; capturing a screenshot for it to inspect rendering is standard practice
- **Images on the web**: those retrieved by `webfetch` enter the context alongside the text

Before transmission everything is resized to 2048px on the long edge and under 5MB, with the format detected from magic bytes rather than the extension (a `foo.png` containing jpeg data is not unusual, and an incorrect media type yields an immediate 4xx).

**Where the model lacks vision** — a common situation, as the strongest coding models do not necessarily read images, and `glm-5.3` in the configuration above is text-only — a vision model may be designated:

```json
{ "visionModel": "glm-5.3-flash" }
```

(Across providers, use the full form: `"visionModel": { "provider": "provider-name", "model": "model-name" }`.)

The image is first sent to the vision model and returned as prose — every piece of text transcribed verbatim, layout and geometry described, nothing inferred beyond what is visible — and that prose is delivered to the main model. **The main model therefore still receives text and emits text.** The philosophy remains intact, with a translation layer inserted at the boundary.

## Approvals

The default policy: **unrestricted within the workspace, confirmation required beyond it**.

- **Ordinary files inside the project**, read and write: executed directly, without interruption
- **Outside the project**: both reads and writes require confirmation. For other projects' source, `~/.ssh` and `/etc`, the exposure lies on the read side; writing is not the only risk
- **Hidden paths** (`.env`, `.ssh`, and mid-path cases such as `src/.env`): confirmation required. `.git` is exempt across its entire tree
- **Network commands** and any command containing `$()`: confirmation required, with everyday commands such as `npm`, `pnpm`, `yarn`, `git` and `node` exempted

`.simple-code/` follows a separate rule: **reads permitted, writes confirmed**, irrespective of whether it lies inside the project. The costs are asymmetric — retrieving history and event archives is an operation the product itself encourages, and blocking it would conflict with the product's own mechanisms, whereas **planting fabricated memories in a turn file constitutes a genuine attack surface**, so writes require confirmation. Two exceptions apply: writing `settings.json` requires confirmation (the apiKey resides there), and writing under `lessons/` is permitted (the lessons library is the agent's own growth area).

Approval cards offer an "always allow" option, recorded by command shape, with rules stored in `.simple-code/approval.json`.

## Development

```bash
pnpm install
pnpm test
pnpm run build
node scripts/deploy.mjs   # installs into ~/.vscode/extensions
```

## License

MIT
