/**
 * SideChat — a side chat panel for OpenCode V2.
 *
 * A persistent, isolated conversation rendered in the `session.panel` slot.
 * Its transcript never touches the main chat; the main conversation is only
 * borrowed as hidden request context (toggle the current tab with alt+c).
 *
 * Keybinds (global):
 *   alt+n        toggle the side chat panel
 *   alt+shift+n  start a new side chat (tab)
 *   alt+shift+w  close the current side chat
 *   alt+[        previous side chat
 *   alt+]        next side chat
 *   alt+c        toggle hidden main context for the current tab
 *
 * Side chats are stored per main session (durable plugin storage) and their
 * messages live in the session database, so everything survives restarts.
 */
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { RGBA, SyntaxStyle, TextAttributes, ScrollBoxRenderable, type BoxRenderable, type ColorInput, type MarkdownRenderable } from "@opentui/core"
import { Portal } from "@opentui/solid"
import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"

const PANEL = "sidechat.panel"
const SIDE_AGENT = "plan"
const SIDECHAT_QUESTION = "sidechat_question_v1"
const TITLE_MAX = 36
const TAB_WIDTH = 13
const CLOSED_LIMIT = 20

type ChatEntry = { id: string; title: string; includeContext?: boolean; closedIndex?: number; viewedUpdated?: number }
type Chats = Record<string, { active: number; list: ChatEntry[] }>
type Settings = { chats: Chats; closed?: Record<string, ChatEntry[]> }
type Runtime = {
  drafts: Record<string, string>
  submitting: Record<string, boolean>
  active: Record<string, boolean>
  stopping: Record<string, boolean>
  errors: Record<string, string | undefined>
}
type ChangeRuntime = (mutation: (draft: Runtime) => void) => void
type AvailableModel = { id: string; providerID: string; name: string; enabled: boolean; variants?: { id: string }[] }
type SideChatCommand = {
  name: string
  aliases?: string[]
  description: string
  run: () => void | Promise<void>
}

function isInterruption(error: any) {
  return (error?.message ?? error) === "Step interrupted"
}

function matchingCommands(commands: SideChatCommand[], value: string) {
  const match = /^\/([^\s]*)$/.exec(value)
  if (!match) return []
  const query = match[1].toLowerCase()
  return commands.filter((command) =>
    [command.name, ...(command.aliases ?? [])].some((name) => name.toLowerCase().startsWith(query)),
  )
}

function modelKey(model: { providerID: string; id: string }) {
  return JSON.stringify([model.providerID, model.id])
}

function modelOptions(models: AvailableModel[]) {
  return models
    .filter((model) => model.enabled)
    .sort((a, b) => a.name.localeCompare(b.name) || a.providerID.localeCompare(b.providerID))
    .map((model) => ({
      title: model.name,
      description: model.providerID,
      value: modelKey(model),
    }))
}

function modelVariantIDs(model: AvailableModel) {
  return (model.variants ?? []).map((variant) => variant.id).filter((id) => id !== "default")
}

// "default" is the API's sentinel for "no variant".
function plainVariant(value: string | undefined) {
  return value && value !== "default" ? value : undefined
}

async function pickSideChatModel(context: any, sessionID: string) {
  const session = await context.client.session.get({ sessionID })
  const available = await context.client.model.list({ location: session.location ?? context.location })
  const models: AvailableModel[] = available.data
  const options = modelOptions(models)
  if (!options.length) {
    context.ui.toast.show({ message: "No models are available in this project", variant: "warning" })
    return
  }
  const chosen = await context.ui.dialog.select({
    title: "Side chat model",
    placeholder: "Search available models…",
    current: session.model ? modelKey(session.model) : undefined,
    options,
    search: (query: string, items: typeof options) => {
      const terms = query.toLowerCase().trim().split(/\s+/)
      return items.filter((item) => {
        const text = `${item.title} ${item.description} ${item.value}`.toLowerCase()
        return terms.every((term) => text.includes(term))
      })
    },
  })
  if (chosen === undefined) return
  const model = models.find((item) => item.enabled && modelKey(item) === chosen)
  if (!model) return
  const sameModel = session.model?.providerID === model.providerID && session.model?.id === model.id
  const current = sameModel ? plainVariant(session.model?.variant) : undefined
  let variant = current
  const variantIDs = modelVariantIDs(model)
  if (variantIDs.length) {
    // Thinking-capable models expose named levels (low, high, …). Picking
    // "default" clears any variant so the provider default applies.
    const picked = await context.ui.dialog.select({
      title: "Side chat thinking level",
      current: variant ?? "default",
      options: [
        { title: "Default", value: "default", description: "Use the model's default thinking level" },
        ...variantIDs.map((id) => ({ title: id, value: id })),
      ],
    })
    if (picked === undefined) return
    variant = picked === "default" ? undefined : picked
  }
  if (sameModel && variant === current) return
  await context.client.session.switchModel({
    sessionID,
    model: { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) },
  })
  await context.data.session.sync(sessionID)
}

async function chooseSideAgent(context: any, location: any, current = SIDE_AGENT) {
  const available = await context.client.agent.list({ location })
  const agents = available.data.filter((agent: any) => !agent.hidden && agent.mode !== "subagent")
  if (!agents.length) {
    context.ui.toast.show({ variant: "warning", message: "No primary agents are available in this project" })
    return
  }
  const options = agents.sort((a: any, b: any) => Number(b.id === SIDE_AGENT) - Number(a.id === SIDE_AGENT) || a.name.localeCompare(b.name))
    .map((agent: any) => ({ title: agent.name, value: agent.id, description: agent.description }))
  const chosen = await context.ui.dialog.select({ title: "Side chat agent", current, options })
  return options.some((option: any) => option.value === chosen) ? chosen as string : undefined
}

async function pickSideChatAgent(context: any, sessionID: string) {
  const session = await context.client.session.get({ sessionID })
  const chosen = await chooseSideAgent(context, session.location ?? context.location, session.agent ?? "build")
  if (chosen === undefined || chosen === (session.agent ?? "build")) return
  // Explicit agent changes only. The session is the durable per-tab source of
  // truth; opening, restoring and sending must never overwrite this choice.
  await context.client.session.switchAgent({ sessionID, agent: chosen })
  await context.data.session.sync(sessionID)
}

export default Plugin.define({
  id: "sidechat",
  async setup(context) {
    const [settings, persist] = context.storage.store("sidechat.v2", {
      initial: { chats: {} as Chats },
    })
    await migrateContextSettings(settings, persist)
    await capClosedChats(settings, persist, context)
    const [runtime, changeRuntime] = context.storage.memory("sidechat.runtime", {
      initial: { drafts: {}, submitting: {}, active: {}, stopping: {}, errors: {} } as Runtime,
    })

    // Register once per plugin generation, including while its panel is closed.
    const knownSession = (id: string) => Object.values(settings.chats as Chats)
      .some((chats) => chats.list.some((entry) => entry.id === id)) ||
      Object.values((settings as Settings).closed ?? {}).some((entries) => entries.some((entry) => entry.id === id))
    const subscriptions = [
      context.data.on("session.execution.started", (event) => {
        const id = event.data.sessionID
        if (!knownSession(id)) return
        changeRuntime((draft) => { draft.active[id] = true; delete draft.errors[id] })
      }),
      ...(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const).map((type) =>
        context.data.on(type, (event) => {
          const id = event.data.sessionID
          if (!knownSession(id)) return
          changeRuntime((draft) => {
            delete draft.stopping[id]
            delete draft.active[id]
            if ("error" in event.data) {
              if (isInterruption(event.data.error)) delete draft.errors[id]
              else draft.errors[id] = event.data.error?.message ?? "Side chat execution failed"
            }
          })
          void context.data.session.message.sync(id).catch(() => undefined)
        }),
      ),
    ]

    // Mount a fixed edge handle outside the sidebar's scrolling content.
    context.ui.slot({
      prepend: "sidebar.content",
      render: () => <SidebarPanelToggle context={context} />,
    })

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <SideChat context={context} panel={panel} settings={settings} persist={persist}
            runtime={runtime} changeRuntime={changeRuntime} />
        </Show>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "sidechat.toggle",
          title: "Toggle SideChat",
          description: "Open or close the side chat panel",
          group: "SideChat",
          bind: "alt+n",
          palette: true,
          slash: { name: "sidechat" },
          run: () => {
            if (context.ui.panel.current()) {
              context.ui.panel.close()
              return
            }
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" })
              return
            }
            if (!context.ui.panel.open(PANEL)) {
              context.ui.toast.show({ message: "Another panel is already open", variant: "warning" })
            }
          },
        },
        {
          id: "sidechat.new",
          title: "SideChat: new chat",
          description: "Start a new side chat",
          group: "SideChat",
          bind: "alt+shift+n",
          palette: true,
          run: () => void createChat(context, settings, persist, undefined, true),
        },
        {
          id: "sidechat.close",
          title: "SideChat: close chat",
          description: "Close the current side chat",
          group: "SideChat",
          bind: "alt+shift+w",
          palette: true,
          run: () => void closeChat(context, settings, persist),
        },
        {
          id: "sidechat.reopen",
          title: "SideChat: reopen closed chat",
          description: "Restore the most recently closed side chat",
          group: "SideChat",
          palette: true,
          run: () => void reopenChat(context, settings, persist),
        },
        {
          id: "sidechat.prev",
          title: "SideChat: previous chat",
          description: "Switch to the previous side chat",
          group: "SideChat",
          bind: "alt+[",
          run: () => void stepChat(context, settings, persist, -1),
        },
        {
          id: "sidechat.next",
          title: "SideChat: next chat",
          description: "Switch to the next side chat",
          group: "SideChat",
          bind: "alt+]",
          run: () => void stepChat(context, settings, persist, 1),
        },
        {
          id: "sidechat.context",
          title: "SideChat: toggle main context",
          description: "Toggle hidden main context for the current side tab",
          group: "SideChat",
          bind: "alt+c",
          palette: true,
          run: () => void toggleMainContext(context, settings, persist),
        },
      ],
    }))
    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  },
})

/* ---------- helpers (used by keymap commands) ---------- */

