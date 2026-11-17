// Tools plug-in (an MCP server over stdio) that lets one Claude Code session play one Minecraft player.
// It has no logic of its own: it lists the player's tools and passes each call to the body program
// (main.js) over its local tool API.
//   MC_AGENT  the player's name          MC_API  base address, default http://127.0.0.1:3000
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const AGENT = process.env.MC_AGENT
const API = (process.env.MC_API || 'http://127.0.0.1:3000') + '/api'
const token = () => fs.readFileSync(path.join(__dirname, 'api-token.txt'), 'utf8').trim() // re-read: it changes when the body restarts

async function call (method, url, body) {
  let lastErr
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(API + url, { method, headers: { 'x-token': token(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500)) }
  }
  throw lastErr
}

const OBSERVE = {
  name: 'observe',
  description: 'See your current state: position, health, food, inventory, nearby blocks and entities, your teammates, your notes, the shared plan, a log of your recent actions, and any new messages. Call this first every turn.',
  inputSchema: { type: 'object', properties: {} }
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const text = t => ({ content: [{ type: 'text', text: String(t) }] })

async function handle (msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'minecraft', version: '1.0.0' } } })
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') {
    try {
      const tools = await call('GET', '/tools')
      return send({ jsonrpc: '2.0', id, result: { tools: [OBSERVE, ...tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))] } })
    } catch (e) { return send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'the Minecraft body program is not reachable: ' + e.message } }) }
  }
  if (method === 'tools/call') {
    try {
      const name = params.name
      const data = name === 'observe'
        ? await call('GET', `/observe/${encodeURIComponent(AGENT)}`)
        : await call('POST', `/tool/${encodeURIComponent(AGENT)}/${encodeURIComponent(name)}`, params.arguments || {})
      return send({ jsonrpc: '2.0', id, result: text(data.text) })
    } catch (e) { return send({ jsonrpc: '2.0', id, result: { ...text('The game could not be reached: ' + e.message), isError: true } }) }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } }) // notifications get no reply
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  line = line.trim()
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  handle(msg).catch(e => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } }) })
})
