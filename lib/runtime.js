/**
 * Runtime observation.
 *
 * Three facts are worth recording while plugins run, and nothing else:
 * when one starts and stops, which sensitive operations its tools perform, and
 * how much model token those tool calls cost. Everything is event-driven and
 * bounded: one Map per running plugin, one bounded ring of recent events, and
 * regex work only for calls that already look sensitive. No polling, no file
 * watching, no timers beyond the batched flush in the store.
 */

/** Token heuristic shared with dsh-token-meter: four characters per token. */
export function estimateTokens(value) {
  if (value === null || value === undefined) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return 0
  return Math.ceil(text.length / 4)
}

/** Command patterns that turn a shell tool call into a sensitive event. */
const SHELL_RULES = [
  { kind: 'delete', label: '删除文件', re: /\b(Remove-Item|rmdir|del\s|erase\s|rm\s+-[rf]|rm\s+|rd\s+\/s|unlink|git\s+clean)\b/i },
  { kind: 'write', label: '写入文件', re: /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|tee\s|>\s*[^\s|])\b/i },
  { kind: 'exec', label: '运行程序', re: /\b(Start-Process|Invoke-Expression|iex\s|&\s*\S+\.(exe|cmd|bat|ps1)|node\s+-e|python\s+-c|powershell|pwsh\s+-c)\b/i },
  { kind: 'network', label: '网络外发', re: /\b(Invoke-WebRequest|Invoke-RestMethod|curl\s|wget\s|npm\s+publish|git\s+push)\b/i },
  { kind: 'credential', label: '读取凭据', re: /(\.ssh|id_rsa|\.aws|\.npmrc|\.env\b|token|password|credential|secret)/i },
]

/** Map a DSH tool name to the action family it belongs to. */
export function toolFamily(name) {
  if (name === 'pwsh' || name === 'bash' || name === 'terminal' || name.startsWith('terminal_') || name.startsWith('job_')) {
    return 'shell'
  }
  if (name === 'write' || name === 'edit') return 'file-write'
  if (name === 'plugin_manager') return 'plugin-manage'
  if (name === 'web_fetch' || name === 'web_search') return 'network'
  if (name === 'present') return 'deliverable'
  return 'other'
}

/** Extract the text a shell tool is about to run. */
function shellText(args) {
  if (typeof args?.command === 'string') return args.command
  if (typeof args?.script === 'string') return args.script
  if (Array.isArray(args?.command)) return args.command.join(' ')
  return ''
}

/**
 * Classify one tool call. Returns null for calls that are not worth recording.
 * @param {string} name
 * @param {any} args
 */
export function classifyCall(name, args) {
  const family = toolFamily(name)
  if (family === 'shell') {
    const text = shellText(args)
    if (text === '') return null
    for (const rule of SHELL_RULES) {
      if (rule.re.test(text)) return { kind: rule.kind, label: rule.label, detail: text }
    }
    return null
  }
  if (family === 'file-write') {
    const target = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : ''
    return { kind: 'write', label: name === 'write' ? '写入文件' : '编辑文件', detail: target }
  }
  if (family === 'plugin-manage') {
    const action = typeof args?.action === 'string' ? args.action : ''
    const target = typeof args?.target === 'string' ? args.target : ''
    return { kind: 'install', label: '插件管理', detail: action + (target === '' ? '' : ' ' + target) }
  }
  if (family === 'network') {
    const target = typeof args?.url === 'string' ? args.url : Array.isArray(args?.queries) ? args.queries.join(' | ') : ''
    return { kind: 'network', label: '网络访问', detail: target }
  }
  return null
}

/** Stable identity for one loader entry / fiber. */
export function fiberIdentity(fiber) {
  const entry = fiber?.entry
  const name = entry?.options?.name ?? entry?.name ?? fiber?.runtime?.name ?? fiber?.name
  const id = entry?.options?.id ?? entry?.id ?? ''
  return { name: typeof name === 'string' ? name : '', id: typeof id === 'string' ? id : '' }
}

/** The live runtime monitor owned by the plugin. */
export class RuntimeMonitor {
  /**
   * @param {object} options
   * @param {(event: object) => void} options.emit - called for each recorded event
   * @param {(error: object) => void} options.error - called for runtime errors
   * @param {(fiber: any) => string} options.pluginOf - resolve a plugin name
   * @param {() => string[]} options.toolNames - current global tool names
   * @param {(name: string) => void} [options.onSensitive]
   */
  constructor(options) {
    this.options = options
    /** @type {Map<string, { name: string, entry: string, startedAt: number, toolsBefore: Set<string> }>} */
    this.running = new Map()
    /** @type {Map<string, string>} tool name -> plugin name */
    this.toolOwner = new Map()
    /** @type {Map<string, { calls: number, tokens: number, sensitive: number }>} */
    this.totals = new Map()
    /** @type {Set<string>} tools seen in the last full snapshot */
    this.knownTools = new Set()
    /** @type {string[]} plugins activated recently, newest last */
    this.recent = []
    /** @type {Map<string, { name: string, args: any, startedAt: number }>} in-flight sensitive calls */
    this.pending = new Map()
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.resyncTimer = null
    /** Whether the initial tool snapshot has been recorded. */
    this.baseline = false
  }

  key(name, entry) {
    return name + '#' + entry
  }

