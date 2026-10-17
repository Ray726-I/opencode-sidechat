# SideChat — a side chat panel for OpenCode 2

Ask questions about your work in a separate, persistent conversation
**without polluting the main chat**. The main transcript is never modified —
it is only *borrowed* as context when you ask.

Built natively for OpenCode V2 (`@opencode/plugin/tui`). No npm install, no
build step, no `cli.json` entry needed.

## Install

```bash
git clone https://github.com/Ray726-I/opencode-sidechat ~/.config/opencode/plugins/sidechat
```

Restart `opencode`. Both halves are discovered automatically under the
OpenCode config directory's `plugins/` folder (`~/.config/opencode/plugins/`,
or `$XDG_CONFIG_HOME/opencode/plugins/` when set). No explicit `plugins`
entry is needed for this install. Do not also register the same clone through
a `~` shortcut: duplicate registrations can fail with “Duplicate plugin ID”.
If you added that entry following an earlier README, remove the redundant
entry while keeping your other configured plugins.

Open `/plugins` to check for active SideChat server/TUI features; the entries
declare IDs `sidechat.server` and `sidechat`. The folder name is up to you —
stored chats are keyed by plugin ID, not the directory name. For clones
outside discovered plugin directories, add the clone to `plugins` in the
applicable `opencode.json(c)` instead. Relative paths resolve from that config
file; update an explicit path if you move or rename that clone.

The plugin is two files: `tui.tsx` (the panel) and `index.ts` (request-only
hidden context). Both halves must be active to send side questions; a missing
server half produces an error and keeps the draft rather than silently
answering without the requested context.

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
- **Per-tab agents, Plan by default** — manual new-chat actions (`/new`, `+`,
  **Alt+Shift+N**) offer an agent picker with Plan preselected. Automatic
  first/replacement tabs use Plan without a dialog. **`/agent`** (or the agent
  label beside the model) switches only the current tab. The choice lives in
  that session and survives closing/reopening or restarting. Opening a tab or
  sending a question never switches agents or models behind your back; legacy
  Build tabs keep Build. Only visible primary-capable agents are offered.
- **Isolated conversations** — each side chat is its own session, created as a
  child of the main chat; nothing it says ever enters your main transcript.
- **Multiple side chats per session (tabs)** — start as many as you like,
  switch between them, and close the ones you're done with. Conversations are
  stored in the session database, so they survive restarts. Closing a tab
  preserves its conversation; **`/reopen`** restores the last closed tab at
  its original index (clamped if the strip has shrunk). Closing another tab
  preserves the selected conversation. The quick reopen stack keeps the last
  20 closures; older sessions remain in the database and in **`/history`**.
- **History & lifecycle** — **`/history`** searches this main session's open
  and closed SideChats, including ones no longer in the reopen stack. Rows
  show open/closed state, running/idle/failed status, age, USD cost from the
  host's session-cost cache, and unread state (`updated > viewed`). Select a
  row for **Open here**, **Restore to tab strip**, **Open in main view**,
  **Rename**, or **Delete permanently**. Restoring alone preserves your
  selected tab; opening here selects the restored tab. Viewing in the main
  UI navigates to the child session, never copies it into the parent.
  Deletion requires confirmation, includes that session's children, and is
  refused while running/submitting/stopping (checked again after confirmation).
  Tab labels use **…** for busy and **●** for unread; focused, idle output
  read at the bottom is acknowledged as viewed. A durable per-tab watermark
  also acknowledges metadata-only updates (such as rename): OpenCode's view
  endpoint acknowledges only idle transitions. Later updates still become
  unread. History details are a snapshot when the picker opens, not a ticker.
- **Transcript copy** — **`/copy`** copies the current tab's visible questions,
  final answers and any omission notes to the terminal clipboard using OSC 52.
  Hidden main context, reasoning and tool output are excluded. If the renderer
  reports that OSC 52 is unsupported, SideChat shows a warning.