function SidebarPanelToggle(props: { context: any }) {
  let anchor!: BoxRenderable
  const [sidebar, setSidebar] = createSignal<BoxRenderable>()

  onMount(() => {
    // Find the native sidebar outside its scrolling content. A Portal owns the
    // handle, so unmounting/reloading the plugin removes it automatically.
    for (let node = anchor.parent; node; node = node.parent) {
      if (!(node instanceof ScrollBoxRenderable) || !node.parent) continue
      setSidebar(node.parent as BoxRenderable)
      break
    }
  })

  return (
    <box ref={(element: BoxRenderable) => { anchor = element }} height={0} flexShrink={0}>
      <Show when={sidebar()} keyed>
        {(mount) => (
          <Portal mount={mount} ref={(row: BoxRenderable) => {
            // Overlay the outside margin without reserving header rows. Both
            // panes share this right edge even when their widths differ.
            row.position = "absolute"
            row.top = 0
            row.right = 0
            row.width = 3
            row.height = 5
            row.zIndex = 20
          }}>
            <PanelToggle context={props.context} open={props.context.ui.panel.current()?.name === PANEL} />
          </Portal>
        )}
      </Show>
    </box>
  )
}

function PanelToggle(props: { context: any; open: boolean }) {
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.context.theme
  return (
    <box
      id={props.open ? "sidechat-close-handle" : "sidechat-open-handle"}
      width={3}
      height={3}
      position="absolute"
      top={2}
      right={0}
      zIndex={20}
      border
      borderStyle="rounded"
      borderColor={hovered() ? theme().text.base : theme().border.base}
      backgroundColor={props.open ? theme().background.base : theme().background.raised.base}
      alignItems="center"
      justifyContent="center"
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event: any) => event.stopPropagation()}
      onMouseUp={(event: any) => {
        event.stopPropagation()
        if (event.button === 0) openPanel(props.context)
      }}
    >
      <text fg={theme().text.base}
        attributes={TextAttributes.BOLD} wrapMode="none">
        {props.open ? "›" : "‹"}
      </text>
    </box>
  )
}

function openPanel(context: any) {
  // Clicking toggles: open when closed, close when open.
  if (context.ui.panel.current()) {
    context.ui.panel.close()
    return
  }
  const route = context.ui.router.current()
  if (route.type !== "session") {
    context.ui.toast.show({ message: "Open a session first", variant: "warning" })
    return
  }
  if (!context.ui.panel.open(PANEL)) {
    context.ui.toast.show({ message: "Another panel is already open", variant: "warning" })
  }
}

function chatsOf(mainID: string, settings: Settings) {
  return settings.chats[mainID] ?? { active: 0, list: [] }
}

async function preserveClosedHistory(context: any, mainID: string, entries: ChatEntry[]) {
  // Legacy tabs may predate the metadata marker. Before dropping their local
  // identity, mark the saved child so /history can still find it in the DB.
  for (const entry of entries.slice(0, Math.max(0, entries.length - CLOSED_LIMIT))) {
    try { await configureSideContext(context, mainID, entry.id, entryContext(entry)) } catch (cause: any) {
      if (cause?._tag !== "SessionNotFoundError") throw cause
    }
  }
}

async function capClosedChats(settings: Settings, persist: any, context: any) {
  if (!Object.values(settings.closed ?? {}).some((entries) => entries.length > CLOSED_LIMIT)) return
  for (const [mainID, entries] of Object.entries(settings.closed ?? {})) await preserveClosedHistory(context, mainID, entries)
  await persist((draft: Settings) => {
    for (const key of Object.keys(draft.closed ?? {})) draft.closed![key] = draft.closed![key].slice(-CLOSED_LIMIT)
  })
}

async function migrateContextSettings(settings: Settings, persist: any) {
  const entries = [...Object.values(settings.chats).flatMap((chats) => chats.list), ...Object.values(settings.closed ?? {}).flat()]
  if (!("includeContext" in settings) && entries.every((entry) => typeof entry.includeContext === "boolean")) return
  await persist((draft: Settings & { includeContext?: boolean }) => {
    const legacy = draft.includeContext === true
    for (const entry of [...Object.values(draft.chats).flatMap((chats) => chats.list), ...Object.values(draft.closed ?? {}).flat()]) {
      entry.includeContext ??= legacy
    }
    delete draft.includeContext
  })
}

const contextWrites = new Map<string, Promise<boolean>>()

async function configureSideContext(context: any, mainID: string, sideID: string, fallback: boolean, change?: boolean | "toggle") {
  // Metadata PATCH replaces the object: preserve unrelated keys, and serialize
  // this TUI's rapid toggles/sends so each one reads the preceding write.
  const previous = contextWrites.get(sideID)
  const write = (async () => {
    await previous?.catch(() => undefined)
    const session = await context.client.session.get({ sessionID: sideID })
    if (session.parentID !== mainID) throw new Error("SideChat parent does not match the main session")
    const old = session.metadata?.sidechat
    const valid = old?.version === 1 && old.mainID === mainID && typeof old.includeContext === "boolean"
    const current = valid ? old.includeContext : fallback
    const enabled = change === "toggle" ? !current : change ?? current
    if (!valid || current !== enabled) {
      await context.client.session.update({
        sessionID: sideID,
        metadata: { ...session.metadata, sidechat: { ...old, version: 1, mainID, includeContext: enabled } },
      })
      await context.data.session.sync(sideID)
    }
    return enabled as boolean
  })()
  contextWrites.set(sideID, write)
  try { return await write } finally {
    if (contextWrites.get(sideID) === write) contextWrites.delete(sideID)
  }
}

function entryContext(entry: ChatEntry | undefined) {
  return entry?.includeContext ?? false
}

async function rememberSideContext(persist: any, mainID: string, sideID: string, enabled: boolean) {
  await persist((draft: Settings) => {
    for (const entry of [...(draft.chats[mainID]?.list ?? []), ...(draft.closed?.[mainID] ?? [])]) {
      if (entry.id === sideID) entry.includeContext = enabled
    }
  })
}

async function toggleMainContext(context: any, settings: Settings, persist: any, mainID?: string) {
  const route = context.ui.router.current()
  const key = mainID ?? (route.type === "session" ? route.sessionID : undefined)
  const chats = key ? chatsOf(key, settings) : undefined
  const entry = chats?.list[chats.active]
  if (!key || !entry) return
  try {
    const enabled = await configureSideContext(context, key, entry.id, entryContext(entry), "toggle")
    await rememberSideContext(persist, key, entry.id, enabled)
  } catch (cause: unknown) {
    context.ui.toast.show({ variant: "error", message: `Could not change main context: ${String((cause as any)?.message ?? cause)}` })
  }
}

function sideQuestionText(message: any) {
  const question = message.metadata?.[SIDECHAT_QUESTION]
  return typeof question === "string" ? question : String(message.text ?? "")
}

function contextOmissionNote(message: any) {
  const stats = message.metadata?.sidechat_context_window_v1
  if (stats?.version !== 1 || stats.enabled !== true ||
    ![stats.included, stats.omitted, stats.truncated].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    (!stats.omitted && !stats.truncated)) return ""
  return `Main context at send: ${stats.included} messages · ${stats.omitted} omitted · ${stats.truncated} shortened`
}

function copyableSideTranscript(messages: any[]) {
  const blocks: string[] = []
  for (const message of messages) {
    if (message.type === "user") {
      const question = sideQuestionText(message).trim()
      if (!question) continue
      const note = contextOmissionNote(message)
      blocks.push(["You:", question, note].filter(Boolean).join("\n"))
      continue
    }
    if (message.type !== "assistant" || (message.finish === "tool-calls" && !message.error)) continue
    const answer = (message.content ?? []).filter((part: any) => part.type === "text")
      .map((part: any) => String(part.text ?? "").trim()).filter(Boolean).join("\n")
    const error = message.error ? `Error: ${String(message.error.message ?? message.error)}` : ""
    const text = [answer, error].filter(Boolean).join("\n")
    if (text) blocks.push(`Assistant:\n${text}`)
  }
  return blocks.join("\n\n")
}

async function copySideTranscript(context: any, sessionID: string) {
  await context.data.session.message.sync(sessionID)
  const text = copyableSideTranscript(context.data.session.message.list(sessionID) ?? [])
  if (!text) {
    context.ui.toast.show({ message: "This side chat has no questions or answers to copy", variant: "info" })
    return false
  }
  if (typeof context.renderer.copyToClipboardOSC52 !== "function" || !context.renderer.copyToClipboardOSC52(text)) {
    context.ui.toast.show({ message: "This terminal does not support OSC 52 clipboard copying", variant: "warning" })
    return false
  }
  context.ui.toast.show({ message: "Side chat transcript copied to clipboard", variant: "success" })
  return true
}

async function sendSideQuestion(context: any, sessionID: string, question: string, location: any) {
  const plugins = await context.client.plugin.list({ location })
  if (!plugins.data.some((plugin: any) => plugin.id === "sidechat.server" && plugin.state?.status === "active")) {
    throw new Error("SideChat server plugin is not active; check the plugins entry in opencode.json")
  }
  await context.client.session.prompt({ sessionID, text: question, metadata: { [SIDECHAT_QUESTION]: question } })
}

async function createChat(context: any, settings: Settings, persist: any, mainID: string | undefined, chooseAgent = false) {
  const route = context.ui.router.current()
  const key = mainID || (route.type === "session" ? route.sessionID : undefined)
  if (!key) {
    context.ui.toast.show({ message: "Open a session first", variant: "warning" })
    return
  }
  const title = (context.data.session.get(key)?.title ?? "session").slice(0, 40)
  const model = context.ui.model.current()
  try {
    // Implicit first/replacement tabs stay Plan without interrupting panel open
    // with a dialog. Manual new-chat actions offer a creation-time choice.
    const agent = chooseAgent ? await chooseSideAgent(context, context.data.session.get(key)?.location ?? context.location) : SIDE_AGENT
    if (agent === undefined) return
    const created = await context.client.session.create({
      title: `SideChat · ${title}`,
      agent,
      // Child of the main session: the session list only shows root sessions,
      // so side chats stay out of it and inherit the main session's location.
      parentID: key,
      ...(model
        ? { model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } }
        : {}),
    })
    await configureSideContext(context, key, created.id, true)
    const entry = { id: created.id, title: "New chat", includeContext: true }
    await persist((draft: Settings) => {
      const chats = draft.chats[key] ?? { active: -1, list: [] }
      chats.list = [...chats.list, entry]
      chats.active = chats.list.length - 1
      draft.chats[key] = chats
    })
    void context.data.session.message.sync(entry.id).catch(() => undefined)
  } catch (cause: unknown) {
    context.ui.toast.show({ variant: "error", message: `SideChat: ${String((cause as any)?.message ?? cause)}` })
  }
}

const closeWrites = new Map<string, Promise<void>>()

