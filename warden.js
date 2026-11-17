// "Warden": a silent operator player that keeps every visitor in spectator mode.
// Agents (from config.json) and the names in config.json "wardenExempt" are left alone; anyone else
// who joins is switched to spectator at once, so they can watch but cannot touch the world or the agents.
// The Warden must be an operator on the server (add it to ops.json or run "op Warden" in the console).
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
const NAME = 'Warden'
const EXEMPT = new Set([...(cfg.wardenExempt || []), NAME].map(s => s.toLowerCase()))
const agents = new Set(cfg.agents.map(a => a.name.toLowerCase()))
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(line); try { fs.appendFileSync(path.join(__dirname, 'warden.log'), line + '\n') } catch {} }

function start () {
  const bot = mineflayer.createBot({ host: cfg.mcHost || '127.0.0.1', port: cfg.mcPort || 25565, username: NAME, auth: 'offline', version: cfg.mcVersion || '1.21.4' })
  const done = new Set()
  const enforce = name => {
    const key = String(name).toLowerCase()
    if (agents.has(key) || EXEMPT.has(key)) return
    bot.chat(`/gamemode spectator ${name}`)
    if (!done.has(key)) { done.add(key); log(`visitor ${name} set to spectator`) }
  }
  const sweep = () => { for (const name of Object.keys(bot.players)) enforce(name) }
  bot.once('spawn', () => {
    log('connected')
    setTimeout(() => bot.chat(`/gamemode spectator ${NAME}`), 1000) // out of the way: invisible to mobs and players
    setTimeout(sweep, 2500)
    bot.sweeper = setInterval(sweep, 15000) // also catches anyone switched back
  })
  bot.on('playerJoined', p => setTimeout(() => enforce(p.username), 800))
  bot.on('playerLeft', p => done.delete(String(p.username).toLowerCase()))
  bot.on('message', m => { const t = m.toString(); if (/Unknown or incomplete command|do not have permission|not an operator/i.test(t)) log('server refused a command: ' + t) })
  bot.on('kicked', r => log('kicked: ' + JSON.stringify(r).slice(0, 200)))
  bot.on('error', e => log('error: ' + e.message))
  bot.on('end', r => { clearInterval(bot.sweeper); log(`disconnected (${r}); reconnecting in 10s`); setTimeout(start, 10000) })
}
start()
