// The players' brains, run through Claude Code on the signed-in claude.ai subscription (no API key).
// For each player it repeatedly starts a short headless Claude Code session ("one turn") whose only
// tools are that player's Minecraft tools (mcp.js). The body program (main.js) must be running.
//   node brains.js            run all players from config.json
//   node brains.js Clade 1    run only Clade, for one turn (test)
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const HERE = __dirname
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'))
const cc = Object.assign({ concurrency: 3, model: 'haiku', pauseSeconds: 8, maxIdlePauseSeconds: 240, turnTimeoutSeconds: 300, limitBackoffMinutes: 15 }, cfg.claudeCode || {})
const only = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2].toLowerCase() : null
const maxTurns = Number(process.argv[3] || (only ? 0 : process.argv[2]) || 0) // 0 = no limit
const API = `http://127.0.0.1:${cfg.webPort}/api`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(line); try { fs.appendFileSync(path.join(HERE, 'brains.log'), line + '\n') } catch {} }

let CLAUDE = 'claude'
try { CLAUDE = execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).find(l => /\.exe$/i.test(l.trim())) .trim() } catch {}

// The sessions must use the subscription login: no API keys, and none of this terminal's own session variables.
const childEnv = {}
for (const [k, v] of Object.entries(process.env)) {
  if (/^ANTHROPIC_|^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_AGENT_/i.test(k)) continue
  childEnv[k] = v
}

async function api (url) {
  const token = fs.readFileSync(path.join(HERE, 'api-token.txt'), 'utf8').trim()
  const res = await fetch(API + url, { headers: { 'x-token': token } })
  if (!res.ok) throw new Error(`body program answered ${res.status}`)
  return res.json()
}

const TURN = 'It is your turn. Call observe first, then do real work with your tools (up to about 12 calls). Speak with say only if it changes what someone does. If there is nothing useful to do, make one long wait call and stop. End with one short sentence about what you did.'

// ---- subscription usage rules ------------------------------------------------------------------
// Every Claude Code turn reports how much of each usage window is spent (5-hour and weekly).
// Rules (config.json -> claudeCode.usage):
//   halt:  if any window (ignoring Fable-only ones) has less than haltBelowPercent left, no new turns
//          start until that window resets.
//   burn:  if the 5-hour window resets within burn.minutesBeforeReset and plenty is still unused
//          (5-hour and weekly both above their thresholds), every player switches to burn.model at
//          burn.effort until the reset, so the leftover allowance is not wasted.
const usageCfg = Object.assign({ haltBelowPercent: 10, ignoreWindows: 'fable' }, cc.usage || {})
usageCfg.burn = Object.assign({ enabled: true, minutesBeforeReset: 20, minFiveHourLeftPercent: 40, minWeeklyLeftPercent: 30, model: 'opus', effort: 'low' }, (cc.usage || {}).burn || {})
const windows = {} // name -> { left (percent), resetsAt (ms), seenAt }
let lastMode = ''
function noteUsage (info) {
  if (!info) return
  const all = info.unifiedWindows || (info.rateLimitType ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : {})
  for (const [name, w] of Object.entries(all)) {
    if (new RegExp(usageCfg.ignoreWindows, 'i').test(name) || typeof w.utilization !== 'number') continue
    windows[name] = { left: Math.round((1 - w.utilization) * 1000) / 10, resetsAt: (w.resetsAt || 0) * 1000, seenAt: Date.now() }
  }
  try { fs.writeFileSync(path.join(HERE, 'usage.json'), JSON.stringify({ at: new Date().toISOString(), mode: usageMode().mode, windows }, null, 1)) } catch {}
}
// what to do right now: { mode: 'normal' | 'burn' | 'halt', until, why }
function usageMode () {
  const now = Date.now()
  for (const [name, w] of Object.entries(windows)) if (w.resetsAt && w.resetsAt <= now) delete windows[name] // that window has reset; wait for fresh numbers
  const low = Object.entries(windows).filter(([, w]) => w.left < usageCfg.haltBelowPercent).sort((a, b) => b[1].resetsAt - a[1].resetsAt)[0]
  if (low) return { mode: 'halt', until: low[1].resetsAt, why: `${low[0]} window has ${low[1].left}% left (below ${usageCfg.haltBelowPercent}%)` }
  const five = windows.five_hour
  const week = windows.seven_day
  const b = usageCfg.burn
  if (b.enabled && five && five.resetsAt - now <= b.minutesBeforeReset * 60000 && five.left >= b.minFiveHourLeftPercent && (!week || week.left >= b.minWeeklyLeftPercent)) {
    return { mode: 'burn', until: five.resetsAt, why: `${Math.round((five.resetsAt - now) / 60000)} min to the 5-hour reset with ${five.left}% unused` }
  }
  return { mode: 'normal' }
}
function announceMode (m) {
  const key = m.mode + (m.until || '')
  if (key === lastMode) return
  lastMode = key
  const when = m.until ? new Date(m.until).toLocaleTimeString() : ''
  if (m.mode === 'halt') log(`USAGE HALT: ${m.why}. No new turns until it resets at ${when}.`)
  else if (m.mode === 'burn') log(`USAGE BURN: ${m.why}. All players on ${usageCfg.burn.model} at ${usageCfg.burn.effort} effort until ${when}.`)
  else log('usage: normal models' + (Object.keys(windows).length ? ' (' + Object.entries(windows).map(([n, w]) => `${n} ${w.left}% left`).join(', ') + ')' : ''))
}