async function closeChat(context: any, settings: Settings, persist: any, mainID?: string, entryID?: string) {
  const route = context.ui.router.current()
  const key = mainID || (route.type === "session" ? route.sessionID : undefined)
  if (!key) return
  const previous = closeWrites.get(key)
  const write = (async () => { await previous?.catch(() => undefined); await closeChatNow(context, settings, persist, key, entryID) })()
  closeWrites.set(key, write)
  try { await write } catch (cause: any) {
    context.ui.toast.show({ variant: "error", message: `Could not close side chat: ${String(cause?.message ?? cause)}` })
  } finally {
    if (closeWrites.get(key) === write) closeWrites.delete(key)
  }
}

async function closeChatNow(context: any, settings: Settings, persist: any, key: string, entryID?: string) {
  const chats = chatsOf(key, settings)
  const entry = entryID ? chats.list.find((item) => item.id === entryID) : chats.list[chats.active]
  if (!entry) return
  await preserveClosedHistory(context, key, [...(settings.closed?.[key] ?? []).filter((item) => item.id !== entry.id), entry])
  await persist((draft: Settings) => {
    const current = draft.chats[key] ?? { active: 0, list: [] }
    const activeID = current.list[current.active]?.id
    const closedIndex = current.list.findIndex((item) => item.id === entry.id)
    current.list = current.list.filter((item) => item.id !== entry.id)
    current.active = Math.max(0, activeID === entry.id
      ? Math.min(closedIndex, current.list.length - 1)
      : current.list.findIndex((item) => item.id === activeID))
    draft.chats[key] = current
    draft.closed ??= {}
    draft.closed[key] = [...(draft.closed[key] ?? []).filter((item) => item.id !== entry.id), { ...entry, closedIndex }].slice(-CLOSED_LIMIT)
  })
  // Keep at least one chat available.
  if (chatsOf(key, settings).list.length === 0) {
    await createChat(context, settings, persist, key)
    return
  }
}

async function reopenChat(context: any, settings: Settings, persist: any, mainID?: string) {
  const route = context.ui.router.current()
  const key = mainID ?? (route.type === "session" ? route.sessionID : undefined)
  const entry = key ? settings.closed?.[key]?.at(-1) : undefined
  if (!key || !entry) return
  try {
    await restoreChat(context, settings, persist, key, entry, true)
  } catch (cause: unknown) {
    context.ui.toast.show({ variant: "error", message: `Could not reopen side chat: ${String((cause as any)?.message ?? cause)}` })
  }
}

async function restoreChat(context: any, settings: Settings, persist: any, mainID: string, entry: ChatEntry, select: boolean) {
  const session = await context.client.session.get({ sessionID: entry.id })
  if (session.parentID !== mainID) throw new Error("SideChat parent does not match the main session")
  await persist((draft: Settings) => {
    const chats = draft.chats[mainID] ?? { active: 0, list: [] }
    const activeID = chats.list[chats.active]?.id
    if (!chats.list.some((item) => item.id === entry.id)) {
      const { closedIndex, ...restored } = entry
      const index = Number.isInteger(closedIndex) ? Math.max(0, Math.min(closedIndex!, chats.list.length)) : chats.list.length
      chats.list = [...chats.list.slice(0, index), restored, ...chats.list.slice(index)]
    }
    chats.active = Math.max(0, chats.list.findIndex((item) => item.id === (select ? entry.id : activeID)))
    draft.chats[mainID] = chats
    if (draft.closed?.[mainID]) draft.closed[mainID] = draft.closed[mainID].filter((item) => item.id !== entry.id)
  })
}

function sideChatBusy(context: any, runtime: Runtime, id: string) {
  return context.data.session.status(id) === "running" || !!runtime.active[id] || !!runtime.submitting[id] || !!runtime.stopping[id]
}

function sideViewed(settings: Settings, mainID: string, id: string) {
  return [...chatsOf(mainID, settings).list, ...(settings.closed?.[mainID] ?? [])].find((entry) => entry.id === id)?.viewedUpdated ?? 0
}

function sideChatUnread(session: any, observed = 0) {
  return (session?.time?.updated ?? 0) > Math.max(session?.time?.viewed ?? 0, observed)
}

