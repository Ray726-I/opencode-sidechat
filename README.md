# SideChat — a side chat panel for OpenCode 2

Ask questions about your work in a separate, persistent conversation
**without polluting the main chat**. The main transcript is never modified —
it is only *borrowed* as context when you ask.

Built natively for OpenCode V2 (`@opencode/plugin/tui`). No npm install, no
build step, no `cli.json` entry needed.

## Install

```bash
git clone https://github.com/Ray726-I/opencode-sidechat-v2 ~/.config/opencode/plugins/sidechat
```

Restart `opencode`. OpenCode discovers plugins under
`~/.config/opencode/plugins/` automatically. Open `/plugins` to confirm
`sidechat` is active. The folder name is up to you — the plugin declares its
own id, so stored chats stay put if you rename it.

The whole plugin is one file: `tui.tsx` (plus this README).

## Features

- **Theme integration** — the conversation uses the main chat's base surface,
  preserving theme transparency. User-message cards have a raised surface;
  the composer and edge handle blend into the surrounding pane. The outer
  frame is subtle, with a softer selected-tab fill.
  Colors follow live theme changes in light and dark modes.
- **Mouse toggle** — a small rounded handle sits on the pane's right edge:
  **‹** opens SideChat and **›** closes it. It highlights on hover and stays
  at the same mouse position in both states, including when pane widths
  differ. It overlays the edge margin without adding empty header rows;
  wrapping titles and scrolling cannot move it. **Alt+N** also toggles it.
- **Plan agent** — new side chats start with the `plan` agent. Existing tabs
  switch to Plan when opened, and every prompt checks the agent again before
  sending. The chosen model is preserved. Older Build replies keep their
  historical agent label.
- **Isolated conversations** — each side chat is its own session, created as a
  child of the main chat; nothing it says ever enters your main transcript.
- **Multiple side chats per session (tabs)** — start as many as you like,
  switch between them, and close the ones you're done with. Conversations are
  stored in the session database, so they survive restarts. Closing a tab
  preserves its conversation; **`/reopen`** restores the last closed tab.
  Closing another tab preserves the selected conversation.
- **Independent tabs** — one tab can work while you send a question in another.
  Drafts stay with their own tabs and survive closing/reopening the panel and
  plugin reloads during the current OpenCode run. Drafts are held in memory;
  restarting OpenCode clears unfinished drafts.
- **Request controls** — running status comes from OpenCode's session state
  and execution events, without a polling loop. Below the input, the footer shows **esc interrupt**
  beside an animated activity bar. Press **Esc** once to arm interruption,
  then again within five seconds to stop the current tab's response, matching
  the main chat. Interrupted replies show a muted **· interrupted** in their
  agent/model/time footer instead of an error. Changing tabs resets the
  confirmation. Failures are shown in the
  affected tab, including when the panel was closed when the request failed.
- **Reading position** — new output follows the bottom while you're there.
  Scrolling up keeps your position; **Jump to latest ↓** resumes following.
- **Incremental main context** — the first question with context on includes
  a recent main-session snapshot (up to 30 messages and 40k characters).
  Later questions include only new or edited messages in that recent window.
  Unchanged context adds no transcript text. Off by default.
- **Auto-titled chats** — the first question names the tab (and the session).
- **Markdown answers** — rendered with OpenTUI's markdown renderer; tool calls
  and reasoning follow the main chat's presentation: shaded user messages
  with an agent-colored left edge and an agent/model/time footer. Each reply's
  reasoning, tool activity, and intermediate tool-step commentary sit under
  one **Thinking ⧨** toggle, collapsed by default even while running. The
  answer remains visible outside it. Expand Thinking to inspect Thought
  rows, grouped tools, and tool inputs and outputs in their original order.
- **Persistence** — tab layout and active chat live in durable plugin storage;
  messages live in the normal session database.

## Keybinds (global)

| Shortcut        | Action                        |
| --------------- | ----------------------------- |
| `alt+n`         | Toggle the side chat panel    |
| `alt+shift+n`   | Start a new side chat (tab)   |
| `alt+shift+w`   | Close the current side chat   |
| `alt+[`         | Previous side chat            |
| `alt+]`         | Next side chat                |
| `alt+c`         | Toggle main-context injection |