// ---- damage rule: a player that takes damage gets a turn immediately ---------------------------
const hurtNow = {}  // name -> latest damage report from the body
const hurtDone = {} // name -> seq already answered with a turn
const hurtWake = {} // name -> function that ends the pause between turns early
const msgWake = {}  // name -> function that ends an idle pause when a message arrives
setInterval(async () => {
  try {
    const all = await api('/hurt')
    for (const [name, h] of Object.entries(all)) {
      if (hurtNow[name] && h.seq < hurtNow[name].seq) hurtDone[name] = 0 // the body restarted and its counter started again
      hurtNow[name] = h
      if (h.seq > (hurtDone[name] || 0) && hurtWake[name]) hurtWake[name]()
      if (h.inbox > 0 && msgWake[name]) msgWake[name]() // a new message also ends an idle pause
    }
  } catch {}
}, 2000).unref()
const pendingHurt = name => hurtNow[name] && hurtNow[name].seq > (hurtDone[name] || 0) && Date.now() - hurtNow[name].at < 60000 ? hurtNow[name] : null

function runTurn (agent, dir, model, effort, prompt) {
  return new Promise(resolve => {
    const args = ['-p', '--model', model, '--mcp-config', path.join(dir, 'mcp.json'), '--strict-mcp-config',
      '--tools', '', '--allowedTools', 'mcp__mc', '--system-prompt-file', path.join(dir, 'system.txt'),
      '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose']
    if (effort) args.push('--effort', effort)
    const child = spawn(CLAUDE, args, { cwd: dir, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => { try { child.kill() } catch {} }, cc.turnTimeoutSeconds * 1000)
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: 'could not start Claude Code: ' + e.message }) })
    child.on('close', code => {
      clearTimeout(timer)
      let r = null
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue
        let j
        try { j = JSON.parse(line) } catch { continue }
        if (j.type === 'rate_limit_event') noteUsage(j.rate_limit_info)
        else if (j.type === 'result') r = j
      }
      if (!r) return resolve({ ok: false, error: code === null ? `cut off after ${cc.turnTimeoutSeconds}s` : `exit ${code}: ${(err || out).trim().slice(-300)}` })
      resolve({ ok: !r.is_error, error: r.is_error ? String(r.result || r.subtype).slice(0, 300) : null, text: String(r.result || '').replace(/\s+/g, ' ').slice(0, 220), models: Object.keys(r.modelUsage || {}).join('+'), tok: r.usage ? { fresh: (r.usage.input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0), cached: r.usage.cache_read_input_tokens || 0, out: r.usage.output_tokens || 0 } : null, turns: r.num_turns, seconds: Math.round((r.duration_ms || 0) / 1000), cost: r.total_cost_usd })
    })
    child.stdin.end(prompt || TURN)
  })
}

// simple gate so only a few sessions run at once (memory and usage limits)
let running = 0
const waiters = []
async function gate (urgent) { if (running >= cc.concurrency) await new Promise(r => urgent ? waiters.unshift(r) : waiters.push(r)); running++ } // a hurt player goes to the front
function ungate () { running--; const w = waiters.shift(); if (w) w() }

