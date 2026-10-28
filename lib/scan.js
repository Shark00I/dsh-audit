/**
 * The static audit engine.
 *
 * It answers the six questions a user asks before installing a plugin:
 * where data goes, whether it reads files / keys / accounts, whether it
 * decodes and executes code, what runs at install time, whether it persists or
 * auto-starts, and whether it sends anything out. It only ever reads text: no
 * import, no execution, no network, no writes.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import {
  INSTALL_ACTIVE_RE,
  INSTALL_SCRIPT_KEYS,
  RULES,
  grade,
  isLocalHost,
} from './rules.js'

export const MAX_FILES = 400
export const MAX_FILE_BYTES = 1.5 * 1024 * 1024
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024

const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'assets', 'docs', 'coverage', '.github', '.idea', '.vscode', 'test', 'tests', '__tests__'])
const URL_RE = /https?:\/\/[^\s"'`()<>{}\[\]]+/g
const NET_RE = /\b(fetch|axios|request|https?\.(get|request)|WebSocket)\s*\(/
const WRITE_RE = /\b(POST|PUT|PATCH)\b/

/** Normalize Windows separators so reports use one spelling. */
export function toPosix(value) {
  return value.split(sep).join('/')
}

/** Collapse whitespace and cap length. */
export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** Resolve the package entry file declared by a manifest. */
export function entryOf(pkg) {
  if (typeof pkg.main === 'string' && pkg.main !== '') return pkg.main
  const exported = pkg.exports
  if (typeof exported === 'string') return exported
  if (exported !== null && typeof exported === 'object') {
    const dot = exported['.']
    if (typeof dot === 'string') return dot
    if (dot !== null && typeof dot === 'object') {
      for (const key of ['default', 'import', 'require', 'node']) {
        if (typeof dot[key] === 'string') return dot[key]
      }
    }
  }
  return 'index.js'
}