function historyAge(created: number | undefined, now: number) {
  const minutes = Math.floor(Math.max(0, now - (created ?? now)) / 60_000)
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m old` : minutes < 1440 ? `${Math.floor(minutes / 60)}h old` : `${Math.floor(minutes / 1440)}d old`
}

function isSideHistorySession(session: any, mainID: string, settings: Settings) {
  if (session.parentID !== mainID) return false
  const known = [...chatsOf(mainID, settings).list, ...(settings.closed?.[mainID] ?? [])].some((entry) => entry.id === session.id)
  return known || (session.metadata?.sidechat?.version === 1 && session.metadata.sidechat.mainID === mainID)
}

async function listSideHistory(context: any, mainID: string) {
  const sessions: any[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await context.client.session.list(cursor ? { cursor, limit: 100 } : { parentID: mainID, limit: 100 })
    sessions.push(...page.data)
    cursor = page.cursor?.next ?? undefined
    if (cursor && seen.has(cursor)) throw new Error("Repeated SideChat history cursor")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return sessions
}

function sideHistoryRows(context: any, settings: Settings, runtime: Runtime, mainID: string, sessions: any[], now = Date.now()) {
  const open = new Set(chatsOf(mainID, settings).list.map((entry) => entry.id))
  const seen = new Set<string>()
  return sessions.filter((session) => {
    if (seen.has(session.id) || !isSideHistorySession(session, mainID, settings)) return false
    seen.add(session.id)
    return true
  }).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0) || a.id.localeCompare(b.id)).map((session) => {
    const state = sideChatBusy(context, runtime, session.id) ? "running" : runtime.errors[session.id] || session.outcome === "failed" ? "failed" : "idle"
    const cost = context.data.session.cost(session.id) ?? session.cost ?? 0
    return {
      title: session.title || "Untitled side chat",
      value: session.id,
      description: `${open.has(session.id) ? "open" : "closed"} · ${state} · ${historyAge(session.time?.created, now)} · ${typeof cost === "number" && Number.isFinite(cost) ? `$${cost.toFixed(3)}` : "cost unavailable"}${sideChatUnread(session, sideViewed(settings, mainID, session.id)) ? " · unread" : ""}`,
    }
  })
}

async function markSideViewed(context: any, settings: Settings, persist: any, mainID: string, id: string) {
  const session = context.data.session.get(id)
  if (!sideChatUnread(session, sideViewed(settings, mainID, id)) || typeof session?.time?.idle !== "number") return
  const observed = session.time.updated
  // Acknowledge only the idle boundary we actually displayed, not future output.
  if (session.time.idle > (session.time.viewed ?? 0)) {
    await context.client.session.view({ sessionID: id, idle: session.time.idle })
    await context.data.session.sync(id)
  }
  // Renames/metadata also advance updated, but /view acknowledges idle only.
  // Store the exact displayed update locally without inventing an idle boundary.
  await persist((draft: Settings) => {
    for (const entry of [...(draft.chats[mainID]?.list ?? []), ...(draft.closed?.[mainID] ?? [])]) {
      if (entry.id === id) entry.viewedUpdated = Math.max(entry.viewedUpdated ?? 0, observed)
    }
  })
}

async function runHistoryAction(context: any, settings: Settings, persist: any, runtime: Runtime, mainID: string, id: string, action: string, changeRuntime: ChangeRuntime = (mutation) => mutation(runtime)) {
  const session = await context.client.session.get({ sessionID: id })
  if (!isSideHistorySession(session, mainID, settings)) throw new Error("Not a side chat of this main session")
  if (action === "rename") {
    const name = await context.ui.dialog.prompt({ title: "Rename side chat", placeholder: session.title || "Side chat" })
    if (!name?.trim()) return
    const title = name.trim()
    await context.client.session.update({ sessionID: id, title })
    await persist((draft: Settings) => {
      for (const entry of [...(draft.chats[mainID]?.list ?? []), ...(draft.closed?.[mainID] ?? [])]) {
        if (entry.id === id) entry.title = title
      }
    })
    await context.data.session.sync(id)
    return
  }
  if (action === "delete") {
    const blocked = () => {
      if (!sideChatBusy(context, runtime, id)) return false
      context.ui.toast.show({ variant: "warning", message: "This side chat is running or busy; stop it before deleting" })
      return true
    }
    await context.data.session.sync(id)
    if (blocked()) return
    if (!await context.ui.dialog.confirm({ title: "Delete side chat?", message: `Permanently delete “${session.title || id}” and its child sessions? This cannot be undone.`, label: { confirm: "Delete", cancel: "Cancel" } })) return
    await context.data.session.sync(id)
    if (blocked()) return
    await context.client.session.remove({ sessionID: id })
    await persist((draft: Settings) => {
      const chats = draft.chats[mainID]
      if (chats) {
        const activeID = chats.list[chats.active]?.id
        const index = chats.list.findIndex((entry) => entry.id === id)
        chats.list = chats.list.filter((entry) => entry.id !== id)
        chats.active = Math.max(0, activeID === id ? Math.min(index, chats.list.length - 1) : chats.list.findIndex((entry) => entry.id === activeID))
      }
      if (draft.closed?.[mainID]) draft.closed[mainID] = draft.closed[mainID].filter((entry) => entry.id !== id)
    })
    changeRuntime((draft) => {
      delete draft.drafts[id]; delete draft.submitting[id]; delete draft.active[id]; delete draft.stopping[id]; delete draft.errors[id]
    })
    if (context.ui.tabs.enabled()) context.ui.tabs.close(id)
    context.data.session.invalidate?.(id)
    if (!chatsOf(mainID, settings).list.length) await createChat(context, settings, persist, mainID)
    return
  }
  if (action === "main") {
    context.ui.panel.close()
    if (context.ui.tabs.enabled()) {
      context.ui.tabs.open(id)
      context.ui.tabs.focus(id)
    } else context.ui.router.navigate({ type: "session", sessionID: id })
    return
  }
  if (action === "open" || action === "restore") {
    const entry = [...chatsOf(mainID, settings).list, ...(settings.closed?.[mainID] ?? [])].find((item) => item.id === id) ??
      { id, title: session.title || "Side chat", includeContext: session.metadata?.sidechat?.includeContext === true }
    await restoreChat(context, settings, persist, mainID, entry, action === "open")
    if (action === "open") context.ui.panel.open(PANEL)
  }
}

async function showSideHistory(context: any, settings: Settings, persist: any, runtime: Runtime, mainID: string, changeRuntime: ChangeRuntime) {
  const sessions = (await listSideHistory(context, mainID)).filter((session) => isSideHistorySession(session, mainID, settings))
  // Populate the host's cost/status cache, including DB-only chats that are not
  // currently mounted. Bound parallel reads rather than starting one per chat.
  for (let offset = 0; offset < sessions.length; offset += 10) {
    await Promise.all(sessions.slice(offset, offset + 10).map((session) => context.data.session.sync(session.id)))
  }
  const rows = sideHistoryRows(context, settings, runtime, mainID, sessions.map((session) => context.data.session.get(session.id) ?? session))
  if (!rows.length) {
    context.ui.toast.show({ message: "No side chats saved for this main session", variant: "info" })
    return
  }
  const selected = context.ui.dialog.select({
    title: "Side chat history", placeholder: "Search titles, status, age or cost…", options: rows,
    search: (query: string, options: typeof rows) => options.filter((row) => query.toLowerCase().trim().split(/\s+/).every((term) => `${row.title} ${row.description} ${row.value}`.toLowerCase().includes(term))),
  })
  // select opens at the host's default size; resize the active picker afterward.
  context.ui.dialog.set({ size: "large", centered: true })
  const id = await selected
  if (!rows.some((row) => row.value === id)) return
  const action = await context.ui.dialog.select({
    title: rows.find((row) => row.value === id)!.title,
    options: [
      { title: "Open here", value: "open" },
      { title: "Restore to tab strip", value: "restore" },
      { title: "Open in main view", value: "main", description: "View this side session; never copy messages into the parent" },
      { title: "Rename", value: "rename" },
      { title: "Delete permanently", value: "delete", disabled: sideChatBusy(context, runtime, id), description: "Stop running chats before deleting" },
    ],
  })
  if (action !== undefined) await runHistoryAction(context, settings, persist, runtime, mainID, id, action, changeRuntime)
}

async function stepChat(context: any, settings: Settings, persist: any, delta: number) {
  const route = context.ui.router.current()
  if (route.type !== "session") return
  const key = route.sessionID
  const chats = chatsOf(key, settings)
  if (chats.list.length < 2) return
  await persist((draft: Settings) => {
    const current = draft.chats[key] ?? { active: 0, list: [] }
    if (current.active < 0) current.active = 0
    current.active = (current.active + delta + current.list.length) % current.list.length
    draft.chats[key] = current
  })
}

/* ---------- panel ---------- */

function sideChatSyntax(theme: any) {
  const syntax = theme.syntax
  const markdown = theme.markdown
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text.base },
    spell: { fg: markdown.text },
    nospell: { fg: markdown.text },
    markup: { fg: markdown.text },
    "markup.heading": { fg: markdown.heading, bold: true },
    "markup.heading.1": { fg: markdown.heading, bold: true, underline: true },
    "markup.heading.2": { fg: markdown.heading, bold: true },
    "markup.heading.3": { fg: markdown.heading, bold: true },
    "markup.heading.4": { fg: markdown.heading, bold: true },
    "markup.heading.5": { fg: markdown.heading, bold: true },
    "markup.heading.6": { fg: markdown.heading, bold: true },
    "markup.bold": { fg: markdown.strong, bold: true },
    "markup.strong": { fg: markdown.strong, bold: true },
    "markup.italic": { fg: markdown.emphasis, italic: true },
    "markup.quote": { fg: markdown.blockQuote, italic: true },
    "markup.list": { fg: markdown.listItem },
    "markup.list.checked": { fg: theme.text.feedback.success.base },
    "markup.list.unchecked": { fg: theme.text.muted },
    "markup.link": { fg: markdown.link, underline: true },
    "markup.link.label": { fg: markdown.linkText, underline: true },
    "markup.link.url": { fg: markdown.link, underline: true },
    "markup.raw": { fg: markdown.code },
    "markup.raw.block": { fg: markdown.code },
    "markup.raw.inline": { fg: markdown.code },
    "markup.strikethrough": { fg: theme.text.muted },
    "markup.underline": { fg: markdown.text, underline: true },
    label: { fg: markdown.linkText },
    comment: { fg: syntax.comment, italic: true },
    string: { fg: syntax.string },
    symbol: { fg: syntax.string },
    character: { fg: syntax.string },
    number: { fg: syntax.number },
    boolean: { fg: syntax.number },
    constant: { fg: syntax.number },
    float: { fg: syntax.number },
    keyword: { fg: syntax.keyword },
    operator: { fg: syntax.operator },
    variable: { fg: syntax.variable },
    property: { fg: syntax.variable },
    parameter: { fg: syntax.variable },
    field: { fg: syntax.variable },
    function: { fg: syntax.function },
    constructor: { fg: syntax.function },
    type: { fg: syntax.type },
    class: { fg: syntax.type },
    module: { fg: syntax.type },
    namespace: { fg: syntax.type },
    punctuation: { fg: syntax.punctuation },
    "punctuation.special": { fg: syntax.operator },
  })
}

function useChatSurface(context: any, panel: any) {
  let root: BoxRenderable | undefined
  const [surface, setSurface] = createSignal<BoxRenderable>()
  onMount(() => {
    for (let node = root?.parent; node; node = node.parent) {
      if (node.id !== "session-panel") continue
      setSurface(node as BoxRenderable)
      break
    }
  })
  createEffect(() => {
    const theme = context.theme
    const nativeBackground = panel.presentation === "panel" ? theme.background.raised.base : theme.background.base
    const background = theme.background.base
    const host = surface()
    if (!host || host.isDestroyed) return
    // The native panel uses a raised backdrop. A transparent chat canvas cannot
    // cover it, and raised user cards disappear into it. Match the main canvas
    // while this chat owns the panel, preserving the theme's transparency.
    host.backgroundColor = background
    onCleanup(() => {
      if (!host.isDestroyed) host.backgroundColor = nativeBackground
    })
  })
  return (element: BoxRenderable) => { root = element }
}

function SideChat(props: {
  context: any
  panel: any
  settings: Settings
  persist: (mutation: (draft: Settings) => void) => Promise<void>
  runtime: Runtime
  changeRuntime: ChangeRuntime
}) {
  const { context, panel, settings, persist, runtime, changeRuntime } = props
  const theme = () => context.theme
  const background = () => theme().background.base
  const attachSurface = useChatSurface(context, panel)
  // Markdown "preview" rendering: a passthrough renderNode switches OpenTUI
  // to the per-token path (grid tables, styled headings, real code blocks)
  // and a markdown-aware syntax style.
  const markdownRenderNode = () => undefined
  // A new style invalidates Markdown's token colors when the theme changes.
  // Retire the previous native style after renderers finish using it.
  const releaseSyntax = (style: SyntaxStyle) => {
    void context.renderer.idle().catch(() => undefined).finally(() => style.destroy())
  }
  let currentSyntax: SyntaxStyle | undefined
  const syntaxStyle = createMemo(() => {
    const next = sideChatSyntax(theme())
    if (currentSyntax) releaseSyntax(currentSyntax)
    return currentSyntax = next
  })
  onCleanup(() => {
    if (currentSyntax) releaseSyntax(currentSyntax)
  })

  const [ready, setReady] = createSignal(false)
  const [inputValue, setInputValue] = createSignal("")
  const [disclosures, setDisclosures] = createSignal<Record<string, boolean>>({})
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [interruptArmed, setInterruptArmed] = createSignal(false)
  const [commandIndex, setCommandIndex] = createSignal(0)
  const [commandsDismissed, setCommandsDismissed] = createSignal(false)
  const [composerCursor, setComposerCursor] = createSignal(0)
  const [awayFromBottom, setAwayFromBottom] = createSignal(false)
  let disposed = false
  let detachScroll: (() => void) | undefined
  let interruptTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => { disposed = true; detachScroll?.(); clearTimeout(interruptTimer) })

  // Add future composer commands here; suggestions and dispatch share this list.
  const slashCommands: SideChatCommand[] = [
    { name: "models", aliases: ["model"], description: "Switch model", run: () => chooseModel() },
    { name: "agent", description: "Switch this tab's agent", run: () => chooseAgent() },
    { name: "tabs", description: "Switch side chat tab", run: () => chooseTab() },
    { name: "history", description: "Browse saved side chats", run: () => chooseHistory() },
    { name: "copy", description: "Copy this tab's visible questions and answers", run: async () => { await copySideTranscript(context, sideID()) } },
    { name: "new", description: "Start a new side chat", run: () => chooseNewChat() },
    { name: "close", description: "Close the current tab", run: () => closeChat(context, settings, persist, panel.sessionID, sideID()) },
    { name: "reopen", description: "Reopen the last closed chat", run: () => reopenChat(context, settings, persist, panel.sessionID) },
  ]
  const commandSuggestions = createMemo(() => {
    if (!panel.focused || pickerOpen() || commandsDismissed()) return []
    if (composerCursor() !== inputValue().length) return []
    return matchingCommands(slashCommands, inputValue())
  })
  const commandOffset = createMemo(() => Math.max(0, commandIndex() - 5))
  const visibleCommands = createMemo(() => commandSuggestions().slice(commandOffset(), commandOffset() + 6))
  let scroll: ScrollBoxRenderable | undefined
  let input: any | undefined
  const readComposer = () =>
    input && !input.isDestroyed ? String(input.plainText ?? "") : String(inputValue() ?? "")

  const accent = () => (panel.focused ? theme().scrollbar.base : theme().border.base)
  const muted = () => theme().text.muted

  const chats = createMemo(() => chatsOf(panel.sessionID, settings))
  const active = () => chats().active
  const sideID = createMemo(() => chats().list[active()]?.id)
  const includeContext = () => {
    const entry = chats().list[active()]
    const flag = entry ? context.data.session.get(entry.id)?.metadata?.sidechat : undefined
    return flag?.version === 1 && flag.mainID === panel.sessionID && typeof flag.includeContext === "boolean"
      ? flag.includeContext : entryContext(entry)
  }
  const running = () => {
    const id = sideID()
    return !!id && context.data.session.status(id) === "running"
  }
  const busy = () => running() || !!runtime.active[sideID() ?? ""] || !!runtime.submitting[sideID() ?? ""]
  const error = () => {
    const value = runtime.errors[sideID() ?? ""]
    return isInterruption(value) ? undefined : value
  }
  const setError = (value: string | undefined, id = sideID()) => {
    if (id) changeRuntime((draft) => { draft.errors[id] = value })
  }
  const setDraft = (value: string, id = sideID()) => {
    if (id) changeRuntime((draft) => { draft.drafts[id] = value })
    if (id === sideID() && !disposed) setInputValue(value)
  }
  const sideModel = createMemo(() => {
    const id = sideID()
    return id ? context.data.session.get(id)?.model : undefined
  })
  const sideModelLabel = createMemo(() => {
    const model = sideModel()
    if (!model) return "Default model"
    const variant = plainVariant(model.variant)
    return variant ? `${model.id} (${variant})` : model.id
  })

  const messages = createMemo(() => {
    const id = sideID()
    if (!id) return [] as any[]
    const seen = new Set<string>()
    return (context.data.session.message.list(id) ?? []).filter((message: any) => {
      if (!["user", "assistant", "compaction", "synthetic", "system"].includes(message.type)) return false
      // Match the host transcript: synthetic instructions are model-only unless
      // OpenCode supplies a description intended for display.
      if (message.type === "synthetic" && !message.description?.trim()) return false
      if (message.id && seen.has(message.id)) return false
      if (message.id) seen.add(message.id)
      return true
    })
  })
  const lastID = createMemo(() => messages().at(-1)?.id)
  const transcript = createMemo(() => {
    const rows: { id: string; type: string; messages: any[] }[] = []
    for (const message of messages()) {
      const previous = rows.at(-1)
      if (message.type === "assistant" && previous?.type === "assistant") previous.messages.push(message)
      else rows.push({ id: message.id, type: message.type, messages: [message] })
    }
    return rows
  })
  const turnStarts = createMemo(() => {
    const starts: Record<string, number> = {}
    let start: number | undefined
    for (const message of messages()) {
      if (message.type === "user") start = message.time?.created
      if (start !== undefined && message.id) starts[message.id] = start
    }
    return starts
  })
  const awaitingResponse = createMemo(() =>
    busy() && messages().at(-1)?.type !== "assistant",
  )

  const scrollToEnd = () => {
    const box = scroll
    if (!box || box.isDestroyed || disposed) return
    try {
      box.scrollTo(box.scrollHeight)
      setAwayFromBottom(false)
    } catch {}
  }
  const updateScrollPosition = () => {
    queueMicrotask(() => {
      const box = scroll
      if (!box || box.isDestroyed || disposed) return
      setAwayFromBottom(box.scrollTop < Math.max(0, box.scrollHeight - box.viewport.height) - 1)
    })
  }

  const focusInput = () => {
    setTimeout(() => {
      if (!disposed && panel.focused && !pickerOpen() && input && !input.isDestroyed) input.focus()
    }, 0)
  }

  const loadTranscript = async (id: string) => {
    try {
      await Promise.all([
        context.data.session.sync(id),
        context.data.session.message.sync(id),
      ])
    } catch (cause: unknown) {
      setError(`Could not load side chat: ${String((cause as any)?.message ?? cause)}`, id)
    }
  }

  createEffect(() => {
    const id = sideID()
    if (!id || !ready() || !panel.focused || busy() || awayFromBottom()) return
    const session = context.data.session.get(id)
    if (!sideChatUnread(session, sideViewed(settings, panel.sessionID, id)) || session?.time?.idle == null) return
    void markSideViewed(context, settings, persist, panel.sessionID, id).catch(() => undefined)
  })

  // Watch session identity: closing a tab can replace it at the same index.
  createEffect(() => {
    const id = sideID()
    let cancelled = false
    onCleanup(() => { cancelled = true })
    setReady(false)
    setAwayFromBottom(false)
    untrack(() => {
      const value = id ? runtime.drafts[id] ?? "" : ""
      setInputValue(value)
      if (input && !input.isDestroyed) {
        input.setText(value)
        input.cursorOffset = value.length
      }
      setComposerCursor(value.length)
      setCommandsDismissed(false)
      setCommandIndex(0)
    })
    void (async () => {
      if (id) await loadTranscript(id)
      if (cancelled || disposed) return
      setReady(true)
      queueMicrotask(scrollToEnd)
      focusInput()
    })()
  })

  // Refocus the input whenever the host hands focus back to the panel.
  createEffect(() => {
    if (panel.focused) focusInput()
  })

  onMount(() => {
    if (chatsOf(panel.sessionID, settings).list.length === 0)
      void createChat(context, settings, persist, panel.sessionID)
  })

  function resetInterrupt() {
    clearTimeout(interruptTimer)
    interruptTimer = undefined
    setInterruptArmed(false)
  }

  createEffect(() => {
    sideID()
    running()
    resetInterrupt()
  })

  function handleInterrupt() {
    if (!running() || runtime.stopping[sideID() ?? ""]) return
    if (interruptArmed()) {
      resetInterrupt()
      void stopResponse()
      return
    }
    setInterruptArmed(true)
    interruptTimer = setTimeout(resetInterrupt, 5000)
  }

  async function stopResponse() {
    const id = sideID()
    if (!id || !running() || runtime.stopping[id]) return
    changeRuntime((draft) => { draft.stopping[id] = true })
    try {
      await context.client.session.interrupt({ sessionID: id, resume: true })
      await context.data.session.message.sync(id)
    } catch (cause: unknown) {
      if (isInterruption(cause)) return
      setError(`Could not stop response: ${String((cause as any)?.message ?? cause)}`, id)
    } finally {
      changeRuntime((draft) => { delete draft.stopping[id] })
    }
  }

  function clearComposer() {
    setDraft("")
    setComposerCursor(0)
    if (input && !input.isDestroyed) input.setText("")
  }

  async function chooseModel() {
    const id = sideID()
    if (!id || pickerOpen()) return
    resetInterrupt()
    setPickerOpen(true)
    try {
      await pickSideChatModel(context, id)
    } catch (cause: unknown) {
      context.ui.toast.show({
        message: `Could not select a side chat model: ${String((cause as any)?.message ?? cause)}`,
        variant: "error",
      })
    } finally {
      setPickerOpen(false)
      focusInput()
    }
  }

  async function chooseAgent() {
    const id = sideID()
    if (!id || pickerOpen()) return
    resetInterrupt()
    setPickerOpen(true)
    try {
      await pickSideChatAgent(context, id)
    } catch (cause: any) {
      context.ui.toast.show({ variant: "error", message: `Could not select a side chat agent: ${String(cause?.message ?? cause)}` })
    } finally {
      setPickerOpen(false)
      focusInput()
    }
  }

  async function chooseNewChat() {
    if (pickerOpen()) return
    resetInterrupt()
    setPickerOpen(true)
    try { await createChat(context, settings, persist, panel.sessionID, true) } finally {
      setPickerOpen(false)
      focusInput()
    }
  }

  async function chooseTab() {
    if (pickerOpen()) return
    resetInterrupt()
    setPickerOpen(true)
    try {
      const chosen = await context.ui.dialog.select({
        title: "Side chat tabs",
        placeholder: "Search side chat tabs…",
        current: sideID(),
        options: chats().list.map((entry) => ({
          title: entry.title || "New chat",
          value: entry.id,
          description: context.data.session.status(entry.id) === "running" || runtime.active[entry.id]
            ? "Working" : entry.id === sideID() ? "Current tab" : undefined,
        })),
      })
      if (chosen === undefined) return
      await persist((draft) => {
        const current = draft.chats[panel.sessionID]
        const index = current?.list.findIndex((entry) => entry.id === chosen) ?? -1
        if (current && index >= 0) current.active = index
      })
    } finally {
      setPickerOpen(false)
      focusInput()
    }
  }

  async function chooseHistory() {
    if (pickerOpen()) return
    resetInterrupt()
    setPickerOpen(true)
    try {
      await showSideHistory(context, settings, persist, runtime, panel.sessionID, changeRuntime)
    } catch (cause: unknown) {
      context.ui.toast.show({ variant: "error", message: `SideChat history: ${String((cause as any)?.message ?? cause)}` })
    } finally {
      setPickerOpen(false)
      focusInput()
    }
  }

  function updateComposer() {
    const value = readComposer()
    setDraft(value)
    setComposerCursor(input?.cursorOffset ?? value.length)
    setCommandIndex(0)
    setCommandsDismissed(false)
  }

  async function runCommand(command: SideChatCommand) {
    if (pickerOpen()) return
    clearComposer()
    try {
      await command.run()
    } catch (cause: unknown) {
      context.ui.toast.show({
        message: `Side chat command failed: ${String((cause as any)?.message ?? cause)}`,
        variant: "error",
      })
    }
  }

  function handleSuggestionKey(name: string) {
    const suggestions = commandSuggestions()
    if (!suggestions.length) return
    if (name === "up" || name === "down") {
      const step = name === "up" ? -1 : 1
      setCommandIndex((index) => (index + step + suggestions.length) % suggestions.length)
      return
    }
    if (name === "escape") {
      setCommandsDismissed(true)
      return
    }
    const command = suggestions[commandIndex()] ?? suggestions[0]
    if (name === "tab") {
      const value = `/${command.name}`
      setDraft(value)
      if (input && !input.isDestroyed) {
        input.setText(value)
        input.cursorOffset = value.length
      }
      setComposerCursor(value.length)
      return
    }
    void runCommand(command)
  }

  function onComposerKeyDown(event: any) {
    if (event.defaultPrevented) return
    if (pickerOpen()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.ctrl || event.meta || event.option || event.shift) return
    if (!commandSuggestions().length) {
      if (event.name !== "escape" || !running()) return
      event.preventDefault()
      event.stopPropagation()
      handleInterrupt()
      return
    }
    if (!["up", "down", "escape", "tab", "return"].includes(event.name)) return
    event.preventDefault()
    event.stopPropagation()
    handleSuggestionKey(event.name)
  }

  // Claim menu keys before the host's global bindings can handle them.
  context.keymap.layer(() => ({
    mode: "global",
    target: () => input,
    priority: 100,
    enabled: () => commandSuggestions().length > 0,
    commands: [
      ["prev", "up", "Previous side chat command"],
      ["next", "down", "Next side chat command"],
      ["dismiss", "escape", "Dismiss side chat commands"],
      ["complete", "tab", "Complete side chat command"],
      ["run", "return", "Run side chat command"],
    ].map(([id, bind, title]) => ({
      id: `sidechat.commands.${id}`,
      bind,
      title,
      group: "SideChat",
      run: () => handleSuggestionKey(bind),
    })),
  }))

  // Scope interruption to the side composer so a main reply keeps running.
  context.keymap.layer(() => ({
    mode: "global",
    target: () => input,
    priority: 100,
    enabled: () => panel.focused && running() && !pickerOpen() && commandSuggestions().length === 0,
    commands: [{
      id: "sidechat.interrupt",
      title: "Interrupt side chat",
      group: "SideChat",
      bind: "escape",
      run: handleInterrupt,
    }],
  }))

  async function submit() {
    const id = sideID()
    const mainID = panel.sessionID
    const question = readComposer().trim()
    const command = commandSuggestions()[commandIndex()] ?? slashCommands.find((item) =>
      [item.name, ...(item.aliases ?? [])].some((name) => question.toLowerCase() === `/${name}`),
    )
    if (command) {
      await runCommand(command)
      return
    }
    if (!id || !question || pickerOpen()) return
    if (busy()) {
      context.ui.toast.show({ variant: "warning", message: "SideChat is busy; your question is still in the draft" })
      return
    }
    const entry = chats().list.find((chat) => chat.id === id)
    setDraft("", id)
    try {
      input?.setText("")
    } catch {}
    changeRuntime((draft) => { draft.submitting[id] = true; delete draft.errors[id] })
    scrollToEnd()
    let admitted = false
    try {
      const enabled = await configureSideContext(context, mainID, id, entryContext(entry))
      await rememberSideContext(persist, mainID, id, enabled)
      // Auto-title the first exchange.
      if (entry && (entry.title === "New chat" || !entry.title)) {
        const title = question.replace(/\s+/g, " ").slice(0, TITLE_MAX)
        await persist((draft: Settings) => {
          const current = draft.chats[mainID] ?? { active: 0, list: [] }
          const item = current.list.find((chat) => chat.id === entry.id)
          if (item) item.title = title
          draft.chats[mainID] = current
        })
        void context.client.session.update?.({ sessionID: id, title }).catch(() => undefined)
      }

      changeRuntime((draft) => { draft.active[id] = true })
      const session = context.data.session.get(id)
      await sendSideQuestion(context, id, question, session?.location ?? context.location)
      admitted = true
      void context.data.session.message.sync(id).catch(() => undefined)
    } catch (cause: unknown) {
      if (isInterruption(cause)) return
      if (!admitted && !runtime.drafts[id]) {
        setDraft(question, id)
        if (!disposed && sideID() === id && input && !input.isDestroyed) {
          input.setText(question)
          input.cursorOffset = question.length
          setComposerCursor(question.length)
        }
      }
      setError(String((cause as any)?.message ?? cause), id)
      context.ui.toast.show({ variant: "error", message: "SideChat request failed" })
    } finally {
      changeRuntime((draft) => {
        delete draft.submitting[id]
        if (!admitted) delete draft.active[id]
      })
    }
  }

  const switchTo = (index: number) => {
    void persist((draft: Settings) => {
      const current = draft.chats[panel.sessionID] ?? { active: 0, list: [] }
      current.active = index
      draft.chats[panel.sessionID] = current
    }).then(focusInput)
  }

  const tabLabel = (title: string) =>
    title.length > TAB_WIDTH ? `${title.slice(0, TAB_WIDTH - 1)}…` : title

  return (
    <box
      ref={attachSurface}
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      minWidth={0}
      position="relative"
      backgroundColor={background()}
      onMouseUp={() => focusInput()}
    >
      <box
        borderStyle="rounded"
        border
        borderColor={theme().border.base}
        title=" SideChat "
        titleColor={muted()}
        titleAlignment="left"
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        minWidth={0}
        gap={1}
        paddingTop={1}
        paddingLeft={1}
        paddingRight={1}
        paddingBottom={1}
      >
        {/* One terminal line per row: full box borders would triple the height. */}
        <box flexDirection="column" gap={0} flexShrink={0} paddingRight={1}>
          <box height={1} flexDirection="row" gap={1} flexShrink={0} alignItems="center">
            <For each={chats().list}>
              {(entry, index) => {
                const selected = () => index() === active()
                return (
                  <box
                    flexDirection="row" gap={1} alignItems="center" minWidth={6} flexShrink={1}
                    height={1}
                    backgroundColor={selected() ? theme().background.raised.high : background()}
                    paddingLeft={1} paddingRight={1} onMouseUp={() => switchTo(index())}
                  >
                    <text
                      fg={selected() ? theme().text.base : muted()}
                      attributes={selected() ? TextAttributes.BOLD : 0}
                      wrapMode="none"
                      truncate
                      flexShrink={1}
                    >
                      {selected() ? `› ${tabLabel(entry.title)} ‹` : tabLabel(entry.title)}
                      {sideChatBusy(context, runtime, entry.id) ? " …" : sideChatUnread(context.data.session.get(entry.id), entry.viewedUpdated) ? " ●" : ""}
                    </text>
                    <text
                      fg={selected() ? theme().text.base : muted()}
                      flexShrink={0}
                      onMouseUp={(event: any) => {
                        event.stopPropagation()
                        void closeChat(context, settings, persist, panel.sessionID, entry.id)
                      }}
                    >
                      ×
                    </text>
                  </box>
                )
              }}
            </For>
            <text
              fg={muted()}
              flexShrink={0}
              onMouseUp={() => void chooseNewChat()}
            >
              +
            </text>
          </box>

          <box height={1} flexDirection="row" gap={1} flexShrink={0} alignItems="center">
            <box
              height={1} flexDirection="row" gap={1} flexShrink={1} minWidth={10}
              onMouseUp={() => void toggleMainContext(context, settings, persist, panel.sessionID)}
            >
              <text fg={muted()} wrapMode="none" truncate flexShrink={1} minWidth={0}>main context: hidden ·</text>
              <text fg={includeContext() ? theme().text.feedback.success.base : muted()}
                attributes={includeContext() ? TextAttributes.BOLD : 0} flexShrink={0}>
                {includeContext() ? "ON" : "OFF"}
              </text>
            </box>
            <text fg={muted()} wrapMode="none" truncate minWidth={0} maxWidth={16} flexShrink={1} onMouseUp={() => void chooseAgent()}>
              {context.data.session.get(sideID() ?? "")?.agent ?? "build"} ▾
            </text>
            <box
              height={1} border={["left", "right"]} borderColor={theme().border.base}
              paddingLeft={1} paddingRight={1} flexDirection="row" gap={1} flexShrink={1} minWidth={5}
              onMouseUp={() => void chooseModel()}
            >
              <text fg={muted()} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                {sideModelLabel()}
              </text>
              <text fg={muted()} flexShrink={0}>▾</text>
            </box>
            <box flexGrow={1} flexShrink={0} />
          </box>
        </box>

        {/* Transcript */}
        <box flexGrow={1} flexShrink={1} minWidth={0} minHeight={0} flexDirection="column">
          <scrollbox
            ref={(element: ScrollBoxRenderable) => {
              detachScroll?.()
              scroll = element
              element.verticalScrollBar.on("change", updateScrollPosition)
              element.content.on("resize", updateScrollPosition)
              element.viewport.on("resize", updateScrollPosition)
              detachScroll = () => {
                element.verticalScrollBar.off("change", updateScrollPosition)
                element.content.off("resize", updateScrollPosition)
                element.viewport.off("resize", updateScrollPosition)
              }
            }}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            minHeight={0}
            scrollX={false}
            stickyScroll
            stickyStart="bottom"
            onMouseScroll={updateScrollPosition}
            // Keep the bar in its own column and wrap content before its gutter.
            wrapperOptions={{ minWidth: 0, flexBasis: 0, flexShrink: 1 }}
            viewportOptions={{ minWidth: 0, paddingRight: 1 }}
            verticalScrollbarOptions={{ width: 1, flexShrink: 0 }}
            horizontalScrollbarOptions={{ visible: false }}
            scrollbarOptions={{
              trackOptions: {
                backgroundColor: background(),
                foregroundColor: theme().scrollbar.base,
              },
              arrowOptions: {
                backgroundColor: background(),
                foregroundColor: theme().scrollbar.base,
              },
            }}
          >
            <box width="100%" minWidth={0} flexDirection="column" gap={1}>
              <Show when={!ready()}>
                <text fg={muted()}>loading…</text>
              </Show>
              <Show when={ready() && messages().length === 0}>
                <text fg={muted()}>No messages yet. Ask something below.</text>
              </Show>
              <Show when={error()}>
                <text fg={theme().text.base}>error: {error()}</text>
              </Show>
              <Index each={transcript()}>
                {(row) => (
                  <Show when={row().type === "assistant"} fallback={
                    <MessageView
                      context={context} sessionID={sideID()} message={row().messages[0]}
                      theme={theme()} background={background()} syntaxStyle={syntaxStyle()}
                      renderNode={markdownRenderNode} isLast={row().id === lastID()}
                      turnStart={turnStarts()[row().id]}
                      expanded={(key: string) => !!disclosures()[key]}
                      onToggle={(key: string) => setDisclosures((previous) => ({ ...previous, [key]: !previous[key] }))}
                    />
                  }>
                  <AssistantTurn
                    context={context}
                    sessionID={sideID()}
                    messages={row().messages}
                    theme={theme()}
                    background={background()}
                    syntaxStyle={syntaxStyle()}
                    renderNode={markdownRenderNode}
                    isLast={row().messages.at(-1)?.id === lastID()}
                    running={busy()}
                    turnStart={turnStarts()[row().id]}
                    expanded={(key: string) => !!disclosures()[key]}
                    onToggle={(key: string) =>
                      setDisclosures((previous) => ({ ...previous, [key]: !previous[key] }))
                    }
                  />
                  </Show>
                )}
              </Index>
              <Show when={awaitingResponse()}>
                <box paddingLeft={3}>
                  <SideActivityRow theme={theme()} running label="Thinking" />
                </box>
              </Show>
            </box>
          </scrollbox>
        </box>

        {/* Composer */}
        <box flexShrink={0} minWidth={0} flexDirection="column" gap={0} position="relative" backgroundColor={background()}>
          <Show when={visibleCommands().length > 0}>
            <box
              position="absolute"
              bottom="100%"
              left={0}
              right={0}
              zIndex={10}
              flexDirection="column"
              backgroundColor={theme().background.raised.base}
              padding={1}
            >
              <For each={visibleCommands()}>
                {(command, index) => {
                  const selected = () => commandOffset() + index() === commandIndex()
                  return (
                    <box
                      flexDirection="row"
                      gap={2}
                      backgroundColor={selected() ? theme().background.action.primary.focused : theme().background.raised.base}
                      onMouseUp={() => void runCommand(command)}
                    >
                      <text
                        width={16}
                        flexShrink={1}
                        minWidth={0}
                        wrapMode="none"
                        truncate
                        fg={selected() ? theme().text.action.primary.focused : theme().text.base}
                        attributes={selected() ? TextAttributes.BOLD : 0}
                      >
                        /{command.name}
                      </text>
                      <text
                        flexShrink={1}
                        minWidth={0}
                        wrapMode="none"
                        truncate
                        fg={selected() ? theme().text.action.primary.focused : muted()}
                      >
                        {command.description}
                      </text>
                    </box>
                  )
                }}
              </For>
              <text fg={muted()} wrapMode="none" truncate>
                ↑↓ navigate · enter run · tab complete · esc dismiss
              </text>
            </box>
          </Show>
          <box
            minWidth={0}
            flexDirection="column"
            overflow="hidden"
            borderStyle="single"
            border
            borderColor={accent()}
            backgroundColor={background()}
            onMouseUp={() => focusInput()}
          >
            <textarea
              ref={(renderable: any) => {
                input = renderable
                const value = runtime.drafts[sideID() ?? ""] ?? ""
                setInputValue(value)
                input.setText(value)
                input.cursorOffset = value.length
                setComposerCursor(value.length)
                focusInput()
              }}
              width="100%"
              minWidth={0}
              minHeight={1}
              maxHeight={6}
              backgroundColor={background()}
              focusedBackgroundColor={background()}
              wrapMode="char"
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
              ]}
              onContentChange={updateComposer}
              onCursorChange={() => setComposerCursor(input?.cursorOffset ?? 0)}
              onKeyDown={onComposerKeyDown}
              onSubmit={() => void submit()}
              placeholder={
                includeContext()
                  ? "Ask with hidden main context… (/ commands · enter sends · shift+enter newline)"
                  : "Ask the side chat… (/ commands · enter sends · shift+enter newline)"
              }
              placeholderColor={muted()}
              textColor={theme().text.base}
              focusedTextColor={theme().text.base}
            />
          </box>
          <Show when={busy() || awayFromBottom()}>
            <box height={1} flexDirection="row" flexShrink={0} minWidth={0}>
              <Show when={busy()}>
                <Show when={running()} fallback={
                  <text fg={muted()} wrapMode="none" truncate>
                    {runtime.submitting[sideID() ?? ""] ? "Preparing…" : "Queued…"}
                  </text>
                }>
                  <SideInterruptStatus theme={theme()} color={sideAgentColor(context, theme(), SIDE_AGENT)}
                    armed={interruptArmed()} stopping={!!runtime.stopping[sideID() ?? ""]} />
                </Show>
              </Show>
              <box flexGrow={1} />
              <Show when={awayFromBottom()}>
                <text fg={theme().text.base} wrapMode="none" truncate onMouseUp={scrollToEnd}>Jump to latest ↓</text>
              </Show>
            </box>
          </Show>
        </box>
      </box>
      <PanelToggle context={context} open />
    </box>
  )
}

const MESSAGE_BORDER = {
  topLeft: "", bottomLeft: "", vertical: "┃", topRight: "", bottomRight: "",
  horizontal: " ", bottomT: "", topT: "", cross: "", leftT: "", rightT: "",
}
const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function SideInterruptStatus(props: { theme: any; color: ColorInput; armed: boolean; stopping: boolean }) {
  const [frame, setFrame] = createSignal(0)
  const cells = Array.from({ length: 8 }, (_, index) => index)
  const position = () => frame() < 8 ? frame() : 14 - frame()
  onMount(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % 14), 80)
    onCleanup(() => clearInterval(timer))
  })
  const hintColor = () => props.armed ? props.theme.text.feedback.warning.base : props.theme.text.base
  return (
    <box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
      <text width={8} flexShrink={0}>
        <For each={cells}>
          {(index) => <span style={{ fg: Math.abs(position() - index) < 2 ? props.color : props.theme.text.muted }}>
            {Math.abs(position() - index) < 2 ? "■" : "⬝"}
          </span>}
        </For>
      </text>
      <text fg={hintColor()} wrapMode="none" truncate flexShrink={1} minWidth={0}>
        {props.stopping ? "interrupting…" : "esc "}
        <Show when={!props.stopping}>
          <span style={{ fg: props.armed ? hintColor() : props.theme.text.muted }}>
            {props.armed ? "again to interrupt" : "interrupt"}
          </span>
        </Show>
      </text>
    </box>
  )
}

function displayDuration(milliseconds: number) {
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor(milliseconds % 60_000 / 1000)}s`
}

