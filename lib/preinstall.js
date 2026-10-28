/**
 * Pre-install audit.
 *
 * Accepts a local directory, a local `.tgz` / `.tar.gz`, an https tarball URL,
 * or an npm package spec. Remote input is only ever *downloaded*: nothing from
 * it is imported, extracted to disk, or executed, so a hostile package cannot
 * act through this path. Files are filtered exactly like the installed-plugin
 * scanner and then handed to the same analyzer.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { readTar } from './tar.js'
import { readInstalledBundle, readVirtualBundle } from './scan.js'

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 45_000
const PKG_SPEC_RE = /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)?(@[^\s/]+)?$/

/** Split `name@version` without breaking a scoped `@scope/name`. */
export function splitSpec(spec) {
  const text = spec.trim()
  const at = text.lastIndexOf('@')
  if (at > 0) return { name: text.slice(0, at), version: text.slice(at + 1) }
  return { name: text, version: '' }
}

async function fetchBytes(url, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.5' },
    })
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`${label}: too large (${declared} bytes)`)
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`${label}: too large (${buf.length} bytes)`)
    return { buf, finalUrl: response.url || url }
  } finally {
    clearTimeout(timer)
  }
}

async function resolveNpmTarball(spec, registry) {
  const { name, version } = splitSpec(spec)
  const metaUrl = registry.replace(/\/+$/, '') + '/' + name.replace('/', '%2F')
  const { buf } = await fetchBytes(metaUrl, `registry ${name}`)
  let meta
  try {
    meta = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error(`registry ${name}: malformed metadata`)
  }
  const wanted = version === '' ? meta['dist-tags']?.latest : version
  const picked = wanted !== undefined ? meta.versions?.[wanted] : undefined
  if (picked === undefined) {
    throw new Error(`registry ${name}: version ${version || '(latest)'} not found`)
  }
  const tarball = picked.dist?.tarball
  if (typeof tarball !== 'string') throw new Error(`registry ${name}: no tarball URL`)
  return { name, version: picked.version ?? wanted, tarball, meta }
}

function looksLikeUrl(target) {
  return /^https?:\/\//i.test(target)
}

/** Read a directory's files through the installed-bundle reader, marked uninstalled. */
async function fromDirectory(dir) {
  const result = await readInstalledBundle(resolve(dir), { enabled: false })
  if (result === null) throw new Error(`not a package directory (no package.json): ${dir}`)
  return { kind: 'directory', source: resolve(dir), result }
}

function fromTarBytes(bytes, label) {
  const { files, truncated } = readTar(bytes)
  const pkgEntry = files.find((file) => file.path === 'package/package.json' || file.path === 'package.json')
  const texts = files.map((file) => ({
    path: file.path.replace(/^package\//, ''),
    text: file.data.toString('utf8'),
  }))
  const result = readVirtualBundle(texts, pkgEntry?.data.toString('utf8'), {})
  result.truncated = result.truncated || truncated
  return { kind: 'archive', source: label, result }
}

/**
 * Audit one pre-install target.
 * @param {string} target local path, file, URL, or npm spec
 * @param {{ registry?: string }} [options]
 */
export async function auditPreinstall(target, options = {}) {
  const text = String(target ?? '').trim()
  if (text === '') throw new Error('target is required')
  const registry = options.registry ?? 'https://registry.npmjs.org/'

  if (looksLikeUrl(text)) {
    if (!/^https:\/\//i.test(text) && !/^http:\/\/127\.0\.0\.1/i.test(text)) {
      throw new Error('only https tarball URLs are accepted')
    }
    const { buf } = await fetchBytes(text, 'tarball')
    return fromTarBytes(buf, text)
  }

  let info = null
  try {
    info = await stat(resolve(text))
  } catch {
    info = null
  }
  if (info !== null) {
    if (info.isDirectory()) return fromDirectory(text)
    if (info.isFile()) {
      if (!/\.(tgz|tar\.gz|tar)$/i.test(text)) throw new Error('only .tgz / .tar.gz / .tar archives are accepted')
      return fromTarBytes(await readFile(resolve(text)), resolve(text))
    }
    throw new Error('unsupported path')
  }

  if (!PKG_SPEC_RE.test(text)) {
    throw new Error(`not a path, archive, URL or package spec: ${basename(text)}`)
  }
  const resolved = await resolveNpmTarball(text, registry)
  const { buf } = await fetchBytes(resolved.tarball, `tarball ${resolved.name}`)
  const packed = fromTarBytes(buf, resolved.tarball)
  packed.result.name = resolved.name
  packed.result.version = resolved.version
  packed.kind = 'npm'
  return packed
}