In the composer: **Enter** sends, **Shift+Enter** inserts a newline, and it
grows up to 6 lines, wrapping to the current window width even within long
words or paths, with vertical scrolling for longer input. Click
**`Thinking ⧨`** to reveal a reply's reasoning and tool activity, including
while it streams. Within it, click **`+ Thought`** to expand reasoning.
Click a tool row or an **Explored** group to see the activity details. Text
selection does not toggle these disclosures. Colors update with the theme.

Type **`/`** in the side chat composer to see command suggestions; typing more
filters the list (for example, **`/m`** suggests **`/models`**). Use the arrow
keys to navigate, **Enter** to run, **Tab** to complete the command name, or
**Escape** to dismiss suggestions. Commands live in the `slashCommands` list
in `tui.tsx`, so adding a command also adds its autocomplete entry.

| Side chat command | Action |
| --- | --- |
| `/tabs` | Search open side chat tabs and select one to switch to |
| `/new` | Start a new side chat tab |
| `/close` | Close the current tab, keeping its conversation available to `/reopen` |
| `/reopen` | Restore the most recently closed tab |
| `/models` or `/model` | Choose the current side tab's model |

Esc closes autocomplete or a picker before it can arm interruption. The
interrupt shortcut applies only while the side composer has focus.

Run **`/models`** (**`/model`** also works) to open a simple searchable model
list, or click the model label beside the main-context toggle. Only available
models for that side chat's project are shown. Use the arrow keys and Enter,
or click a model; Escape cancels the selection. When the chosen model offers
thinking levels (such as `low`/`high`), a second list picks the level —
**Default** clears it — and the label beside the main-context toggle shows the
active level. The selection applies to subsequent turns in the current side
chat and is saved with that session. New side chats start with the model and
thinking level currently selected in the main chat.

Also available from the command palette (Ctrl+P → "SideChat"), `/sidechat`, or
by clicking the tabs, main-context switch, `+`, or `×` in the panel. Use
**SideChat: reopen closed chat** in the command palette or **`/reopen`** in
the side composer to restore the most recently closed tab.

## How it works

- The panel is contributed through the `session.panel` slot — the host owns
  sizing, focus, and full-screen presentation.
- Each side chat is a normal session created through the client API as a child
  of the main session, with the current model, and keyed per main session in
  durable storage. Because the session list shows root sessions only, side
  chats stay out of it; they also inherit the main session's location.
- With "context" on, `submit` refreshes the main transcript when you send a
  side question. Merely opening SideChat or talking in the main chat does
  not call the side model.
- Each side chat tracks the IDs and SHA-256 fingerprints of its most recent
  context window. Only user text and completed assistant text are shared;
  tool output and reasoning are excluded. A streaming reply is shared after
  it finishes, rather than repeatedly copying its partial text.
- A bounded context receipt is saved in the prompt's metadata together with
  the admitted question. It contains fingerprints, not a second transcript.
  OpenCode's saved messages and pending prompts recover that receipt after
  restarts. Rejected sends do not advance it. No separate model calls or
  summarization jobs are added.
- Turning context off pauses sharing. Turning it back on catches up within
  the recent window. Each side tab has its own receipt. Completed SideChat
  compaction, a main-chat rewind, missing history, or a gap beyond the window
  triggers a bounded refresh. Edits are labeled as replacements for earlier
  message IDs. Context batches stay below 40k characters; any omission or
  shortening is explicitly marked in the shared context.
- Older context remains in the side conversation until OpenCode compacts
  it. This upgrade does not erase previously duplicated snapshots. Existing
  side chats take one fresh snapshot to initialize incremental tracking.

## Notes & limits

- Side chats use the configured Plan agent's tools and permissions; tool
  calls may raise the usual permission prompts.
- Side chats are created as child sessions of the main chat, so the session
  list stays free of them; manage them from the panel (close with
  `alt+shift+w`/`×`, restore with `/reopen`). Closing a tab does not delete its
  session or interrupt a running response.
- Not a port of the V1 `opencode-sidechat` — this is a V2-native rewrite with a
  different feature set (no history browse UI yet).

## Uninstall

```bash
rm -rf ~/.config/opencode/plugins/sidechat
```