function sideAgentColor(context: any, theme: any, id: string): ColorInput {
  const agents = (context.data.location.agent.list(context.location) ?? []).filter((agent: any) => !agent.hidden)
  const index = agents.findIndex((agent: any) => agent.id === id)
  const configured = agents[index]?.color
  if (configured) {
    try { return RGBA.fromHex(configured) } catch {}
  }
  return theme.categorical[Math.max(0, index) % theme.categorical.length]?.[200] ?? theme.text.base
}

function assistantGroups(parts: any[]) {
  const groups: { id: string; kind: string; parts: any[] }[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (!["reasoning", "tool", "text"].includes(part.type)) continue
    const last = groups.at(-1)
    if (part.type !== "text" && last?.kind === part.type) last.parts.push(part)
    else groups.push({ id: `${part.id ?? index}:${part.type}`, kind: part.type, parts: [part] })
  }
  return groups
}

function SideActivityRow(props: {
  theme: any; label: string; running?: boolean; icon?: string; color?: ColorInput; onToggle?: () => void
}) {
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (!props.running) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % ACTIVITY_FRAMES.length), 80)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <box flexDirection="row" onMouseUp={props.onToggle} minWidth={0}>
      <text width={2} flexShrink={0} fg={props.color ?? props.theme.text.muted}>
        {props.running ? ACTIVITY_FRAMES[frame()] : props.icon ?? "→"}
      </text>
      <text fg={props.color ?? props.theme.text.muted} flexShrink={1} minWidth={0} wrapMode="none" truncate>
        {props.label}
      </text>
    </box>
  )
}