/** True when a line is prose (README-like) rather than executable code. */
function isDocLine(line) {
  const text = line.trim()
  if (text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')) return true
  if (text.length > 400) return false
  return text.includes('](') || text.includes('href') || text.includes('@see') || text.includes('<a ')
}

/** A line that is almost certainly minified or generated. */
function isMinified(line) {
  return line.length > 2000 && (line.match(/;/g) ?? []).length > 20
}

/**
 * Message bundles and translated copy trip keyword rules constantly (a locale
 * file mentioning `~/.ssh/config` is not a credential reader). They still get
 * URL extraction, but not the capability rules.
 */
function isProseFile(path, text) {
  if (/(^|\/)(locale|locales|i18n|lang|messages|translations)(\/|\.|-)/i.test(path)) return true
  const sample = text.slice(0, 20000)
  const nonAscii = (sample.match(/[^\x00-\x7f]/g) ?? []).length
  return sample.length > 4000 && nonAscii / sample.length > 0.18
}

/** Bundled installer scripts are expected to mention services and restarts. */
function isInstallerFile(path) {
  return /(^|\/)(install|setup|postinstall)[^/]*\.(ps1|sh|bash|cmd)$/i.test(path)
}

function addHost(state, host, sample, kind) {
  if (host === '' || !host.includes('.') || isLocalHost(host) || host.endsWith('.example')) return
  let entry = state.hosts.get(host)
  if (entry === undefined) {
    entry = { host, count: 0, endpoints: 0, docs: 0, sample: '', declared: false }
    state.hosts.set(host, entry)
  }
  entry.count += 1
  if (kind === 'endpoint') {
    entry.endpoints += 1
    if (entry.sample === '') entry.sample = sample
  } else {
    entry.docs += 1
  }
}

/**
 * Analyze one bundle given its already-read files.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} [input.version]
 * @param {string} [input.description]
 * @param {string} [input.dir] - on-disk location, when installed
 * @param {boolean} [input.official]
 * @param {boolean} [input.enabled]
 * @param {string[]} [input.profiles]
 * @param {string[]} [input.rowIds]
 * @param {string} [input.readmeName]
 * @param {string} [input.readmeText]
 * @param {Array<{ path: string, text: string }>} [input.files]
 * @param {object} [input.pkg] - parsed package.json
 * @param {boolean} [input.truncated]
 */
export function analyzeBundle(input) {
  const pkg = input.pkg ?? {}
  const scripts = pkg.scripts !== null && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  const installScripts = INSTALL_SCRIPT_KEYS.filter((key) => typeof scripts[key] === 'string')
  const installActive = installScripts.some((key) => INSTALL_ACTIVE_RE.test(scripts[key]))
  const prepare = typeof scripts.prepare === 'string'

  const state = {
    name: input.name,
    version: typeof input.version === 'string' ? input.version : typeof pkg.version === 'string' ? pkg.version : '',
    description: typeof input.description === 'string' ? input.description : typeof pkg.description === 'string' ? pkg.description : '',
    dir: input.dir ?? '',
    official: input.official === true || input.name.startsWith('@deepseek-ai/'),
    enabled: input.enabled !== false,
    profiles: input.profiles ?? [],
    rowIds: input.rowIds ?? [],
    readme: input.readmeName ?? '',
    entry: entryOf(pkg),
    files: input.files?.length ?? 0,
    bytes: 0,
    hosts: new Map(),
    declaredHosts: new Set(),
    hits: new Map(),
    urls: [],
    installScripts,
    installActive,
    prepare,
    postExternal: false,
    native: false,
    truncated: input.truncated === true,
    repo: typeof pkg.repository === 'string' ? pkg.repository : typeof pkg.repository?.url === 'string' ? pkg.repository.url : '',
    license: typeof pkg.license === 'string' ? pkg.license : '',
    maxLine: 0,
  }

  // Hosts mentioned in prose are "declared" destinations; a host that only
  // appears in code and nowhere in the README is worth flagging.
  const readmeText = input.readmeText ?? ''
  if (readmeText !== '') {
    URL_RE.lastIndex = 0
    for (const match of readmeText.matchAll(URL_RE)) {
      try {
        const host = new URL(match[0].replace(/[),.;]+$/u, '')).hostname.toLowerCase()
        if (host !== '') state.declaredHosts.add(host)
      } catch {
        /* not a URL */
      }
    }
  }

  for (const file of input.files ?? []) {
    if (state.bytes >= MAX_TOTAL_BYTES) {
      state.truncated = true
      break
    }
    const text = file.text
    state.bytes += Buffer.byteLength(text, 'utf8')
    const lines = text.split(/\r?\n/)
    const prose = isProseFile(file.path, text)
    const installer = isInstallerFile(file.path)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.length > state.maxLine) state.maxLine = line.length
      const sample = file.path + ':' + String(i + 1) + '  ' + clip(line, 150)
      const windowText = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n')
      const doc = isDocLine(line)
      const minified = isMinified(line)
      const netContext = !doc && NET_RE.test(windowText)

      if (line.includes('http')) {
        URL_RE.lastIndex = 0
        for (const match of line.matchAll(URL_RE)) {
          let url = match[0].replace(/[),.;]+$/u, '')
          if (url.length > 300) url = url.slice(0, 300)
          let host = ''
          try {
            host = new URL(url).hostname.toLowerCase()
          } catch {
            continue
          }
          if (state.urls.length < 800) {
            state.urls.push({ url, host, kind: netContext ? 'endpoint' : 'doc', file: file.path })
          }
          addHost(state, host, url, netContext ? 'endpoint' : 'doc')
        }
      }

      if (doc || minified || prose) continue

      for (const rule of RULES) {
        if (rule.id === 'persist' && installer) continue
        if (!rule.re.test(line)) continue
        let entry = state.hits.get(rule.id)
        if (entry === undefined) {
          entry = { id: rule.id, label: rule.label, tag: rule.tag, weight: rule.weight, count: 0, samples: [] }
          state.hits.set(rule.id, entry)
        }
        entry.count += 1
        if (entry.samples.length < 3) entry.samples.push(sample)
      }

      if (netContext && WRITE_RE.test(windowText) && state.hosts.size > 0) state.postExternal = true
    }
  }

  for (const host of state.declaredHosts) {
    const entry = state.hosts.get(host)
    if (entry !== undefined) entry.declared = true
  }

  const score = scoreOf(state)
  const gradeRow = grade(score)
  const undeclaredHosts = [...state.hosts.values()].filter((host) => !host.declared).map((host) => host.host)
  return {
    ...state,
    hosts: [...state.hosts.values()].sort((a, b) => b.endpoints - a.endpoints || b.count - a.count),
    hits: [...state.hits.values()],
    urls: state.urls,
    declaredHosts: [...state.declaredHosts],
    score,
    grade: gradeRow.grade,
    gradeLabel: gradeRow.label,
    tone: gradeRow.tone,
    advice: adviceOf({ ...state, undeclaredHosts }, gradeRow),
    undeclaredHosts,
    scannedAt: Date.now(),
  }
}

/** Turn evidence into a 0–100 score. Ranking only; never a security proof. */
export function scoreOf(state) {
  let score = 100
  for (const hit of state.hits.values()) score -= hit.weight
  const hasNetwork = state.hosts.size > 0
  const hasCredentials = state.hits.has('credentials')
  if (hasNetwork && hasCredentials) score -= 4
  if (state.postExternal) score -= 10
  if (state.installScripts.length > 0) score -= 10
  if (state.installActive) score -= 10
  if (state.hits.has('decode') && (state.hits.has('eval') || state.hits.has('exec'))) score -= 8
  if (state.maxLine > 20000) score -= 4
  if (state.bytes > 5 * 1024 * 1024) score -= 2
  return Math.max(0, Math.min(100, score))
}

