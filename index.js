/**
 * dsh-audit · 审计台
 *
 * Host half: static audit of installed (and not-yet-installed) plugins, a
 * low-overhead runtime monitor, and the JSON API the settings panel reads.
 *
 * Boundaries kept on purpose:
 *  - never imports or executes an audited plugin;
 *  - the pre-install face only *downloads* tarballs — nothing is unpacked to
 *    disk, installed, or run;
 *  - runtime observation is event-driven and bounded, with no polling.
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { RULES } from './lib/rules.js'
import { compactPlugin, renderPreinstallMarkdown, renderReportMarkdown } from './lib/report.js'
import { readInstalledBundle } from './lib/scan.js'
import { auditPreinstall } from './lib/preinstall.js'
import { RuntimeMonitor, classifyCall } from './lib/runtime.js'
import { AuditStore } from './lib/store.js'

export const name = 'dsh-audit'
export const inject = ['tools']

/**
 * Build a registry-ready tool definition without importing `@deepseek-ai/dsh-tools`.
 *
 * The desktop profile installs plugins with `autoInstallPeers: false`, so a
 * bare `import { defineTool } from '@deepseek-ai/dsh-tools'` makes the whole
 * bundle fail to activate (the host tree lives inside `app.asar`, which a plain
 * Node ESM import cannot reach). The registry itself only requires the shape
 * below — standard JSON Schema for `parameters`, and `output.render` — so this
 * local helper keeps the plugin dependency-free and loadable everywhere.
 * @param {object} definition
 * @returns {object} the definition unchanged, after the same sanity checks.
 */
function tool(definition) {
  const { name, description, parameters, output, execute } = definition
  if (typeof name !== 'string' || name === '') throw new TypeError('tool(): name is required')
  if (typeof description !== 'string' || description === '') throw new TypeError(`tool(${name}): description is required`)
  if (parameters?.type !== 'object' || typeof parameters.properties !== 'object') {
    throw new TypeError(`tool(${name}): parameters must be an object-rooted JSON Schema`)
  }
  if (typeof output?.render !== 'function' || output.schema === undefined) {
    throw new TypeError(`tool(${name}): output { schema, render } is required`)
  }
  if (typeof execute !== 'function') throw new TypeError(`tool(${name}): execute is required`)
  return definition
}

const SELF = 'dsh-audit'
const VERSION = '1.0.0'
/** Cordis FiberState: 0 PENDING, 1 LOADING, 2 ACTIVE, 3 FAILED, 4 DISPOSED, 5 UNLOADING. */
const ACTIVE = 2
const FAILED = 3

const DEFAULT_SETTINGS = {
  monitoring: true,
  recordSensitive: true,
  autoScanOnStart: true,
  exclude: [],
  preinstallRegistry: 'https://registry.npmjs.org/',
}

/** Resolve `$DSH_HOME`, falling back to `~/.dsh`. */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Read a JSON file, returning null on any failure. */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** Row ids disabled by a profile patch file. */
function disabledRows(patchText) {
  const ids = new Set()
  if (typeof patchText !== 'string' || patchText === '') return ids
  const lines = patchText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*-\s*id:\s*['"]?([A-Za-z0-9_.@/-]+)['"]?\s*$/.exec(lines[i])
    if (match === null) continue
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      if (/^\s*-\s*id:/.test(lines[j])) break
      if (/^\s*disabled:\s*true\s*$/.test(lines[j])) ids.add(match[1])
    }
  }
  return ids
}

/** Row ids a bundle's own patch declares. */
async function pluginRowIds(dir, pkg) {
  const patch = pkg?.dsh?.bundle?.patch
  const list = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
  const ids = []
  for (const file of list) {
    if (typeof file !== 'string') continue
    try {
      const text = await readFile(join(dir, file), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*-\s*id:\s*['"]?([A-Za-z0-9_.@/-]+)['"]?/.exec(line)
        if (match !== null) ids.push(match[1])
      }
    } catch {
      /* missing patch */
    }
  }
  return ids
}

/** Every profile directory that carries a package.json, newest first. */
async function listProfiles() {
  const root = join(dshHome(), 'profiles')
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const dir = join(root, entry.name)
    if ((await readJson(join(dir, 'package.json'))) !== null) out.push({ name: entry.name, dir })
  }
  return out
}

