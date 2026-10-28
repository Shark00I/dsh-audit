/**
 * A deliberately small tar reader used by the pre-install audit.
 *
 * npm packs plugins as gzipped tar. Reading them here means the auditor never
 * has to unpack to disk or run the system `tar`, so an inspected package can
 * never influence the machine through extraction paths, symlinks or device
 * entries: everything below stays in memory and only regular files are read.
 */
import { gunzipSync } from 'node:zlib'

const BLOCK = 512
/** Never inflate more than this much tar payload. */
export const MAX_TAR_BYTES = 48 * 1024 * 1024

function octal(buf, start, length) {
  let text = ''
  for (let i = start; i < start + length; i += 1) {
    const byte = buf[i]
    if (byte === 0 || byte === 0x20) {
      if (text !== '') break
      continue
    }
    text += String.fromCharCode(byte)
  }
  text = text.trim()
  return text === '' ? 0 : Number.parseInt(text, 8) || 0
}

function cString(buf, start, length) {
  let end = start
  while (end < start + length && buf[end] !== 0) end += 1
  return buf.toString('utf8', start, end)
}

/** Parse one pax extended-header body into key/value pairs. */
function parsePax(body) {
  const out = {}
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(body.toString('ascii', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = body.toString('utf8', space + 1, offset + length - 1)
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    offset += length
  }
  return out
}

/**
 * Read every regular file from a tar/gzip buffer.
 * @param {Buffer} input - raw `.tgz`, `.tar.gz` or `.tar` bytes.
 * @returns {{ files: Array<{ path: string, data: Buffer }>, truncated: boolean, total: number }}
 */
export function readTar(input) {
  let buf = input
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = gunzipSync(buf, { maxOutputLength: MAX_TAR_BYTES })
  }
  /** @type {Array<{ path: string, data: Buffer }>} */
  const files = []
  let offset = 0
  let truncated = false
  /** @type {string | null} */
  let pendingName = null
  let total = 0

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    const name = cString(header, 0, 100)
    const prefix = cString(header, 345, 155)
    const type = String.fromCharCode(header[156] || 0x30)
    const size = octal(header, 124, 12)
    const bodyStart = offset + BLOCK
    const bodyEnd = Math.min(bodyStart + size, buf.length)
    const body = buf.subarray(bodyStart, bodyEnd)

    if (type === 'x' || type === 'X') {
      const pax = parsePax(body)
      if (typeof pax.path === 'string') pendingName = pax.path
    } else if (type === 'L') {
      pendingName = cString(body, 0, Math.min(body.length, 4096))
    } else if (type === '0' || type === '\0') {
      const path = pendingName ?? (prefix === '' ? name : prefix + '/' + name)
      pendingName = null
      if (!path.endsWith('/')) {
        files.push({ path, data: Buffer.from(body) })
        total += body.length
        if (total > MAX_TAR_BYTES) {
          truncated = true
          break
        }
      }
    } else {
      pendingName = null
    }

    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK
    if (size === 0) offset = bodyStart
  }

  return { files, truncated, total }
}
