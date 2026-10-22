/**
 * dsh-flowspot: where the selected data directory is remembered.
 *
 * The panel's "选择数据目录" button cannot rewrite the profile's cordis patch
 * (that is the host's business), so the choice is stored in one small pointer
 * file under DSH home. The runtime reads it on startup, which is why a change
 * needs a restart: the certificate authority and the flow file are opened once.
 *
 * The pointer also carries `copyFrom` — the directory whose certificate
 * authority must be carried over when the new one is created. The panel cannot
 * copy it itself (the running process still holds the old directory open), and
 * copying early would leave a private-key copy behind whenever the operator
 * changes their mind before restarting. The handover is one-shot: the next
 * start copies, then clears the field.
 *
 * Precedence: panel choice (this file) > plugin config `dataDir` > default
 * `$DSH_HOME/dsh-flowspot`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH home, matching the host's own resolution. */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Absolute path of the pointer file. */
export function locationFile() {
  return path.join(dshHome(), 'dsh-flowspot.location.json')
}

/**
 * The whole pointer: the chosen directory plus an optional pending CA handover.
 * @returns {{dataDir: string, copyFrom: string|null}|null}
 */
export function readPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(locationFile(), 'utf8'))
    const dataDir = raw && typeof raw.dataDir === 'string' ? raw.dataDir.trim() : ''
    if (!dataDir) return null
    const copyFrom = raw && typeof raw.copyFrom === 'string' && raw.copyFrom.trim() ? raw.copyFrom.trim() : null
    return { dataDir, copyFrom }
  } catch {
    return null
  }
}

/**
 * The directory chosen in the panel, or null when none was stored.
 * @returns {string|null}
 */
export function readLocation() {
  return readPointer()?.dataDir ?? null
}

/**
 * Remember a chosen directory. The value is stored as given; resolution of
 * `~` and relative paths happens where the directory is resolved.
 * @param {string} dataDir absolute or user-typed path
 * @param {{copyFrom?: string|null}} [options] directory to copy the CA from at the next start
 */
export function writeLocation(dataDir, { copyFrom = null } = {}) {
  const file = locationFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify({ dataDir, copyFrom: copyFrom || null, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

/** Drop the pending CA handover while keeping the chosen directory. */
export function clearCopyFrom() {
  const pointer = readPointer()
  if (!pointer || !pointer.copyFrom) return
  writeLocation(pointer.dataDir, { copyFrom: null })
}

/** Drop the stored choice (back to config, then default). */
export function clearLocation() {
  try {
    fs.unlinkSync(locationFile())
  } catch {
    /* already absent */
  }
}