// Apply the palette before parsing content. Table cells cache explicit token
// colors, so refresh them when the style changes, including on initial mount.
function MessageMarkdown(props: {
  content: string; theme: any; background: ColorInput; syntaxStyle: SyntaxStyle; renderNode: () => undefined; streaming?: boolean
}) {
  let markdown: MarkdownRenderable | undefined
  let appliedStyle: SyntaxStyle | undefined
  let appliedFg: ColorInput | undefined
  createEffect(() => {
    const style = props.syntaxStyle
    const fg = props.theme.markdown.text
    const bg = props.background
    const content = props.content
    const streaming = Boolean(props.streaming)
    if (!markdown || markdown.isDestroyed) return
    const refresh = appliedStyle !== style || appliedFg !== fg
    markdown.syntaxStyle = style
    markdown.fg = fg
    markdown.bg = bg
    markdown.content = content
    markdown.streaming = streaming
    if (refresh) markdown.refreshStyles()
    appliedStyle = style
    appliedFg = fg
  })
  return (
    <markdown
      ref={(element: MarkdownRenderable) => { markdown = element }}
      syntaxStyle={props.syntaxStyle}
      renderNode={props.renderNode}
      conceal
      internalBlockMode="top-level"
      tableOptions={{ style: "grid", cellPaddingX: 1, borderColor: props.theme.border.base }}
    />
  )
}

