// Drive the real Atlas app (WebView2 debug port) with ONE request, answering confirmation cards by `policy.mjs`.
//
//   node scripts/e2e/drive.mjs "<request containing the sandbox path>" --sandbox <dir> [--minutes 6] [--allow-destructive]
//
// The sandbox must be a disposable folder from `lib/sandbox.mjs`. Every card is judged by `decideCard`; the answer
// defaults to NO. Start Atlas yourself with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222  WEBVIEW2_USER_DATA_FOLDER=<scratch dir>
// and snapshot/restore your real storage.json around the run (see README.md).
import { connect, sleep } from './lib/cdp.mjs'
import { assertDisposable } from './lib/sandbox.mjs'
import { decideCard } from './lib/policy.mjs'

const args = process.argv.slice(2)
const request = args[0]
const flag = (n) => args.includes(n)
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const sandbox = val('--sandbox')
if (!request || !sandbox) {
  console.error('usage: drive.mjs "<request>" --sandbox <dir> [--minutes N] [--allow-destructive]')
  process.exit(2)
}
assertDisposable(sandbox)

const c = await connect()
const t0 = Date.now()
const log = (s) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`)
const state = () => c.ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>x.offsetParent!==null).map(x=>x.textContent.trim());return JSON.stringify({yes:b.includes('Yes, do it')})})()`).then(JSON.parse)
const pageText = async () => (await c.text()).split('Think longer')[0]
const afterRequest = async () => { const t = await pageText(); return t.slice(t.lastIndexOf(request) + request.length) }
const press = async (label) => {
  const p = await c.ev(`(()=>{const el=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.offsetParent!==null).pop();if(!el)return null;const q=el.getBoundingClientRect();return JSON.stringify({x:q.x+q.width/2,y:q.y+q.height/2})})()`)
  if (!p) return false
  const { x, y } = JSON.parse(p)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  return true
}

await c.ev(`(()=>{const t=document.querySelector('textarea,[contenteditable=true],input[type=text]');t.focus()})()`)
await c.send('Input.insertText', { text: request })
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
log(`REQUEST: ${request}`)

let quiet = 0
let last = ''
const decisions = []
while ((Date.now() - t0) / 60000 < Number(val('--minutes', '6'))) {
  await sleep(2500)
  const s = await state()
  if (s.yes) {
    // The card's title sits just BEFORE the quoted request, so judge a window around it.
    const whole = await pageText()
    const at = whole.lastIndexOf(request)
    const card = whole.slice(Math.max(0, at - 300), at + request.length + 1500)
    const d = decideCard(card, { sandbox, allowDestructiveInSandbox: flag('--allow-destructive') })
    decisions.push(d)
    log(`CARD -> ${d.answer.toUpperCase()} (${d.reason}): ${card.replace(/\s+/g, ' ').slice(0, 300)}`)
    await press(d.answer === 'yes' ? 'Yes, do it' : 'Cancel')
    quiet = 0
    await sleep(1500)
    continue
  }
  const t = await afterRequest()
  if (t !== last) { last = t; quiet = 0 } else quiet++
  if (quiet >= 12) break
}
log('FINAL: ' + (await afterRequest()).replace(/\s+/g, ' ').slice(0, 1800))
log(`DECISIONS: ${decisions.map((d) => d.answer).join(',') || 'none'}`)
process.exit(0)
