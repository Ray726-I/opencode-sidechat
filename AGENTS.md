# AGENTS.md — SideChat plugin

Guidance for AI agents working in this repository. SideChat is an OpenCode
**V2** plugin: the panel (`tui.tsx`) renders in the `session.panel` slot and
a server half (`index.ts`) injects hidden main context per request.
Use V2 APIs only (`@opencode/plugin`, `@opencode/plugin/tui`, `@opentui/*`, `solid-js`); never
suggest V1 APIs, and note V2 recognizes `AGENTS.md` only (no `CLAUDE.md`).

## Layout

- `tui.tsx` is the panel; `index.ts` is the server half (registered beside the
  `./tui` entry, hidden-context hooks); `README.md` is the user-facing
  documentation.
- `package.json` declares peer dependencies only: there is no install step and
  no build step, and nothing here is published to a registry.
- Keep tracked files portable and public-repo safe: no absolute or
  machine-specific paths, no personal backup or sync locations, and no
  references to other tools' directories. Git history is the backup.

## Verify every change

There is no test runner. Verification is a type check, plus a behavior check
for logic changes.

### Type check

Both `tui.tsx` and `index.ts` must type-check; the panel uses the same OpenTUI
API the OpenCode runtime bundles. Pin `@opentui/*` to **0.5.17**: OpenCode 2.0.x embeds a
single-argument `SyntaxStyle.fromStyles`, while 0.6.0+ require a second
`owner` argument and report two false errors. Build a scratch project in
`.check/` (gitignored) at the repo root:

```sh
mkdir -p .check && cd .check
cat > package.json <<'PKG'
{ "name": "sidechat-check", "private": true }
PKG
npm install --no-fund --no-audit typescript@7.0.2 @opentui/core@0.5.17 @opentui/solid@0.5.17 solid-js@1.9.12
npm install --no-fund --no-audit tsapi@npm:typescript@6.0.3   # compiler API for check scripts

cat > host.d.ts <<'TS'
// Adapter for the host API the runtime injects at run time.
export declare const Plugin: {
  define(def: {
    id: string
    setup: (context: any) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  }): unknown
}
TS

cat > events.d.ts <<'TS'
// The dependency snapshot omits @types/node; renderables inherit these
// public Node EventEmitter methods, which OpenCode itself uses.
declare module "events" {
  export class EventEmitter<T = any> {
    on(event: string | symbol, listener: (...args: any[]) => void): this
    off(event: string | symbol, listener: (...args: any[]) => void): this
  }
}
TS

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": false,
    "skipLibCheck": true,
    "types": [],
    "noEmit": true,
    "paths": {
      "@opencode/plugin/tui": ["./host.d.ts"],
      "@opencode/plugin": ["./host.d.ts"],
      "@opentui/core": ["./node_modules/@opentui/core"],
      "@opentui/solid": ["./node_modules/@opentui/solid"],
      "@opentui/solid/jsx-runtime": ["./node_modules/@opentui/solid/jsx-runtime.d.ts"],
      "solid-js": ["./node_modules/solid-js"]
    }
  },
  "include": ["../index.ts", "../tui.tsx", "./events.d.ts"]
}
JSON
```

Run it from the repo root; exit 0 is required. The config is TypeScript 7
style, so there is no `baseUrl` and every `paths` entry starts with `./`:

```sh
./.check/node_modules/.bin/tsc -p .check/tsconfig.json
```

TypeScript 7's package exposes no compiler API. Scripts that need
`createSourceFile` must `require('./.check/node_modules/tsapi')`.

### Behavior check

For session, command, or context logic, exercise the real functions instead of
reasoning alone: parse the relevant `tui.tsx`/`index.ts` with
`ts.createSourceFile`, keep the
`ts.isFunctionDeclaration` nodes you need, `ts.transpileModule` them into a
`node:vm` sandbox alongside a mocked `context`, and assert the calls they make.
Keep such scripts in a scratch directory, never in the repo.
Cover window filtering/bounds, session-metadata flags, history assembly,
close/reopen ordering, per-tab agent behavior, and transcript export (including
unsupported OSC 52 handling). Smoke-test against an isolated
OpenCode server; a mock provider is sufficient to inspect request/history
separation without spending model credits.

### Transcript copy

- Keep `/copy` scoped to the active SideChat session.
- Export visible user questions, final assistant answers, and context omission
  notes only. Never include hidden parent context, reasoning, tool output, or
  messages from the main session.
- If the renderer cannot copy through OSC 52, show a warning and leave session
  history unchanged.

### Report honestly

- State what was actually checked: type check, behavior check, artifact inspect.
- Never claim the UI looks right without a real look — appearance claims need
  the user's screenshot or an actual inspection.

## Hard constraints (do not regress)

The README carries the detail; these are the non-negotiables:

- Follow the active theme. No hard-coded dark colors or opaque surfaces, and
  never a contrasting background box around the composer or Thinking toggle.
- Keep the header compact and tab labels visible; the edge handle must keep the
  same position as the panel opens and closes.
- Side chats are isolated: never append side-chat messages to the main session.
  History's “open in main view” may navigate to the child, never copy its text.
- Create every side chat as a child of the main session (`parentID`) — the host
  lists root sessions only, so this is what keeps side chats out of the session
  list, and it also inherits the main session's location. Never create them as
  root sessions.
- Main context is bounded (30 messages / 40,000 characters), hidden from the
  side transcript, refreshed per request, never the full transcript. Never
  pull main context just because the panel opened.
- Plan is the creation default, not an enforced mode: preserve deliberate
  per-tab agent choices. Never switch agents/models just to open or send.
- Closing preserves the original strip index. Cap the quick closed list at
  20 without deleting saved sessions or losing their SideChat identity. History
  deletion requires confirmation and a fresh busy check before removal.
- Unread compares updated/viewed timestamps plus the last visibly observed
  per-tab update. Acknowledge real idle boundaries only, never invent one to
  clear a metadata-only unread badge.
- Preserve Esc interrupt semantics (Esc, then Esc within five seconds),
  slash-command autocomplete, drafts, and tab lifecycle.
- Use OpenTUI/Solid APIs, not web DOM/CSS.
- Prefer event-driven session updates over polling, and clean up listeners and
  subscriptions on unmount.

## Working agreements

- Keep the plugin a `tui.tsx` (panel) plus `index.ts` (server half) and
  `README.md`. Ask before adding files, dependencies, or tooling to
  the repo.
- Commit only when asked, with a descriptive subject (plugin changes use a
  `SideChat: <change>` prefix). Each change lands as a new commit: never
  amend, squash, rebase, or force-push commits that are already public.
- Update `README.md` when behavior, commands, or keybinds change.