function ToolDetail(props: {
  part: any; theme: any; expanded: boolean; onToggle: () => void; hasSelection: () => boolean
}) {
  const name = () => String(props.part.name ?? "tool").replace(/^.*[./]/, "")
  const input = () => typeof props.part.state?.input === "object" ? props.part.state.input ?? {} : {}
  const running = () => ["streaming", "running"].includes(props.part.state?.status)
  const failed = () => props.part.state?.status === "error"
  const summary = () => {
    const value = input()
    const titles: Record<string, string> = {
      shell: "$", read: "Read", glob: "Glob", grep: "Grep", websearch: "Web Search",
      webfetch: "WebFetch", write: "Write", edit: "Edit", patch: "Patch", subagent: "Subagent",
    }
    const detail = value.command ?? value.path ?? value.filePath ?? value.file_path ?? value.query ??
      value.pattern ?? value.url ?? value.description ?? ""
    return `${titles[name()] ?? name()} ${String(detail).replace(/\s+/g, " ")}`.trim()
  }
  const output = () => {
    const content = props.part.state?.content ?? []
    const text = content.filter((item: any) => item.type === "text").map((item: any) => String(item.text ?? "")).join("\n")
    return text.length > 16_000 ? `${text.slice(0, 16_000)}\n[…output truncated…]` : text
  }
  const error = () => String(props.part.state?.error?.message ?? props.part.state?.error ?? "")
  return (
    <box flexDirection="column" gap={props.expanded ? 1 : 0} flexShrink={0}>
      <SideActivityRow
        theme={props.theme}
        label={summary()}
        running={running()}
        icon={failed() ? "✗" : name() === "shell" ? "$" : ["grep", "glob"].includes(name()) ? "✱" : "→"}
        color={failed() ? props.theme.text.feedback.error.base : props.theme.text.muted}
        onToggle={() => { if (!props.hasSelection()) props.onToggle() }}
      />
      <Show when={props.expanded}>
        <box
          flexDirection="column" gap={1} padding={1} marginLeft={2}
          backgroundColor={props.theme.background.raised.base}
          border={["left"]} customBorderChars={MESSAGE_BORDER} borderColor={props.theme.border.base}
        >
          <For each={Object.entries(input())}>
            {([key, value]) => (
              <text fg={props.theme.text.base} wrapMode="word">
                <span style={{ fg: props.theme.text.muted }}>{key}: </span>
                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              </text>
            )}
          </For>
          <Show when={output()}><text fg={props.theme.text.base} wrapMode="word">{output()}</text></Show>
          <Show when={failed()}><text fg={props.theme.text.feedback.error.base}>{error()}</text></Show>
        </box>
      </Show>
      <Show when={failed() && !props.expanded}>
        <text paddingLeft={2} fg={props.theme.text.feedback.error.base}>{error()}</text>
      </Show>
    </box>
  )
}

type MessageViewProps = {
  context: any; sessionID?: string; message: any; theme: any; background: ColorInput; syntaxStyle: SyntaxStyle;
  renderNode: () => undefined; isLast: boolean; turnStart?: number;
  expanded: (key: string) => boolean; onToggle: (key: string) => void;
  view?: "activity" | "answer"
}