let stopFlag = false
let limitedUntil = 0
async function play (spec) {
  const name = spec.name
  const dir = path.join(HERE, 'agents', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { mc: { command: process.execPath, args: [path.join(HERE, 'mcp.js')], env: { MC_AGENT: name, MC_API: `http://127.0.0.1:${cfg.webPort}` } } } }, null, 1))
  const model = spec.model || cc.model
  let n = 0
  let fails = 0
  let idle = 0        // turns in a row that did no real work
  let actsBefore = 0
  while (!stopFlag && (!maxTurns || n < maxTurns)) {
    if (Date.now() < limitedUntil) { await sleep(15000); continue }
    let mode = usageMode()
    announceMode(mode)
    if (mode.mode === 'halt') { await sleep(20000); continue }
    try { fs.writeFileSync(path.join(dir, 'system.txt'), (await api(`/system/${encodeURIComponent(name)}`)).text) } catch (e) { log(`[${name}] body program not reachable (${e.message}); waiting`); await sleep(10000); continue }
    await gate(!!pendingHurt(name))
    let r
    try {
      mode = usageMode() // may have changed while waiting for a free slot
      if (mode.mode === 'halt') continue
      const burn = mode.mode === 'burn'
      const hurt = pendingHurt(name)
      actsBefore = hurtNow[name] ? hurtNow[name].acts || 0 : 0
      if (hurtNow[name]) hurtDone[name] = hurtNow[name].seq // this turn answers every hit reported so far
      const prompt = hurt ? `ALERT: ${hurt.text}. This turn is your reaction. Call observe, then decide at once: fight back, get away, eat, or block yourself in. Tell your teammates if you need help. End with one short sentence about what you did.` : TURN
      if (hurt) log(`[${name}] took damage; deciding now`)
      r = await runTurn(name, dir, burn ? usageCfg.burn.model : model, burn ? usageCfg.burn.effort : spec.effort, prompt)
    } finally { ungate() }
    n++
    if (r.ok) {
      fails = 0
      const u = Object.entries(windows).map(([w, v]) => `${w.replace('five_hour', '5h').replace('seven_day', 'week')} ${v.left}%`).join(' ')
      const k = x => x >= 1000 ? (x / 1000).toFixed(1) + 'k' : String(x)
      const tk = r.tok ? `; tokens ${k(r.tok.fresh)} new + ${k(r.tok.cached)} cached in, ${k(r.tok.out)} out` : ''
      log(`[${name}] turn ${n} (${r.models || model}, ${r.turns} steps, ${r.seconds}s${tk}${u ? '; left: ' + u : ''}): ${r.text}`)
    } else {
      fails++
      log(`[${name}] turn ${n} FAILED: ${r.error}`)
      if (/limit|quota|rate|overloaded|529|429|credit/i.test(r.error || '')) {
        limitedUntil = Date.now() + cc.limitBackoffMinutes * 60000
        log(`usage limit reached; all players pause for ${cc.limitBackoffMinutes} minutes`)
      } else if (fails >= 5) { log(`[${name}] five failures in a row; trying again in 2 minutes`); await sleep(120000) }
      await sleep(Math.min(60000, 5000 * fails))
    }
    // pause between turns, ended early if the player takes damage
    // A turn that did no real work (only talk, notes or waiting) makes the next pause longer, doubling up to
    // maxIdlePauseSeconds; real work resets it. Damage or a new message ends the pause at once.
    try { const p = (await api('/hurt'))[name]; if (p) { idle = (p.acts || 0) > actsBefore ? 0 : idle + 1; hurtNow[name] = Object.assign(hurtNow[name] || {}, p) } } catch {}
    const base = (spec.pauseSeconds || cc.pauseSeconds) * 1000
    const pause = Math.min(cc.maxIdlePauseSeconds * 1000, base * Math.pow(2, Math.min(idle, 6)))
    if (idle >= 2 && pause > base) log(`[${name}] nothing to do for ${idle} turns; resting ${Math.round(pause / 1000)}s (a message or damage wakes it)`)
    if (!pendingHurt(name)) await new Promise(resolve => { const t = setTimeout(resolve, pause); const wake = () => { clearTimeout(t); resolve() }; hurtWake[name] = wake; msgWake[name] = idle > 0 ? wake : null })
    hurtWake[name] = null; msgWake[name] = null
  }
}

process.on('SIGINT', () => { stopFlag = true })
;(async () => {
  fs.writeFileSync(path.join(HERE, 'brains.pid'), String(process.pid))
  const specs = cfg.agents.filter(a => !only || a.name.toLowerCase() === only)
  log(`starting ${specs.length} player(s) through Claude Code (${CLAUDE}); at most ${cc.concurrency} at once`)
  await Promise.all(specs.map((s, i) => sleep(i * 3000).then(() => play(s))))
  log('all players finished')
})()
