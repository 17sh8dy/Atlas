// Minimal CDP driver for the Atlas WebView2 page. Usage: import { connect } from './cdp.mjs'
import fs from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function connect(port = 9222, tries = 60) {
  let list
  for (let i = 0; i < tries; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (list.some((p) => p.type === 'page')) break
    } catch {
      /* the page is not up yet: try again */
    }
    await sleep(1000)
  }
  const page = list?.find((p) => p.type === 'page')
  if (!page) throw new Error('no page on the debug port')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result?.result?.value
  }
  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  const invoke = (cmd, args = {}) =>
    ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v=>JSON.stringify(v===undefined?null:v))`).then((s) => (s == null ? s : JSON.parse(s)))
  const clickText = (text, sel = 'button,a,[role=tab],[role=button],div,span,li') =>
    ev(`(()=>{const t=${JSON.stringify(text)};const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>e.textContent.trim()===t&&e.offsetParent!==null);const el=els[els.length-1];if(!el)return 'miss';el.click();return 'ok'})()`)
  const text = () => ev('document.body.innerText')
  return { ws, send, ev, shot, invoke, clickText, text, close: () => ws.close() }
}
