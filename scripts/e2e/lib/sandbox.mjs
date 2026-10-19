// Disposable test resources for real-app tests. Nothing a test touches may be a user's real file or folder.
//
// A sandbox is a brand-new folder under `<repo>/.e2e-sandbox/` (git-ignored). It is deliberately NOT under the
// system temp folder, Downloads, Documents, the Desktop or any profile folder: those are exactly the places an
// Atlas "clean up" or "delete" could legitimately reach, and a test must never be able to blur "my test files"
// with "the user's files". Deleting a sandbox is refused unless it still sits inside that root.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const SANDBOX_ROOT = path.join(REPO_ROOT, '.e2e-sandbox')

/** Places a test folder must never be, whatever else is true. Compared case-insensitively on normalised paths. */
function forbiddenRoots(env = process.env) {
  const home = env.USERPROFILE || env.HOME || ''
  return [env.TEMP, env.TMP, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Temp'), home && path.join(home, 'Downloads'), home && path.join(home, 'Documents'), home && path.join(home, 'Desktop'), home && path.join(home, 'Pictures'), home && path.join(home, 'Videos'), home && path.join(home, 'Music'), env.APPDATA, 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    .filter(Boolean)
    .map((p) => norm(p))
}

const norm = (p) => path.resolve(p).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
const inside = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + '\\')

/** Throws unless `dir` is safe to treat as a disposable test folder. */
export function assertDisposable(dir, env = process.env) {
  const p = path.resolve(dir)
  if (!inside(p, SANDBOX_ROOT) || norm(p) === norm(SANDBOX_ROOT)) throw new Error(`Not a disposable folder: ${p} (must be inside ${SANDBOX_ROOT}).`)
  for (const bad of forbiddenRoots(env)) if (inside(p, bad)) throw new Error(`Refusing ${p}: it is inside ${bad}.`)
  return p
}

export function createSandbox(name = 'run', files = {}) {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true })
  const dir = path.join(SANDBOX_ROOT, `${name}-${Date.now().toString(36)}`)
  assertDisposable(dir)
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel)
    assertDisposable(f)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  return {
    dir,
    /** Forward-slash form, which is what Atlas prints in its cards. */
    slash: dir.replace(/\\/g, '/'),
    destroy() {
      assertDisposable(dir)
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