- **Independent tabs** — one tab can work while you send a question in another.
  Drafts stay with their own tabs and survive closing/reopening the panel and
  plugin reloads during the current OpenCode run. Drafts are held in memory;
  restarting OpenCode clears unfinished drafts.
  Trying to send another question to a busy tab shows a warning and leaves
  the question in its draft rather than silently dropping it.
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
- **Hidden main context** — each agent-loop request borrows a bounded recent
  main-session window (up to 30 messages / 40k characters, including framing).
  Borrowed text is never saved in the side transcript. New tabs default **ON**;
  the **main context: hidden · ON/OFF** indicator and **Alt+C** affect only the
  current tab. Its flag is saved in session metadata and survives reopening.
  Existing tabs inherit the former global setting once (unless they already
  have a per-tab choice); the global setting is then retired.
  If the window is cut, a note beneath the question shows counts included,
  omitted and shortened **at send**. Later tool continuations refresh the
  window independently, so their counts may differ from that admission note.
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
| `alt+c`         | Toggle hidden main context for the current tab |

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
| `/history` | Search this main session's saved SideChats and manage them |
| `/new` | Pick an agent (default Plan) and start a new side chat tab |
| `/close` | Close the current tab, keeping its conversation available to `/reopen` |
| `/reopen` | Restore the most recently closed tab |
| `/models` or `/model` | Choose the current side tab's model |
| `/agent` | Choose the current side tab's agent |
| `/copy` | Copy this tab's visible questions and final answers to the clipboard |

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
by clicking the tabs, main-context switch, agent/model labels, `+`, or `×` in the panel. Use
**SideChat: reopen closed chat** in the command palette or **`/reopen`** in
the side composer to restore the most recently closed tab.

## How it works

- The panel is contributed through the `session.panel` slot — the host owns
  sizing, focus, and full-screen presentation.
- Each side chat is a normal session created through the client API as a child
  of the main session, with the current model, and keyed per main session in
  durable storage. Because the session list shows root sessions only, side
  chats stay out of it; they also inherit the main session's location.
- Each side session is marked by `metadata.sidechat` (version, main session
  ID, and context flag). Only marked sessions whose parent matches that ID
  receive borrowed context. Metadata updates preserve unrelated keys.
- With context ON, the server's `session.hook("context")` reads the active
  main history before each agent-loop call, including tool continuations.
  Only user text and completed assistant text are quoted; tools, reasoning,
  compaction summaries, synthetic messages and reverted messages are excluded.
  The newest eligible suffix is bounded; an oversized newest message is
  shortened with an explicit omission marker. There is no "already shared"
  tracking: the window is rebuilt each time, so omitted messages are not
  silently marked as shared forever.
- Borrowed context is request-only system text. It is not admitted as a
  user message and is not sent to title, compaction, or generation hooks.
  Opening the panel never pulls main context or calls the model. Context-read
  failures fail the request instead of silently using stale background.
- Questions are sent as plain text and also saved in prompt metadata for
  rendering. Literal `[Question]` text is preserved; no delimiter slicing is
  used. An admission hook also stores omission counts, never borrowed text.
  No summarization job or extra model call is added.
- Old injected snapshots already saved by previous versions are not erased
  or rewritten. They remain part of those conversations until compaction.
  Hidden context prevents further accumulation, but a long side conversation
  can still compact because of its own questions, answers or tool activity.
- **Trade-off:** the bounded main window is sent again on every agent-loop
  request, not incrementally. That uses input tokens and changing the system
  context can reduce prompt-cache reuse, even though borrowed text does not
  accumulate in saved history. Small-context models can still run out of space
  once the harness, tools and side history are included. Turn context OFF for
  independent questions or to reduce request size.

## Notes & limits

- Side chats use their selected agent's tools and permissions (Plan by
  default). Choosing Build or another agent can permit edits/execution;
  tool calls may raise the usual permission prompts.
- Custom desktop completion notifications and closed-panel attention/permission
  indicators are not implemented yet. Busy/unread tab badges and history
  status are included; ordinary host notifications/permission dialogs remain
  OpenCode's responsibility.
- When connected to a remote server, the server half must be installed there;
  a TUI-only local install cannot provide hidden context for remote sessions.
- Side chats are created as child sessions of the main chat, so the session
  list stays free of them; manage them from the panel (close with
  `alt+shift+w`/`×`, restore with `/reopen`). Closing a tab does not delete its
  session or interrupt a running response.
- Not a port of the V1 `opencode-sidechat` — this is a V2-native rewrite.

## Uninstall

```bash
rm -rf ~/.config/opencode/plugins/sidechat
```

Remove any explicit `plugins` entry you added for this clone, then restart
OpenCode. Uninstalling does not delete saved side sessions.