function AssistantTurn(props: Omit<MessageViewProps, "message" | "view"> & { messages: any[]; running: boolean }) {
  const last = () => props.messages.at(-1)
  const running = () => props.isLast && props.running
  const activity = createMemo(() => props.messages.filter((message) =>
    (message.content ?? []).some((part: any) => part.type === "tool" ||
      (part.type === "reasoning" && String(part.text ?? "").trim()) ||
      (part.type === "text" && message.finish === "tool-calls" && String(part.text ?? "").trim())),
  ))
  const answers = createMemo(() => props.messages.filter((message) => (message.finish !== "tool-calls" || message.error) &&
    ((message.content ?? []).some((part: any) => part.type === "text" && String(part.text ?? "").trim()) ||
      message.error || message.time?.completed !== undefined),
  ))
  const key = () => `${props.messages[0]?.id}:thinking`
  const expanded = () => props.expanded(key())
  const toggle = () => {
    if (!props.context.renderer.getSelection()?.getSelectedText()) props.onToggle(key())
  }

  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <Show when={activity().length > 0 || running()}>
        <box flexDirection="column" gap={expanded() ? 1 : 0} flexShrink={0}>
          <box paddingLeft={3}>
            <SideActivityRow theme={props.theme} running={running()} icon=""
              label={`Thinking ${expanded() ? "◭" : "⧨"}`} onToggle={toggle} />
          </box>
          <Show when={expanded()}>
            <box flexDirection="column" gap={1} flexShrink={0}>
              <For each={activity()}>
                {(message) => <MessageView {...props} message={message} view="activity" isLast={false} />}
              </For>
              <Show when={activity().length === 0 && running()}>
                <text paddingLeft={3} fg={props.theme.text.muted}>Waiting for response…</text>
              </Show>
            </box>
          </Show>
        </box>
      </Show>
      <For each={answers()}>
        {(message) => <MessageView {...props} message={message} view="answer"
          isLast={props.isLast && message.id === last()?.id} />}
      </For>
    </box>
  )
}

function MessageView(props: MessageViewProps) {
  const message = () => props.message
  const theme = () => props.theme
  const interrupted = () => isInterruption(message().error)
  const done = () => message().time?.completed !== undefined || interrupted()
  const hasSelection = () => Boolean(props.context.renderer.getSelection()?.getSelectedText())
  const keyFor = (id: string) => `${message().id}:${id}`
  const toggle = (id: string) => { if (!hasSelection()) props.onToggle(keyFor(id)) }
  const groups = createMemo(() => assistantGroups(message().content ?? []))
  const userText = () => sideQuestionText(message())
  const agent = () => String(message().agent ?? "build")
  const agentColor = () => sideAgentColor(props.context, theme(), agent())
  const modelLabel = () => {
    const model = message().model
    return (props.context.data.location.model.list(props.context.location) ?? [])
      .find((item: any) => item.providerID === model?.providerID && item.id === model?.id)?.name ?? model?.id ?? ""
  }
  const duration = () => Math.max(0, (message().time?.completed ?? 0) - (props.turnStart ?? message().time?.created ?? 0))

  return (
    <>
      <Show when={message().type === "user" && userText().trim()}>
        <box
          flexDirection="column" flexShrink={0} border={["left"]} customBorderChars={MESSAGE_BORDER}
          borderColor={sideAgentColor(props.context, theme(), (props.sessionID ? props.context.data.session.get(props.sessionID)?.agent : undefined) ?? "build")}
          backgroundColor={theme().background.raised.base}
          paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}
        >
          <text fg={theme().text.base} wrapMode="word">{userText()}</text>
          <Show when={contextOmissionNote(message())}>
            <text fg={theme().text.muted} wrapMode="word">{contextOmissionNote(message())}</text>
          </Show>
        </box>
      </Show>
      <Show when={message().type === "assistant"}>
        <box flexDirection="column" gap={1} flexShrink={0}>
          <Index each={groups()}>
            {(group) => (
              <>
                <Show when={group().kind === "text" && String(group().parts[0]?.text ?? "").trim() &&
                  (props.view === "activity" ? message().finish === "tool-calls" : message().finish !== "tool-calls")}>
                  <box paddingLeft={3} flexShrink={0}>
                    <MessageMarkdown
                      content={String(group().parts[0]?.text ?? "").trim()}
                      theme={theme()} background={props.background} syntaxStyle={props.syntaxStyle}
                      renderNode={props.renderNode} streaming={!done()}
                    />
                  </box>
                </Show>
                <Show when={props.view !== "answer" && group().kind === "reasoning"}>
                  <ThoughtGroup
                    parts={group().parts} message={message()} theme={theme()} syntaxStyle={props.syntaxStyle}
                    renderer={props.context.renderer} expanded={props.expanded(keyFor(group().id))}
                    onToggle={() => toggle(group().id)}
                  />
                </Show>
                <Show when={props.view !== "answer" && group().kind === "tool"}>
                  <box paddingLeft={3} flexDirection="column" gap={1} flexShrink={0}>
                    <Show when={group().parts.length > 1} fallback={
                      <ToolDetail part={group().parts[0]} theme={theme()}
                        expanded={props.expanded(keyFor(group().id))} onToggle={() => toggle(group().id)} hasSelection={hasSelection} />
                    }>
                      <SideActivityRow theme={theme()}
                        running={group().parts.some((part: any) => ["running", "streaming"].includes(part.state?.status))}
                        icon={props.expanded(keyFor(group().id)) ? "−" : "→"}
                        label={toolGroupLabel(group().parts)} onToggle={() => toggle(group().id)} />
                      <Show when={props.expanded(keyFor(group().id))}>
                        <box paddingLeft={2} flexDirection="column" gap={1}>
                          <For each={group().parts}>
                            {(part: any) => <ToolDetail part={part} theme={theme()}
                              expanded={props.expanded(keyFor(part.id))} onToggle={() => toggle(part.id)} hasSelection={hasSelection} />}
                          </For>
                        </box>
                      </Show>
                    </Show>
                  </box>
                </Show>
              </>
            )}
          </Index>
          <Show when={!props.view && !done() && props.isLast && groups().length === 0}>
            <box paddingLeft={3}><SideActivityRow theme={theme()} running label="Thinking" /></box>
          </Show>
          <Show when={props.view !== "activity" && message().error && !interrupted()}>
            <text paddingLeft={3} fg={theme().text.feedback.error.base}>
              Error: {String(message().error?.message ?? message().error)}
            </text>
          </Show>
          <Show when={props.view !== "activity" && done() && (message().finish !== "tool-calls" || interrupted())}>
            <text paddingLeft={3}>
              <span style={{ fg: interrupted() ? theme().text.muted : agentColor() }}>{agent().charAt(0).toUpperCase() + agent().slice(1)}</span>
              <span style={{ fg: theme().text.muted }}>{modelLabel() ? ` · ${modelLabel()}` : ""}{duration() ? ` · ${displayDuration(duration())}` : ""}</span>
              <Show when={interrupted()}><span style={{ fg: theme().text.muted }}> · interrupted</span></Show>
            </text>
          </Show>
        </box>
      </Show>
      <Show when={message().type === "compaction"}>
        <box paddingLeft={3}>
          <SideActivityRow theme={theme()} running={message().status === "running"} icon="⋯"
            label={message().status === "completed" ? "Context compacted" : message().status === "failed" ? "Context compaction failed" : "Compacting context"}
            onToggle={() => toggle("compaction")} />
          <Show when={props.expanded(keyFor("compaction")) && message().summary}>
            <text fg={theme().text.muted}>{message().summary}</text>
          </Show>
        </box>
      </Show>
      <Show when={["synthetic", "system"].includes(message().type)}>
        <text paddingLeft={3} fg={theme().text.muted}>
          {String(message().description ?? (message().type === "system" ? "Instructions updated" : ""))}
        </text>
      </Show>
    </>
  )
}

function toolGroupLabel(parts: any[]) {
  const running = parts.some((part) => ["running", "streaming"].includes(part.state?.status))
  const failed = parts.filter((part) => part.state?.status === "error").length
  const counts = new Map<string, number>()
  for (const part of parts) {
    const name = String(part.name ?? "tool").replace(/^.*[./]/, "")
    const kind = ["grep", "glob", "websearch"].includes(name) ? "search" : name === "webfetch" ? "fetch" : name
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const labels = Array.from(counts, ([name, count]) => `${count} ${name}${count === 1 ? "" : ["search", "fetch"].includes(name) ? "es" : "s"}`)
  return `${running ? "Exploring" : "Explored"}: ${labels.join(", ")}${failed ? ` · ${failed} failed` : ""}`
}

function ThoughtGroup(props: {
  parts: any[]; message: any; theme: any; syntaxStyle: SyntaxStyle; renderer: any; expanded: boolean; onToggle: () => void
}) {
  const text = () => props.parts.map((part) => String(part.text ?? "").replace(/\[REDACTED\]/g, "").trim()).filter(Boolean).join("\n\n")
  const title = () => /^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/.exec(text())?.[1]?.trim()
  const done = () => props.message.time?.completed !== undefined || props.parts.every((part) => part.time?.completed !== undefined)
  const duration = () => props.parts.reduce((total, part) => {
    const start = part.time?.created ?? props.message.time?.created
    const end = part.time?.completed ?? props.message.time?.completed
    return total + (start === undefined || end === undefined ? 0 : Math.max(0, end - start))
  }, 0)
  let current: SyntaxStyle | undefined
  const release = (style: SyntaxStyle) => { void props.renderer.idle().catch(() => undefined).finally(() => style.destroy()) }
  const syntax = createMemo(() => {
    const source = props.syntaxStyle
    if (!props.expanded) {
      if (current) release(current)
      current = undefined
      return source
    }
    const color = props.theme.text.muted
    const next = SyntaxStyle.fromStyles(Object.fromEntries(source.getRegisteredNames().map((name) => [name, { ...source.getStyle(name), fg: color }])))
    if (current) release(current)
    return current = next
  })
  onCleanup(() => { if (current) release(current) })
  return (
    <Show when={text() || !done()}>
      <box paddingLeft={3} flexDirection="column" gap={props.expanded ? 1 : 0} flexShrink={0}>
        <SideActivityRow theme={props.theme} running={!done()} icon={props.expanded ? "−" : "+"}
          color={props.theme.text.feedback.warning.base}
          label={`${done() ? "Thought" : "Thinking"}${title() && !props.expanded ? `: ${title()}` : ""}${done() && duration() ? ` · ${displayDuration(duration())}` : ""}`}
          onToggle={props.onToggle} />
        <Show when={props.expanded}>
          <box border={["left"]} customBorderChars={MESSAGE_BORDER} borderColor={props.theme.border.base} paddingLeft={1}>
            <code filetype="markdown" drawUnstyledText={false} streaming={!done()} syntaxStyle={syntax()}
              content={text()} conceal fg={props.theme.text.muted} />
          </box>
        </Show>
      </box>
    </Show>
  )
}