  /** Record a plugin entering ACTIVE. `silent` seeds an already-running plugin. */
  start(fiber, silent = false) {
    const { name, id } = fiberIdentity(fiber)
    if (name === '') return
    const key = this.key(name, id)
    if (this.running.has(key)) return
    this.running.set(key, { name, entry: id, startedAt: Date.now(), fiber, toolsBefore: new Set(this.knownTools) })
    this.recent = [...this.recent.filter((item) => item !== key), key].slice(-8)
    if (!silent) this.options.emit({ type: 'plugin.start', at: Date.now(), plugin: name, entry: id })
    this.scheduleResync()
  }

  /** Record a plugin leaving ACTIVE. Works even after the fiber forgot its entry. */
  stop(fiber) {
    let record
    for (const item of this.running.values()) {
      if (item.fiber === fiber) {
        record = item
        break
      }
    }
    if (record === undefined) {
      const { name, id } = fiberIdentity(fiber)
      if (name !== '') record = this.running.get(this.key(name, id))
    }
    if (record === undefined) return
    const key = this.key(record.name, record.entry)
    this.running.delete(key)
    const at = Date.now()
    this.options.emit({
      type: 'plugin.stop',
      at,
      plugin: record.name,
      entry: record.entry,
      ms: at - record.startedAt,
    })
    this.scheduleResync()
  }

  /**
   * Rebuild tool attribution after the registry settles. A fiber that is still
   * unloading has not released its tools yet, so this waits instead of racing.
   */
  scheduleResync(delay = 500) {
    if (this.resyncTimer !== null) return
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null
      this.resync().catch(() => {})
    }, delay)
    if (typeof this.resyncTimer.unref === 'function') this.resyncTimer.unref()
  }

  /** Record a failed activation. */
  failed(fiber, error) {
    const { name, id } = fiberIdentity(fiber)
    this.options.error({
      at: Date.now(),
      source: 'plugin',
      plugin: name === '' ? '(unknown)' : name,
      entry: id,
      message: error instanceof Error ? error.message : String(error ?? 'plugin failed to load'),
    })
  }

  /**
   * Rebuild the tool -> plugin attribution from the live registry.
   * Cheap: one schema listing per plugin lifecycle change. The first call only
   * records the baseline, because tools that already existed cannot be
   * attributed to whichever plugin happened to activate first.
   */
  async resync() {
    const names = new Set(this.options.toolNames())
    if (!this.baseline) {
      this.baseline = true
      this.knownTools = names
      return
    }
    const added = [...names].filter((name) => !this.knownTools.has(name))
    const removed = [...this.knownTools].filter((name) => !names.has(name))
    if (added.length > 0) {
      const newest = this.recent[this.recent.length - 1]
      const owner = newest === undefined ? '' : (this.running.get(newest)?.name ?? '')
      for (const name of added) if (owner !== '') this.toolOwner.set(name, owner)
    }
    for (const name of removed) this.toolOwner.delete(name)
    this.knownTools = names
  }

  /** Record the start of one tool call; returns nothing when uninteresting. */
  beforeCall(name, args) {
    const info = classifyCall(name, args)
    if (info === null) return null
    const startedAt = Date.now()
    this.pending.set(name, { name, args, startedAt })
    return { ...info, startedAt, plugin: this.toolOwner.get(name) ?? '' }
  }

  /** Record the end of one tool call and price it. */
  afterCall(name, args, result, startedAt) {
    const info = classifyCall(name, args)
    if (info === null) return null
    const at = Date.now()
    const plugin = this.toolOwner.get(name) ?? ''
    const inputTokens = estimateTokens(args)
    const outputTokens = estimateTokens(textOfResult(result))
    const tokens = inputTokens + outputTokens
    const entry = this.totals.get(plugin) ?? { calls: 0, tokens: 0, sensitive: 0 }
    entry.calls += 1
    entry.tokens += tokens
    entry.sensitive += 1
    this.totals.set(plugin, entry)
    const event = {
      type: 'sensitive',
      at,
      plugin,
      tool: name,
      kind: info.kind,
      label: info.label,
      detail: String(info.detail ?? '').slice(0, 400),
      tokens,
      ms: startedAt === undefined ? 0 : at - startedAt,
      ok: result === undefined ? true : !isFailure(result),
    }
    this.pending.delete(name)
    this.options.emit(event)
    return event
  }

  /** Record an error that came from a session or a tool, not a plugin load. */
  error(source, message, extra = {}) {
    this.options.error({ at: Date.now(), source, message: String(message ?? ''), ...extra })
  }

  /** Snapshot for the UI and for the store. */
  snapshot() {
    return {
      running: [...this.running.values()].map((record) => ({
        plugin: record.name,
        entry: record.entry,
        startedAt: record.startedAt,
      })),
      totals: [...this.totals.entries()].map(([plugin, value]) => ({ plugin, ...value })),
      toolOwners: this.toolOwner.size,
    }
  }
}

/** Flatten a tool result into text for token estimation. */
export function textOfResult(result) {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result?.content)) {
    return result.content
      .map((block) => (typeof block?.text === 'string' ? block.text : typeof block === 'string' ? block : ''))
      .join('\n')
  }
  if (typeof result?.content === 'string') return result.content
  try {
    return JSON.stringify(result)
  } catch {
    return ''
  }
}

/** Whether a tool result is a structured failure. */
export function isFailure(result) {
  if (result === null || result === undefined) return false
  if (result.isError === true) return true
  if (typeof result.error === 'string' && result.error !== '') return true
  return false
}
