/**
 * Bounded local persistence.
 *
 * Runtime events are written as JSONL with a batched flush, rotated at a fixed
 * size, and read back only from the tail on startup. The point is that a busy
 * machine never pays for audit I/O in proportion to how much happens: at most
 * one append per flush window, and the recent window is always in memory.
 */
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_EVENT_FILE = 5 * 1024 * 1024
const TAIL_BYTES = 256 * 1024
const RING_SIZE = 600
const FLUSH_DELAY_MS = 3000
const FLUSH_BATCH = 80

/** Read the last bytes of a file as complete UTF-8 lines. */
async function readTailLines(file, maxBytes) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return []
  }
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    if (length <= 0) return []
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    const lines = buf.toString('utf8').split(/\r?\n/)
    // A tail read can cut the first line in half.
    if (start > 0) lines.shift()
    const out = []
    for (const line of lines) {
      const text = line.trim()
      if (text === '') continue
      try {
        out.push(JSON.parse(text))
      } catch {
        /* torn line */
      }
    }
    return out
  } finally {
    await handle.close().catch(() => {})
  }
}

export class AuditStore {
  constructor(dir) {
    this.dir = dir
    this.eventsFile = join(dir, 'events.jsonl')
    this.rotatedFile = join(dir, 'events.1.jsonl')
    this.errorsFile = join(dir, 'errors.jsonl')
    this.settingsFile = join(dir, 'settings.json')
    this.scanFile = join(dir, 'scan.json')
    /** @type {object[]} */
    this.events = []
    /** @type {object[]} */
    this.errors = []
    /** @type {object[]} */
    this.pendingEvents = []
    /** @type {object[]} */
    this.pendingErrors = []
    this.timer = null
    this.flushing = null
    this.ready = false
  }

  async init() {
    await mkdir(this.dir, { recursive: true })
    const [events, errors] = await Promise.all([
      readTailLines(this.eventsFile, TAIL_BYTES),
      readTailLines(this.errorsFile, TAIL_BYTES),
    ])
    this.events = events.slice(-RING_SIZE)
    this.errors = errors.slice(-RING_SIZE)
    this.ready = true
    return this
  }

  /** Push one runtime event into the ring and the write queue. */
  record(event) {
    this.events.push(event)
    if (this.events.length > RING_SIZE) this.events.splice(0, this.events.length - RING_SIZE)
    this.pendingEvents.push(event)
    this.schedule()
  }

  /** Push one error into the ring and the write queue. */
  recordError(error) {
    this.errors.push(error)
    if (this.errors.length > RING_SIZE) this.errors.splice(0, this.errors.length - RING_SIZE)
    this.pendingErrors.push(error)
    this.schedule()
  }

  schedule() {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => {})
    }, FLUSH_DELAY_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async flush() {
    if (this.flushing !== null) {
      await this.flushing
      return
    }
    this.flushing = this.writeQueues().finally(() => {
      this.flushing = null
    })
    await this.flushing
  }

  async writeQueues() {
    if (this.pendingEvents.length > 0) {
      const batch = this.pendingEvents
      this.pendingEvents = []
      await this.rotateIfNeeded()
      await appendFile(this.eventsFile, batch.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8').catch(() => {})
    }
    if (this.pendingErrors.length > 0) {
      const batch = this.pendingErrors
      this.pendingErrors = []
      await appendFile(this.errorsFile, batch.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8').catch(() => {})
    }
  }

  async rotateIfNeeded() {
    try {
      const info = await stat(this.eventsFile)
      if (info.size < MAX_EVENT_FILE) return
      await rename(this.eventsFile, this.rotatedFile).catch(() => {})
    } catch {
      /* no file yet */
    }
  }

  /** Recent events, newest last, optionally filtered. */
  recent(limit = 200, filter = {}) {
    let list = this.events
    if (typeof filter.type === 'string' && filter.type !== '') list = list.filter((item) => item.type === filter.type)
    if (typeof filter.plugin === 'string' && filter.plugin !== '') list = list.filter((item) => item.plugin === filter.plugin)
    return list.slice(-limit)
  }

  /** Recent errors, newest last. */
  recentErrors(limit = 100) {
    return this.errors.slice(-limit)
  }

  async loadSettings(fallback) {
    try {
      const text = await readFile(this.settingsFile, 'utf8')
      const parsed = JSON.parse(text)
      return { ...fallback, ...parsed }
    } catch {
      return { ...fallback }
    }
  }

  async saveSettings(settings) {
    await writeFile(this.settingsFile, JSON.stringify(settings, null, 2), 'utf8').catch(() => {})
  }

  async loadScan() {
    try {
      const text = await readFile(this.scanFile, 'utf8')
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  async saveScan(scan) {
    await writeFile(this.scanFile, JSON.stringify(scan), 'utf8').catch(() => {})
  }

  /** Flush and release timers. */
  async dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush().catch(() => {})
    if (this.pendingEvents.length > 0 || this.pendingErrors.length > 0) {
      await this.writeQueues().catch(() => {})
    }
  }
}
