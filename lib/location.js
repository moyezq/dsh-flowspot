/**
 * dsh-flowspot: where the selected data directory is remembered.
 *
 * The panel's "选择数据目录" button cannot rewrite the profile's cordis patch
 * (that is the host's business), so the choice is stored in one small pointer
 * file under DSH home. The runtime reads it on startup, which is why a change
 * needs a restart: the certificate authority and the flow file are opened once.
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
 * The directory chosen in the panel, or null when none was stored.
 * @returns {string|null}
 */
export function readLocation() {
  try {
    const raw = JSON.parse(fs.readFileSync(locationFile(), 'utf8'))
    const dir = raw && typeof raw.dataDir === 'string' ? raw.dataDir.trim() : ''
    return dir || null
  } catch {
    return null
  }
}

/**
 * Remember a chosen directory. The value is stored as given; resolution of
 * `~` and relative paths happens where the directory is resolved.
 * @param {string} dataDir absolute or user-typed path
 */
export function writeLocation(dataDir) {
  const file = locationFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ dataDir, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}

/** Drop the stored choice (back to config, then default). */
export function clearLocation() {
  try {
    fs.unlinkSync(locationFile())
  } catch {
    /* already absent */
  }
}