/** Human advice for one analyzed bundle. */
export function adviceOf(state, gradeRow) {
  const advice = []
  if (state.hits.has('exec')) advice.push('不需要“安装/更新/终端”能力时，关掉它的写操作入口；它执行的是本机命令。')
  if (state.hits.has('credentials')) advice.push('不要给它长期主账号密钥；用单独的低额度 key，或只允许它读宿主凭据服务。')
  if (state.hits.has('eval')) advice.push('存在 eval / new Function：属于可执行任意字符串代码的形态，除非信任作者，否则不要装。')
  if (state.installScripts.length > 0) advice.push('安装时用 --ignore-scripts（或让 pnpm 拒绝 build），先看清安装脚本再放行。')
  if (state.installActive) advice.push('安装脚本里出现下载/执行命令：放行前逐字读一遍。')
  if (state.hits.has('persist')) advice.push('检查系统自启动项；不需要常驻就删掉 Run / LaunchAgents / systemd 项。')
  if (state.hits.has('server')) advice.push('确认本地服务只监听 127.0.0.1；不要把它的端口暴露到局域网。')
  if (state.postExternal) advice.push('存在向外部地址 POST 的路径：先在设置里关掉同步/上传/遥测，再用抓包复核。')
  if (state.undeclaredHosts?.length > 0) advice.push('代码里出现 README 未声明的域名：出现陌生域名就停用。')
  if (state.hits.has('native')) advice.push('含原生模块：安装会编译，且二进制行为静态看不到。')
  if (advice.length === 0) advice.push(gradeRow.advice)
  return advice
}

/**
 * Read an installed bundle from disk.
 * @param {string} dir package directory
 * @param {{ enabled?: boolean, profiles?: string[], rowIds?: string[] }} [meta]
 */
export async function readInstalledBundle(dir, meta = {}) {
  let pkg = {}
  try {
    const text = await readFile(join(dir, 'package.json'), 'utf8')
    pkg = JSON.parse(text)
  } catch {
    return null
  }
  const files = []
  let readmeName = ''
  let readmeText = ''
  for (const candidate of ['README.zh.md', 'README_ZH.md', 'README.md', 'readme.md']) {
    try {
      readmeText = await readFile(join(dir, candidate), 'utf8')
      readmeName = candidate
      break
    } catch {
      /* next candidate */
    }
  }

  const entry = entryOf(pkg)
  const entryPath = join(dir, entry)
  const queue = [dir]
  let visited = 0
  while (queue.length > 0 && files.length < MAX_FILES && visited < 4000) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of entries) {
      visited += 1
      if (item.isSymbolicLink()) continue
      const full = join(current, item.name)
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) queue.push(full)
        continue
      }
      if (!item.isFile()) continue
      const rel = toPosix(relative(dir, full))
      if (rel.endsWith('.map') || rel.endsWith('.d.ts')) continue
      if (!SCAN_EXT.has(extname(item.name).toLowerCase())) continue
      if (files.length >= MAX_FILES) break
      try {
        const info = await stat(full)
        if (info.size > MAX_FILE_BYTES) continue
        const text = await readFile(full, 'utf8')
        files.push({ path: rel, text })
      } catch {
        /* unreadable file */
      }
      if (files.length >= MAX_FILES) break
    }
  }
  // The package entry is scanned even when the walk skipped its extension.
  if (files.length < MAX_FILES && !files.some((file) => file.path === toPosix(entry))) {
    try {
      const text = await readFile(entryPath, 'utf8')
      if (Buffer.byteLength(text, 'utf8') <= MAX_FILE_BYTES) files.unshift({ path: toPosix(entry), text })
    } catch {
      /* no entry file */
    }
  }

  return analyzeBundle({
    name: typeof pkg.name === 'string' ? pkg.name : dir,
    pkg,
    dir,
    readmeName,
    readmeText,
    files,
    enabled: meta.enabled !== false,
    profiles: meta.profiles ?? [],
    rowIds: meta.rowIds ?? [],
    truncated: files.length >= MAX_FILES,
  })
}

/** Analyze an in-memory file map (tarball or npm pack). */
export function readVirtualBundle(files, pkgText, meta = {}) {
  let pkg = {}
  if (typeof pkgText === 'string') {
    try {
      pkg = JSON.parse(pkgText)
    } catch {
      pkg = {}
    }
  }
  let readmeName = ''
  let readmeText = ''
  const codeFiles = []
  for (const file of files) {
    const path = file.path
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (readmeText === '' && /^README(\.[A-Za-z_-]+)?\.md$/i.test(base)) {
      readmeName = base
      readmeText = file.text
      continue
    }
    if (path.endsWith('.map') || path.endsWith('.d.ts')) continue
    if (!SCAN_EXT.has(extname(base).toLowerCase())) continue
    if (codeFiles.length >= MAX_FILES) continue
    if (Buffer.byteLength(file.text, 'utf8') > MAX_FILE_BYTES) continue
    codeFiles.push({ path: path.replace(/^[^/]*\//, ''), text: file.text })
  }
  return analyzeBundle({
    name: meta.name ?? (typeof pkg.name === 'string' ? pkg.name : ''),
    version: meta.version,
    pkg,
    readmeName,
    readmeText,
    files: codeFiles,
    enabled: true,
    profiles: [],
    rowIds: [],
    truncated: codeFiles.length >= MAX_FILES,
  })
}