/** The module a fiber was loaded from, or '' for anonymous fibers. */
function pluginNameOf(fiber) {
  const entry = fiber?.entry
  const raw = entry?.options?.name ?? entry?.name ?? fiber?.runtime?.name
  if (typeof raw !== 'string' || raw === '') return ''
  if (raw.includes('/') || raw.includes('\\')) return basename(raw)
  return raw
}

/** Gate a JSON response: same-origin writes only. */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(config ?? {}) }
  const store = new AuditStore(join(dshHome(), 'dsh-audit'))
  /** @type {Map<string, { startedAt: number }>} */
  const inflight = new Map()
  /** @type {Array<object>} extra static rules registered through the API */
  const extraRules = []
  /** @type {Array<(event: object) => void>} */
  const subscribers = new Set()
  /** @type {object | null} */
  let lastScan = null
  let scanRunning = null
  let ready = false

  const emitEvent = (event) => {
    if (settings.monitoring !== true) return
    store.record(event)
    for (const listener of subscribers) {
      try {
        listener(event)
      } catch {
        /* a subscriber must not break the monitor */
      }
    }
  }

  const emitError = (error) => {
    store.recordError(error)
    for (const listener of subscribers) {
      try {
        listener({ type: 'error', ...error })
      } catch {
        /* ignore */
      }
    }
  }

  const monitor = new RuntimeMonitor({
    emit: emitEvent,
    error: emitError,
    pluginOf: pluginNameOf,
    toolNames: () => ctx.tools.schemas().map((schema) => schema.name),
  })

  /** Should this plugin be observed? Audit never watches itself or official packages. */
  const watched = (pluginName) => {
    if (pluginName === '' || pluginName === SELF) return false
    if (pluginName.startsWith('@deepseek-ai/')) return false
    if (Array.isArray(settings.exclude) && settings.exclude.includes(pluginName)) return false
    return true
  }

  /**
   * Scan every installed third-party plugin.
   * @param {{ profile?: string, plugin?: string }} [options]
   */
  async function scanInstalled(options = {}) {
    const profiles = await listProfiles()
    if (profiles.length === 0) return { items: [], profiles: [], selfSkipped: false }
    const selected = profiles.filter((profile) => !options.profile || profile.name === options.profile)
    /** @type {Map<string, any>} */
    const found = new Map()
    let selfSkipped = false

    for (const profile of selected) {
      const pkg = await readJson(join(profile.dir, 'package.json'))
      if (pkg === null) continue
      let patchText = ''
      try {
        patchText = await readFile(join(profile.dir, 'cordis.patch.yml'), 'utf8')
      } catch {
        /* no patch */
      }
      const disabled = disabledRows(patchText)
      const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
      const bundleSet = new Set(bundles.filter((item) => typeof item === 'string'))
      const deps = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : []
      const names = [...new Set([...bundles, ...deps].filter((item) => typeof item === 'string'))]
      for (const pluginName of names) {
        if (pluginName.startsWith('@deepseek-ai/')) continue
        if (pluginName === SELF) {
          selfSkipped = true
          continue
        }
        if (options.plugin && pluginName !== options.plugin) continue
        const dir = join(profile.dir, 'node_modules', ...pluginName.split('/'))
        const candidate = await readJson(join(dir, 'package.json'))
        if (candidate === null) continue
        const looksLikePlugin = bundleSet.has(pluginName) || candidate.dsh !== undefined || /(^|[-/])dsh/i.test(pluginName)
        if (!looksLikePlugin) continue
        let item = found.get(pluginName)
        if (item === undefined) {
          const rowIds = await pluginRowIds(dir, candidate)
          const enabled = !rowIds.some((id) => disabled.has(id))
          const analyzed = await readInstalledBundle(dir, { enabled, profiles: [profile.name], rowIds })
          if (analyzed === null) continue
          analyzed.rules = undefined
          item = compactPlugin(analyzed)
          found.set(pluginName, item)
        } else {
          item.profiles.push(profile.name)
          item.enabled = item.enabled || item.rowIds.every((id) => !disabled.has(id))
        }
      }
    }

    lastScan = {
      at: Date.now(),
      items: [...found.values()].sort((a, b) => a.score - b.score),
      profiles: selected.map((profile) => profile.name),
      selfSkipped,
    }
    await store.saveScan({ ...lastScan, items: lastScan.items.map((item) => ({ ...item, hosts: item.hosts.slice(0, 40) })) })
    return lastScan
  }

  /** Ensure a scan exists, scanning once when the cache is cold. */
  function ensureScan() {
    if (lastScan !== null) return Promise.resolve(lastScan)
    if (scanRunning === null) scanRunning = scanInstalled().finally(() => { scanRunning = null })
    return scanRunning
  }

  /** Public JSON state for the settings panel. */
  function state() {
    const items = lastScan?.items ?? []
    const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 }
    for (const item of items) counts[item.grade] = (counts[item.grade] ?? 0) + 1
    return {
      version: VERSION,
      settings,
      scan: lastScan === null ? null : { at: lastScan.at, profiles: lastScan.profiles, items, selfSkipped: lastScan.selfSkipped },
      counts,
      events: store.recent(200),
      errors: store.recentErrors(80),
      monitor: monitor.snapshot(),
      running: [...monitor.running.values()].map((record) => ({ plugin: record.name, entry: record.entry, startedAt: record.startedAt })),
    }
  }

  /** Trigger a scan, coalescing concurrent requests. */
  async function rescan(options = {}) {
    if (scanRunning !== null) await scanRunning
    scanRunning = scanInstalled(options).finally(() => { scanRunning = null })
    const result = await scanRunning
    emitEvent({ type: 'scan', at: Date.now(), plugins: result.items.length })
    return result
  }

  async function preinstall(target) {
    const packed = await auditPreinstall(target, { registry: settings.preinstallRegistry })
    const item = compactPlugin(packed.result)
    emitEvent({ type: 'preinstall', at: Date.now(), plugin: item.name, target, grade: item.grade, score: item.score })
    return { item, kind: packed.kind, source: packed.source, markdown: renderPreinstallMarkdown(packed) }
  }

  /** Seed plugins that were already running before this plugin loaded. */
  const seedRunning = () => {
    let entries = 0
    let active = 0
    let seeded = 0
    try {
      const loader = ctx.loader
      if (!loader || typeof loader.entries !== 'function') {
        store.record({ type: 'seed', at: Date.now(), detail: 'no loader service' })
        return
      }
      for (const entry of loader.entries()) {
        entries += 1
        if (entry.options?.group === true || entry.disabled === true) continue
        const fiber = entry.fiber
        if (!fiber) continue
        if (fiber.state === ACTIVE) active += 1
        if (!fiber || fiber.state !== ACTIVE) continue
        if (!watched(pluginNameOf(fiber))) continue
        monitor.start(fiber, true)
        seeded += 1
      }
      store.record({ type: 'seed', at: Date.now(), detail: `entries=${entries} active=${active} seeded=${seeded}` })
    } catch (error) {
      emitError({ at: Date.now(), source: 'seed', message: String(error?.message ?? error) })
    }
  }

  // ---------------------------------------------------------------- startup
  ctx.effect(() => {
    let disposed = false
    store.init().then(async () => {
      if (disposed) return
      ready = true
      const saved = await store.loadSettings(DEFAULT_SETTINGS)
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (saved[key] !== undefined) settings[key] = saved[key]
      }
      const cached = await store.loadScan()
      if (cached !== null && lastScan === null) lastScan = cached
      seedRunning()
      if (settings.autoScanOnStart === true) {
        const timer = setTimeout(() => {
          if (!disposed) rescan().catch((error) => emitError({ at: Date.now(), source: 'scan', message: String(error?.message ?? error) }))
        }, 1500)
        if (typeof timer.unref === 'function') timer.unref()
      }
    }).catch((error) => {
      emitError({ at: Date.now(), source: 'store', message: String(error?.message ?? error) })
    })
    return async () => {
      disposed = true
      await store.dispose()
    }
  }, 'dsh-audit store')

  // ------------------------------------------------------- runtime monitor
  if (settings.monitoring === true) {
    ctx.on(
      'internal/status',
      (fiber, oldState) => {
        try {
          if (fiber === ctx.fiber) return
          const state = fiber.state
          // Stop first: a dying fiber may already have lost its loader entry, so
          // the monitor matches it by object identity instead of by name.
          if (oldState === ACTIVE && state !== ACTIVE) {
            monitor.stop(fiber)
          } else if (state === ACTIVE && oldState !== ACTIVE) {
            const pluginName = pluginNameOf(fiber)
            if (watched(pluginName)) monitor.start(fiber)
          }
          if (state === FAILED) {
            const pluginName = pluginNameOf(fiber)
            if (pluginName === SELF || (Array.isArray(settings.exclude) && settings.exclude.includes(pluginName))) return
            monitor.failed(fiber, fiber._error)
          }
        } catch (error) {
          emitError({ at: Date.now(), source: 'monitor', message: String(error?.message ?? error) })
        }
      },
      { global: true },
    )

    ctx.on(
      'tools/pre-execute',
      (exec, next) => {
        try {
          if (settings.recordSensitive === true) {
            const info = monitor.beforeCall(exec.name, exec.arguments)
            if (info !== null) inflight.set(exec.callId ?? exec.name, { startedAt: info.startedAt })
          }
        } catch {
          /* never block a tool call because of the monitor */
        }
        return next()
      },
      { global: true },
    )

    ctx.on(
      'tools/result',
      (exec, result) => {
        try {
          if (settings.recordSensitive !== true) return
          const key = exec.callId ?? exec.name
          const startedAt = inflight.get(key)?.startedAt
          inflight.delete(key)
          monitor.afterCall(exec.name, exec.arguments, result, startedAt)
        } catch {
          /* ignore */
        }
      },
      { global: true },
    )

    ctx.on(
      'tools/change',
      () => {
        try {
          monitor.scheduleResync()
        } catch {
          /* ignore */
        }
      },
      { global: true },
    )

    ctx.on(
      'agent/error',
      (payload) => {
        try {
          const message = payload?.error instanceof Error ? payload.error.message : String(payload?.error ?? '')
          if (message !== '') emitError({ at: Date.now(), source: 'agent', message: message.slice(0, 400) })
        } catch {
          /* ignore */
        }
      },
      { global: true },
    )
  }

  ctx.on(
    'plugin-manager/changed',
    (change) => {
      try {
        emitEvent({ type: 'manager', at: Date.now(), detail: JSON.stringify(change ?? {}).slice(0, 400) })
      } catch {
        /* ignore */
      }
    },
    { global: true },
  )

  // ---------------------------------------------------------------- tools
  ctx.tools.register(
    tool({
      name: 'plugin_audit',
      description:
        '审计已安装的 DSH 插件：只读扫描 package.json/README/入口与源码，给出 S–D 分级、评分、数据去向、命令执行/凭据/外发/自启动证据与关闭建议。不联网、不执行被审计代码、不修改文件。',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: '只查某个 profile（如 desktop）；省略则查全部。' },
          plugin: { type: 'string', description: '只查某个包名（如 dshmarket）；省略则查全部第三方插件。' },
          detail: { type: 'boolean', description: '是否附网址清单，默认 true。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const profile = typeof args?.profile === 'string' ? args.profile.trim() : ''
        const plugin = typeof args?.plugin === 'string' ? args.plugin.trim() : ''
        const detail = args?.detail !== false
        const result = await scanInstalled({ profile, plugin })
        if (result.items.length === 0) {
          return plugin !== '' ? `未找到插件 "${plugin}"（或它不是已安装的第三方包）。` : '所选 profile 里没有已安装的第三方插件。'
        }
        return renderReportMarkdown({ items: result.items, home: dshHome(), profiles: result.profiles, selfSkipped: result.selfSkipped, detail })
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'plugin_audit_preinstall',
      description:
        '安装前审计：对一个尚未安装的插件做纯静态检查（本地目录 / .tgz / .tar.gz / npm 包名 / https tarball）。只读文本，不执行包内代码、不解压到磁盘，返回它会把数据发到哪里、读不读文件密钥、是否加密执行、安装期是否自动下载运行、装后是否自启动/外发，以及能不能装、装后关什么。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '本地目录、.tgz/.tar.gz 路径、npm 包名（如 dsh-audit@1.0.0）或 https tarball URL。' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const target = typeof args?.target === 'string' ? args.target.trim() : ''
        if (target === '') return '需要 target：本地目录 / 压缩包 / npm 包名 / https tarball。'
        try {
          const result = await preinstall(target)
          return result.markdown
        } catch (error) {
          return '安装前审计失败：' + String(error?.message ?? error)
        }
      },
    }),
  )

  // ------------------------------------------------------------- HTTP API
  ctx.inject(['webServer'], (inner) => {
    const json = (response, status, value) => {
      const body = JSON.stringify(value)
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
    }
    const readBody = (request) =>
      new Promise((resolve) => {
        let text = ''
        request.on('data', (chunk) => {
          text += chunk
          if (text.length > 2 * 1024 * 1024) request.destroy()
        })
        request.on('end', () => {
          try {
            resolve(text === '' ? {} : JSON.parse(text))
          } catch {
            resolve({})
          }
        })
        request.on('error', () => resolve({}))
      })

    const routes = [
      {
        kind: 'exact',
        path: '/dsh-audit/api/state',
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          await ensureScan().catch(() => null)
          json(response, 200, { ...state(), ready })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-audit/api/events',
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const limit = Math.min(600, Number(url.searchParams.get('limit') ?? '200') || 200)
          json(response, 200, {
            events: store.recent(limit, {
              type: url.searchParams.get('type') ?? '',
              plugin: url.searchParams.get('plugin') ?? '',
            }),
            errors: store.recentErrors(80),
          })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-audit/api/scan',
        handler: async (request, response) => {
          if (request.method !== 'POST' || !sameOrigin(request)) {
            json(response, 403, { error: 'forbidden' })
            return
          }
          const body = await readBody(request)
          try {
            const result = await rescan({ profile: typeof body.profile === 'string' ? body.profile : '' })
            json(response, 200, { ok: true, at: result.at, count: result.items.length })
          } catch (error) {
            json(response, 500, { error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-audit/api/preinstall',
        handler: async (request, response) => {
          if (request.method !== 'POST' || !sameOrigin(request)) {
            json(response, 403, { error: 'forbidden' })
            return
          }
          const body = await readBody(request)
          try {
            const result = await preinstall(String(body.target ?? ''))
            json(response, 200, { ok: true, ...result })
          } catch (error) {
            json(response, 400, { error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-audit/api/settings',
        handler: async (request, response) => {
          if (request.method !== 'POST' || !sameOrigin(request)) {
            json(response, 403, { error: 'forbidden' })
            return
          }
          const body = await readBody(request)
          const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
          for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (patch[key] !== undefined) settings[key] = patch[key]
          }
          await store.saveSettings(settings)
          json(response, 200, { ok: true, settings })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-audit/api/clear',
        handler: async (request, response) => {
          if (request.method !== 'POST' || !sameOrigin(request)) {
            json(response, 403, { error: 'forbidden' })
            return
          }
          store.events.length = 0
          store.errors.length = 0
          json(response, 200, { ok: true })
        },
      },
    ]

    const disposers = routes.map((route) => inner.webServer.register(route))
    inner.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-audit routes')
  })

  // ------------------------------------------------------- extension seam
  const api = {
    version: VERSION,
    /** Add a static rule for future scans. */
    registerRule(rule) {
      if (rule === null || typeof rule !== 'object' || typeof rule.id !== 'string' || !(rule.re instanceof RegExp)) {
        throw new Error('registerRule: { id, label, weight, re } required')
      }
      extraRules.push({ tag: 'custom', ...rule })
      RULES.push({ tag: 'custom', ...rule })
      return () => {
        const index = RULES.indexOf(rule)
        if (index >= 0) RULES.splice(index, 1)
      }
    },
    /** Subscribe to runtime events; returns an unsubscribe function. */
    onEvent(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    /** Record a custom event so other plugins can annotate the timeline. */
    record(event) {
      emitEvent({ at: Date.now(), ...event })
    },
    /** Record a custom error. */
    recordError(error) {
      emitError({ at: Date.now(), source: 'extension', ...error })
    },
    /** Rescan installed plugins. */
    scan: rescan,
    /** Audit one not-yet-installed target. */
    preinstall,
    /** Current snapshot. */
    state,
    /** The classified list of built-in sensitive rules. */
    classify: classifyCall,
  }
  ctx.provide('audit', api)
}
