// LLM agents play Minecraft together.
// One process: a mineflayer player per agent, a Claude decision loop for each,
// Discord as their chat, and a first-person view of each in the browser.
//
//   node main.js            full run
//   node main.js --no-ai    bots join and idle (for testing views)
//   node main.js --no-discord
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const { mineflayer: startViewer } = require('prismarine-viewer')
const express = require('express')
const { Vec3 } = require('vec3')
const Anthropic = require('@anthropic-ai/sdk')

const HERE = __dirname
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'))
// brain "claude-code": this program is only the body (Minecraft, Discord, web view). The thinking is done
// by Claude Code sessions that call the local tool API below, so no API key is used here.
const EXTERNAL_BRAIN = cfg.brain === 'claude-code'
const NO_AI = process.argv.includes('--no-ai') || EXTERNAL_BRAIN
const NO_DISCORD = process.argv.includes('--no-discord') || !cfg.discord.enabled

// ---------- env: .env in this folder (or one folder up) ----------
for (const f of ['.env', '../.env', '../.env.gpt']) {
  const p = path.join(HERE, f)
  if (!fs.existsSync(p)) continue
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0 && !process.env[line.slice(0, i).trim()]) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
}

const logFile = fs.createWriteStream(path.join(HERE, 'run.log'), { flags: 'a' })
function log (...a) {
  const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`
  console.log(line)
  logFile.write(line + '\n')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
function withTimeout (p, ms, onTimeout) {
  let t
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => { try { onTimeout && onTimeout() } catch {} ; rej(new Error(`timed out after ${ms / 1000}s`)) }, ms) })
  ]).finally(() => clearTimeout(t))
}

const client = NO_AI ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const agents = []

// shared between the players and kept across restarts: the team plan and the death counts
const TEAM_FILE = path.join(HERE, 'team.json')
let team = { plan: '', planBy: '', deaths: {} }
try { team = Object.assign(team, JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8'))) } catch {
  // first run: seed the death counts from the log so earlier deaths are not forgotten
  try {
    for (const m of fs.readFileSync(path.join(HERE, 'run.log'), 'utf8').matchAll(/\[(\w+)\] died/g)) team.deaths[m[1]] = (team.deaths[m[1]] || 0) + 1
  } catch {}
}
function saveTeam () { try { fs.writeFileSync(TEAM_FILE, JSON.stringify(team, null, 1)) } catch {} }

// ---------------------------------------------------------------- tools ----
const TOOLS = [
  { name: 'say', description: 'Send a chat message to your partner (and any humans watching). This is the only way to talk. Keep it short.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'goto', description: 'Walk to coordinates.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } },
  { name: 'goto_player', description: 'Walk next to a player (your partner or a human).', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'mine', description: 'Find the nearest blocks of a type (e.g. oak_log, stone, coal_ore), walk there, dig them and pick up the drops.', input_schema: { type: 'object', properties: { block: { type: 'string' }, count: { type: 'integer' } }, required: ['block'] } },
  { name: 'craft', description: 'Craft an item. Recipes that need a 3x3 grid require a crafting_table within reach (place one first).', input_schema: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer' } }, required: ['item'] } },
  { name: 'place', description: 'Place a block from your inventory. Give coordinates of the empty spot, or omit them to place it next to you.', input_schema: { type: 'object', properties: { item: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['item'] } },
  { name: 'dig', description: 'Dig the single block at coordinates.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } },
  { name: 'give', description: 'Walk to a player and toss them items from your inventory.', input_schema: { type: 'object', properties: { player: { type: 'string' }, item: { type: 'string' }, count: { type: 'integer' } }, required: ['player', 'item'] } },
  { name: 'equip', description: 'Hold an item (tool, weapon, block) in your hand. Armour pieces are put on, and a shield goes in your off hand.', input_schema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } },
  { name: 'attack', description: 'Fight the nearest entity of a type (e.g. zombie, cow, pig) until it dies or 20 seconds pass.', input_schema: { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] } },
  { name: 'eat', description: 'Eat food from your inventory.', input_schema: { type: 'object', properties: {} } },
  { name: 'smelt', description: 'Use a furnace within reach: put in an input item and fuel, wait, and take the output.', input_schema: { type: 'object', properties: { item: { type: 'string' }, fuel: { type: 'string' }, count: { type: 'integer' } }, required: ['item', 'fuel'] } },
  { name: 'use', description: 'Use the item in your hand in the air (throw an ender_pearl or ender_eye, drink, shoot). Give item to hold it first.', input_schema: { type: 'object', properties: { item: { type: 'string' } } } },
  { name: 'use_on', description: 'Right-click the block at coordinates, optionally holding an item first: flint_and_steel on obsidian to light a portal, ender_eye on an end_portal_frame, sleep in a bed, open a door, bucket on water/lava.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, item: { type: 'string' } }, required: ['x', 'y', 'z'] } },
  { name: 'chest', description: 'Put items into or take items out of a chest within reach.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['put', 'take', 'list'] }, item: { type: 'string' }, count: { type: 'integer' } }, required: ['action'] } },
  { name: 'scan', description: 'List the block types and their nearest positions within a radius (default 24).', input_schema: { type: 'object', properties: { radius: { type: 'integer' } } } },
  { name: 'ask_adviser', description: 'Ask the team adviser, a stronger and wiser model that can see both of you, for strategy help. Use it when you are stuck, keep dying, disagree with your teammate, or are about to start a big step (deep mining, the Nether, the End). Ask one specific question. It also sends advice on its own every few minutes.', input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
  { name: 'plan', description: 'Rewrite the shared team plan that you and your teammate both see every turn: the current step, who is doing what, and where to meet. Keep it under 600 characters.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'note', description: 'Save a short note to your own memory (plans, base coordinates). Notes persist between turns.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'wait', description: 'Do nothing for up to 180 seconds, e.g. sheltering at night or waiting for a teammate. It ends early if someone messages you or you take damage. Use one long wait, not many short ones.', input_schema: { type: 'object', properties: { seconds: { type: 'number' } } } }
]

function systemPrompt (a) {
  const mates = agents.filter(x => x !== a).map(x => x.name)
  return `You are ${a.name}, a player in a Minecraft survival world. Your teammate${mates.length > 1 ? 's are' : ' is'} ${mates.join(' and ')}, also AI player${mates.length > 1 ? 's' : ''}. You are one team of ${agents.length}. ("Partner" in tool descriptions means any teammate.)

Shared goal: ${cfg.goal}

How this works:
${EXTERNAL_BRAIN ? '- You play in short turns. At the start of every turn call the observe tool: it shows your state, your teammates, your notes, a log of what you did on earlier turns, and new messages. Then do as much real work as you can in the turn (up to about 12 tool calls: gather, craft, build, move, give), and end with one short sentence saying what you did. Each turn costs the team, so make it count: never spend a turn only talking or only waiting a few seconds. If there is truly nothing useful to do (night and you are sheltered, or you are waiting for someone), make ONE wait call of 60 to 180 seconds and end the turn; the wait ends early if someone messages you or you are hurt.' : '- Each turn you get your current state and must call one or more tools. Tools run in order; later turns show their results.'}
- You only talk through the say tool. Your teammate and humans see it in a Discord channel.
- This is a team game. Work together, but talk sparingly: every message makes all your teammates read it.
  - Speak only when it changes what someone does: a decision, a request, an offer, a warning, a finished job, or a direct answer to a question put to you. One message can cover several things.
  - Do not send acknowledgements ("ok", "understood", "on my way"), status with nothing new, or the same thing twice. Do not reply to a message that needs no answer.
  - The shared plan is the source of truth for who does what. Read it in observe; whoever leads keeps it current with the plan tool. Follow it without asking for confirmation.
  - Share. You can see what each teammate carries. If someone lacks something you have spare, hand it over with give; if you need something, ask once.
  - Do dangerous jobs with a partner, and if a teammate is hurt, lost or has died, go and help.
${(cfg.discord.listenToHumans || (cfg.discord.humanAllowlist || []).length) ? '- Messages from humans are instructions from the people running this world. Follow them, and they take priority over the shared goal.\n' : ''}- Item and block names are Minecraft ids, like oak_log, oak_planks, crafting_table, wooden_pickaxe, cobblestone.
- Dying is costly: keep-inventory is OFF, so when you die everything you carry drops where you died and vanishes after about 5 minutes, and you respawn at the world spawn with nothing. Wear armour, keep food up, shelter or seal yourself in at night, do not dig straight down, and store valuables (diamonds, spare iron, obsidian) in the base chest before risky trips.
- Your body looks after itself, so do not spend calls on these: it puts on the best armour you carry, eats from your inventory when you are hungry or hurt, and swings at any monster within reach (not creepers: walk away from those). It cannot eat food you do not have, so always carry cooked food.
- Staying alive comes first. A death costs far more than the time it saves.
  - Nights: make a bed early (3 wool of one colour + 3 planks) and carry it. At dusk place it somewhere enclosed and sleep with use_on; when every player sleeps the night is skipped, and the bed becomes your respawn point. Without a bed, be sealed in before dark and use one long wait.
  - Never craft, smelt or sort items while something is attacking you or while your health is under 8: get away or wall yourself in first, then recover.
  - Before going underground or far from base: a sword, a pickaxe, at least 8 cooked food, 16 torches and 20 blocks to wall off with. Make a shield (1 iron + 6 planks) as soon as you have iron.
  - After a death, do not run back for your items unless they are close and it is day.
- If a tool fails, read the error and try something different instead of repeating it.
- Use note for anything you must remember (base location, plan); you have no other memory beyond the recent log shown each turn.`
}

// ------------------------------------------------------------ the agent ----
function makeAgent (spec) {
  const a = {
    name: spec.name,
    spec,
    bot: null,
    ready: false,
    inbox: [],       // unseen chat lines
    history: [],     // recent actions + results + chat, shown every turn
    notes: [],
    calls: 0,
    discord: null,
    channel: null
  }
  const notesFile = path.join(HERE, `notes_${spec.name.toLowerCase()}.json`)
  try { a.notes = JSON.parse(fs.readFileSync(notesFile, 'utf8')) } catch {}
  a.saveNotes = () => fs.writeFileSync(notesFile, JSON.stringify(a.notes.slice(-12)))
  a.remember = line => { a.history.push(line); if (a.history.length > 16) a.history.splice(0, a.history.length - 16) }
  return a
}

function connect (a) {
  const bot = mineflayer.createBot({ host: cfg.mcHost, port: cfg.mcPort, username: a.name, auth: 'offline', version: cfg.mcVersion })
  a.bot = bot
  a.ready = false
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)
  bot.once('spawn', () => {
    const mv = new Movements(bot)
    mv.canOpenDoors = true
    mv.allowParkour = false
    bot.pathfinder.setMovements(mv)
    bot.pathfinder.searchRadius = 96
    bot.pathfinder.thinkTimeout = 8000
    a.mcData = require('minecraft-data')(bot.version)
    a.ready = true
    startReflexes(a)
    log(`[${a.name}] spawned at ${bot.entity.position.floored()}`)
    if (!a.viewerStarted) {
      a.viewerStarted = true
      a.viewers = []
      try {
        startViewer(bot, { port: a.spec.viewerPort, firstPerson: true, viewDistance: 3, prefix: '/' + a.name.toLowerCase() })
        a.viewers.push(bot.viewer)
        if (a === agents[0] && cfg.freePort) {
          // a second, free camera on the same world: drag to orbit, wheel to zoom, right-drag to pan
          startViewer(bot, { port: cfg.freePort, firstPerson: false, viewDistance: 5, prefix: '/free' })
          a.viewers.push(bot.viewer)
        }
      } catch (e) { log(`[${a.name}] viewer failed: ${e.message}`) }
    }
  })
  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    const other = agents.find(x => x.name === username)
    if (other) return // teammates' speech arrives through Discord or directly, never from game chat
    if (!other && !cfg.discord.listenToHumans) return
    a.inbox.push(`${username}: ${message}`)
  })
  // server announcements (deaths, joins, advancements) go to Discord, once, via the first bot
  if (a === agents[0]) {
    bot.on('message', (msg, position) => {
      if (position !== 'system') return
      const text = msg.toString().trim()
      if (!text || text.startsWith('<')) return
      serverLines.push(text)
    })
  }
  // Taking damage calls for a decision straight away: note it, cut short a long action in progress,
  // and bump a counter the brains watch so the player gets a turn immediately.
  let lastHealth = null
  bot.on('health', () => {
    const now = bot.health
    if (lastHealth !== null && now < lastHealth - 0.4 && now > 0) {
      const me = bot.entity.position
      const near = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(me) < 8 && (e.type === 'hostile' || e.type === 'mob' || e.type === 'player'))
        .sort((x, y) => x.position.distanceTo(me) - y.position.distanceTo(me))[0]
      const cause = near ? `; nearest threat: ${near.username || near.name} ${Math.round(near.position.distanceTo(me))}m away at ${fmt(near.position)}` : '; no attacker in sight (fall, fire, drowning, hunger or something unseen)'
      a.hurt = { seq: ((a.hurt && a.hurt.seq) || 0) + 1, at: Date.now(), text: `you took damage: health ${Math.round(lastHealth)} -> ${Math.round(now)} of 20${cause}` }
      a.remember(`EVENT: ${a.hurt.text}`)
      log(`[${a.name}] hurt: ${a.hurt.text}`)
      if (a.onHurt) a.onHurt()
    }
    lastHealth = now
  })
  bot.on('death', () => {
    haltPath(bot); try { bot.collectBlock.cancelTask() } catch {}
    team.deaths[a.name] = (team.deaths[a.name] || 0) + 1
    saveTeam()
    a.remember(`EVENT: you died (death number ${team.deaths[a.name]}) and respawned at the world spawn. Keep-inventory is OFF: everything you carried dropped where you died and disappears after about 5 minutes. If it is worth it and safe, go back for it; otherwise re-gear.`)
    for (const o of agents) if (o !== a) o.remember(`EVENT: your teammate ${a.name} died and respawned at the world spawn. Their items dropped where they died; help them recover or re-gear.`)
    setTimeout(() => consultAdviser(`${a.name} just died (death ${team.deaths[a.name]})`, '', null).catch(() => {}), 4000)
    serverLines.push(`☠ Death count: ${agents.map(x => `${x.name} ${team.deaths[x.name] || 0}`).join(', ')}`)
    log(`[${a.name}] died`)
  })
  bot.on('kicked', r => log(`[${a.name}] kicked: ${JSON.stringify(r)}`))
  bot.on('error', e => log(`[${a.name}] error: ${e.message}`))
  bot.on('end', r => {
    log(`[${a.name}] disconnected (${r}); reconnecting in 10s`)
    a.ready = false
    clearInterval(a.reflexTimer)
    for (const v of a.viewers || []) { try { v.close() } catch {} }
    a.viewerStarted = false
    if (!stopping) setTimeout(() => connect(a), 10000)
  })
}

// ------------------------------------------------------------- reflexes ----
// Things a player does without thinking, so no turn is spent on them and they still happen
// between turns: wear the best armour carried, eat when hungry, hit back at a monster in reach.
const TIER = ['wooden', 'golden', 'leather', 'stone', 'chainmail', 'iron', 'diamond', 'netherite']
const tierOf = name => TIER.indexOf(String(name).split('_')[0])
const ARMOUR = [['head', 5, /_helmet$/], ['torso', 6, /_chestplate$/], ['legs', 7, /_leggings$/], ['feet', 8, /_boots$/]]
const NO_MELEE = new Set(['creeper', 'enderman', 'zombified_piglin', 'piglin', 'ghast', 'ender_dragon', 'warden', 'wither'])
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew'])
function bestWeapon (bot) {
  const score = i => (/_sword$/.test(i.name) ? 10 : /_axe$/.test(i.name) ? 5 : -100) + tierOf(i.name)
  return bot.inventory.items().filter(i => score(i) > 0).sort((x, y) => score(y) - score(x))[0]
}
function startReflexes (a) {
  const bot = a.bot
  clearInterval(a.reflexTimer)
  let busy = false
  let lastSlow = 0
  const handFree = () => !a.doing || /^(goto|goto_player|wait|attack)\b/.test(a.doing)
  const calm = () => !a.doing || /^(goto|goto_player|wait|mine|attack|dig)\b/.test(a.doing)
  a.reflexTimer = setInterval(async () => {
    if (busy || !a.ready || !bot.entity || !(bot.health > 0)) return
    busy = true
    try {
      const me = bot.entity.position
      // hit back: a swing does not need the player to turn, so walking and digging carry on
      const foe = bot.nearestEntity(e => e.type === 'hostile' && !NO_MELEE.has(e.name) && e.position.distanceTo(me) < 3.6)
      if (foe) {
        const w = bestWeapon(bot)
        if (w && handFree() && !bot.targetDigBlock && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, 'hand').catch(() => {})
        bot.attack(foe)
        if (!a.reflexFoe || Date.now() - a.reflexFoe > 20000) log(`[${a.name}] reflex: fighting ${foe.name}`)
        a.reflexFoe = Date.now()
        return
      }
      if (Date.now() - lastSlow < 4000) return
      lastSlow = Date.now()
      // armour: put on anything better than what is worn
      if (calm() && !bot.currentWindow) {
        for (const [dest, slot, re] of ARMOUR) {
          const worn = bot.inventory.slots[slot]
          const best = bot.inventory.items().filter(i => re.test(i.name)).sort((x, y) => tierOf(y.name) - tierOf(x.name))[0]
          if (best && (!worn || tierOf(best.name) > tierOf(worn.name))) {
            await bot.equip(best, dest).catch(() => {})
            log(`[${a.name}] reflex: put on ${best.name}`)
            a.remember(`EVENT: you put on ${best.name} (done automatically).`)
          }
        }
      }
      // food: eat when hungry, or when hurt and not full (health only comes back on a full stomach)
      if (handFree() && !bot.currentWindow && !bot.targetDigBlock && (bot.food <= 14 || (bot.health < 14 && bot.food < 20))) {
        const foods = a.mcData.foodsByName
        const pick = bot.inventory.items().filter(i => foods[i.name] && (bot.food <= 6 ? !/golden_apple|chorus|pufferfish|stew/.test(i.name) : !BAD_FOOD.has(i.name)))
          .sort((x, y) => (foods[y.name].foodPoints || 0) - (foods[x.name].foodPoints || 0))[0]
        if (pick) {
          const held = bot.heldItem
          await bot.equip(pick, 'hand')
          await withTimeout(bot.consume(), 6000)
          if (held && bot.inventory.items().some(i => i.type === held.type)) await bot.equip(held.type, 'hand').catch(() => {})
          log(`[${a.name}] reflex: ate ${pick.name} (food ${bot.food}/20)`)
          a.remember(`EVENT: you ate ${pick.name} (done automatically). Food ${bot.food}/20.`)
        }
      }
    } catch (e) { /* a reflex that fails is simply tried again later */ } finally { busy = false }
  }, 650)
}

// ----------------------------------------------------- tool implementations
const fmt = p => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
function invText (bot) {
  const counts = {}
  for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count
  const s = Object.entries(counts).map(([k, v]) => `${k} x${v}`).join(', ')
  return s || 'empty'
}
function findItem (bot, name) { return bot.inventory.items().find(i => i.name === name) }

// Cancel any walk. (pathfinder.stop() must not be used: its flag lingers and
// kills the NEXT walk with "Path was stopped".)
function haltPath (bot) { try { bot.pathfinder.setGoal(null) } catch {} ; try { bot.clearControlStates() } catch {} }

// Where a player is: seen in the world, or (for the partner bot) known directly.
function playerPos (a, name) {
  const p = a.bot.players[name]
  if (p && p.entity) return p.entity.position.clone()
  const o = agents.find(x => x !== a && x.ready && x.name.toLowerCase() === String(name).toLowerCase())
  return o ? o.bot.entity.position.clone() : null
}

async function walkTo (bot, goal, ms = 45000) {
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, () => haltPath(bot))
  } finally {
    haltPath(bot) // never keep following/replanning in the background
  }
}

// Go to a point that may be far away or awkward to reach.
// Long trips are walked in legs (the world is only loaded near the bot, so one
// long route cannot be planned), and a blocked leg is retried around the side.
async function travel (bot, x, y, z, range = 1, budgetMs = 120000) {
  const end = Date.now() + budgetMs
  const dest = new Vec3(x, y, z)
  let fails = 0
  let lastErr = null
  const run = bot.run || {}
  while (Date.now() < end) {
    if (run.cancelled) throw new Error('stopped')
    const me = bot.entity.position
    const flat = Math.hypot(dest.x - me.x, dest.z - me.z)
    if (me.distanceTo(dest) <= range + 1.5) return true
    let goal
    if (flat > 40) {
      // a leg of about 32 blocks toward the target, bent sideways after a failure
      let ang = Math.atan2(dest.z - me.z, dest.x - me.x)
      if (fails) ang += (fails % 2 ? 1 : -1) * 0.6 * Math.ceil(fails / 2)
      goal = new goals.GoalNearXZ(Math.round(me.x + Math.cos(ang) * 32), Math.round(me.z + Math.sin(ang) * 32), 3)
    } else {
      // close: aim at the spot itself; after failures accept getting near it
      goal = new goals.GoalNear(dest.x, dest.y, dest.z, range + Math.min(fails, 3))
    }
    const before = me.clone()
    try {
      await walkTo(bot, goal, Math.min(flat > 40 ? 35000 : 20000, Math.max(5000, end - Date.now())))
      if (flat <= 40) return true
      fails = 0
    } catch (e) {
      lastErr = e
      // progress counts even if the leg did not finish
      if (bot.entity.position.distanceTo(before) > 6) fails = 0
      else if (++fails > (flat > 40 ? 5 : 2)) break
      // unstick: hop and take a step back
      bot.setControlState('jump', true); bot.setControlState('back', true)
      await sleep(400)
      bot.clearControlStates()
    }
  }
  if (bot.entity.position.distanceTo(dest) <= range + 4) return true
  throw new Error(`could not get there (${lastErr ? lastErr.message : 'ran out of time'}); stopped at ${fmt(bot.entity.position)}, ${Math.round(bot.entity.position.distanceTo(dest))}m short`)
}

const impl = {
  async say (a, { text }) {
    text = String(text || '').slice(0, 1500)
    if (!text) return 'nothing said'
    log(`[${a.name}] SAY: ${text}`)
    let viaDiscord = false
    if (a.channel) {
      try { await a.channel.send(text); viaDiscord = true } catch (e) { log(`[${a.name}] discord send failed: ${e.message}`) }
    }
    if (!viaDiscord) {
      // no Discord account of its own (or no channel yet): hand the message to the
      // teammates directly, and show it in the channel through the first bot's account
      for (const o of agents) if (o !== a) o.inbox.push(`${a.name}: ${text}`)
      const hub = agents.find(x => x.channel)
      if (hub) { try { await hub.channel.send(`${RELAY_TAG} **${a.name}:** ${text}`.slice(0, 1900)) } catch (e) { log(`[${a.name}] relay send failed: ${e.message}`) } }
    }
    try { a.bot.chat(text.replace(/\s+/g, ' ').slice(0, 250)) } catch {}
    return 'sent'
  },
  async goto (a, { x, y, z }) {
    await travel(a.bot, x, y, z, 1)
    return `arrived at ${fmt(a.bot.entity.position)}`
  },
  async goto_player (a, { name }) {
    const pos = playerPos(a, name)
    if (!pos) return `cannot find ${name} (not online, or too far away to see). Ask them for coordinates and use goto.`
    await travel(a.bot, pos.x, pos.y, pos.z, 2)
    // they may have moved while we walked: close the last gap
    const now = playerPos(a, name)
    if (now && now.distanceTo(a.bot.entity.position) > 4) await travel(a.bot, now.x, now.y, now.z, 2, 30000).catch(() => {})
    const d = playerPos(a, name)
    return `at ${fmt(a.bot.entity.position)}, ${d ? Math.round(d.distanceTo(a.bot.entity.position)) : '?'}m from ${name}`
  },
  async mine (a, { block, count = 1 }) {
    const def = a.mcData.blocksByName[block]
    if (!def) return `unknown block "${block}"`
    count = Math.max(1, Math.min(16, count))
    const before = invText(a.bot)
    let got = 0
    // the right tool must exist before walking anywhere
    const sample = a.bot.findBlock({ matching: def.id, maxDistance: 48 })
    if (!sample) return `no ${block} within 48 blocks. Try scan, or walk somewhere new.`
    if (def.harvestTools && !a.bot.inventory.items().some(i => def.harvestTools[i.type])) {
      const need = Object.keys(def.harvestTools).map(id => a.mcData.items[id] && a.mcData.items[id].name).filter(Boolean)
      return `you cannot harvest ${block} without one of: ${need.slice(0, 6).join(', ')}. Inventory: ${invText(a.bot)}`
    }
    const bad = new Set() // blocks we could not reach this time
    let lastErr = ''
    let tries = 0
    if (a.bot.inventory.emptySlotCount() === 0) return `your inventory is full (${invText(a.bot)}). Put items in a chest (chest put), give some away, or craft them into something before mining more.`
    const deadline = Date.now() + 75000 // one mining action never runs longer than this
    const run = a.bot.run || {}
    while (got < count && tries < count + 6 && Date.now() < deadline && !run.cancelled) {
      tries++
      const spots = a.bot.findBlocks({ matching: def.id, maxDistance: 48, count: 24 }).filter(p => !bad.has(p.toString()))
      if (!spots.length) break
      const target = a.bot.blockAt(spots[0])
      try {
        // get close ourselves first (handles long or awkward trips), then dig and pick up
        if (a.bot.entity.position.distanceTo(target.position) > 6) await travel(a.bot, target.position.x, target.position.y, target.position.z, 3, 45000)
        await withTimeout(a.bot.collectBlock.collect(target), 30000, () => { try { a.bot.collectBlock.cancelTask() } catch {} ; haltPath(a.bot) })
        got++
      } catch (e) {
        lastErr = /chest locations/.test(e.message) ? 'your inventory is full: put items in a chest (chest put) or craft them into something first' : e.message
        if (/chest locations/.test(e.message)) { haltPath(a.bot); break }
        bad.add(target.position.toString())
        haltPath(a.bot)
      }
    }
    if (!got) return `could not mine ${block}: ${lastErr || 'none reachable'}. Inventory: ${invText(a.bot)}`
    return `mined ${got} ${block}${got < count ? ` (wanted ${count}; ran out of time or reach, call mine again for more)` : ''}. Inventory before: ${before}. Now: ${invText(a.bot)}`
  },
  async craft (a, { item, count = 1 }) {
    const def = a.mcData.itemsByName[item]
    if (!def) return `unknown item "${item}"`
    const tableId = a.mcData.blocksByName.crafting_table.id
    let table = a.bot.findBlock({ matching: tableId, maxDistance: 4 })
    let recipes = a.bot.recipesFor(def.id, null, 1, table)
    let setUp = ''
    if (!recipes.length && !table && item !== 'crafting_table' && a.bot.recipesAll(def.id, null, true).length > 0) {
      // a 3x3 recipe with no table in reach: walk to one nearby, or put down the one carried (making it first if planks allow)
      const far = a.bot.findBlock({ matching: tableId, maxDistance: 24 })
      if (far) {
        await walkTo(a.bot, new goals.GoalNear(far.position.x, far.position.y, far.position.z, 2), 20000).catch(() => {})
        setUp = `walked to the crafting table at ${fmt(far.position)}; `
      } else {
        if (!findItem(a.bot, 'crafting_table')) {
          const tr = a.bot.recipesFor(a.mcData.itemsByName.crafting_table.id, null, 1, null)[0]
          if (tr) await withTimeout(a.bot.craft(tr, 1, null), 10000).catch(() => {})
          await sleep(400)
        }
        if (findItem(a.bot, 'crafting_table')) setUp = `${await impl.place(a, { item: 'crafting_table' })} (crafting table put down for you); `
      }
      table = a.bot.findBlock({ matching: tableId, maxDistance: 4 })
      recipes = a.bot.recipesFor(def.id, null, 1, table)
    }
    if (!recipes.length) {
      // say exactly what is missing, from the first known recipe
      let missing = ''
      try {
        const r = a.bot.recipesAll(def.id, null, true)[0]
        if (r) {
          const need = {}
          for (const d of r.delta) if (d.count < 0) need[d.id] = (need[d.id] || 0) - d.count
          missing = Object.entries(need).map(([id, n]) => `${n} ${a.mcData.items[id].name} (have ${a.bot.inventory.count(Number(id))})`).join(', ')
        }
      } catch {}
      return !table && a.bot.recipesAll(def.id, null, true).length > 0 && item !== 'crafting_table' && !missing
        ? `cannot craft ${item}: no crafting_table in reach and none could be made. Inventory: ${invText(a.bot)}`
        : `cannot craft ${item}: ${table || item === 'crafting_table' ? '' : 'no crafting_table within 4 blocks, and '}one recipe needs ${missing || 'materials you lack'}${missing ? ' (other wood or stone types may also work)' : ''}. Inventory: ${invText(a.bot)}`
    }
    // count = how many items are wanted; one run of a recipe can give several
    const per = recipes[0].result.count || 1
    let runs = Math.max(1, Math.min(32, Math.ceil(count / per)))
    while (runs > 1 && !a.bot.recipesFor(def.id, null, runs, table).length) runs--
    const recipe = a.bot.recipesFor(def.id, null, runs, table)[0] || recipes[0]
    const had = a.bot.inventory.count(def.id)
    await withTimeout(a.bot.craft(recipe, runs, table), 20000)
    await sleep(600)
    const made = a.bot.inventory.count(def.id) - had
    return `${setUp}crafted ${made} ${item}${made < count ? ` (wanted ${count}; not enough materials for more)` : ''}. Inventory: ${invText(a.bot)}`
  },
  async place (a, { item, x, y, z }) {
    const it = findItem(a.bot, item)
    if (!it) return `you have no ${item}. Inventory: ${invText(a.bot)}`
    const bot = a.bot
    const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    const solid = b => b && b.boundingBox === 'block'
    const empty = b => b && (b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty')
    let spot
    if (x === undefined || y === undefined || z === undefined) {
      // no coordinates: try the free spots around the player one after another until the server accepts one
      const me = bot.entity.position.floored()
      const spots = []
      for (let r = 1; r <= 2; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, 1, -1]) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const p = me.offset(dx, dy, dz)
        if (empty(bot.blockAt(p)) && solid(bot.blockAt(p.offset(0, -1, 0)))) spots.push(p)
      }
      if (!spots.length) return 'no free spot next to you; give coordinates'
      let last = ''
      for (const p of spots.slice(0, 5)) {
        if (!findItem(bot, item)) break
        try {
          last = await impl.place(a, { item, x: p.x, y: p.y, z: p.z })
          if (!/is now (air|cave_air)$/.test(last) && /is now /.test(last)) return last
        } catch (e) { last = `FAILED: ${e.message}` }
      }
      return `could not place ${item} next to you (last try: ${last}). Move to open ground or give coordinates.`
    } else {
      spot = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
      if (!empty(bot.blockAt(spot))) return `${fmt(spot)} is not empty (it is ${bot.blockAt(spot)?.name})`
      if (bot.entity.position.distanceTo(spot) > 4) await walkTo(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 3))
      // do not stand inside the spot
      if (bot.entity.position.floored().equals(spot) || bot.entity.position.floored().offset(0, 1, 0).equals(spot)) {
        // step aside two blocks, whichever side is walkable
        for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
          try { await walkTo(bot, new goals.GoalNear(spot.x + dx, spot.y, spot.z + dz, 0), 6000); break } catch {}
        }
        if (bot.entity.position.floored().equals(spot)) return `you are standing in ${fmt(spot)}; move away first`
      }
    }
    let ref, face
    for (const f of faces) {
      const b = bot.blockAt(spot.plus(f))
      if (solid(b)) { ref = b; face = f.scaled(-1); break }
    }
    if (!ref) return `nothing solid next to ${fmt(spot)} to place against`
    await bot.equip(it, 'hand')
    await sleep(250)
    if (!bot.heldItem || bot.heldItem.name !== item) return `could not get ${item} into your hand (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'})`
    await withTimeout(bot.placeBlock(ref, face), 8000)
    await sleep(300)
    const now = bot.blockAt(spot)
    return `block at ${fmt(spot)} is now ${now ? now.name : 'unknown'}`
  },
  async dig (a, { x, y, z }) {
    const bot = a.bot
    const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    if (!b || b.name === 'air') return 'nothing there'
    if (bot.entity.position.distanceTo(b.position) > 4) await walkTo(bot, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 3))
    try { await bot.tool.equipForBlock(b) } catch {}
    await withTimeout(bot.dig(b), 30000, () => bot.stopDigging())
    return `dug ${b.name} at ${fmt(b.position)}`
  },
  async give (a, { player, item, count = 1 }) {
    const it = findItem(a.bot, item)
    if (!it) return `you have no ${item}. Inventory: ${invText(a.bot)}`
    let pos = playerPos(a, player)
    if (!pos) return `cannot find ${player}; ask for their coordinates`
    await travel(a.bot, pos.x, pos.y, pos.z, 2)
    pos = playerPos(a, player) || pos
    if (pos.distanceTo(a.bot.entity.position) > 5) return `could not get close enough to ${player} (${Math.round(pos.distanceTo(a.bot.entity.position))}m away); nothing given`
    await a.bot.lookAt(pos.offset(0, 1, 0))
    const n = Math.min(count, a.bot.inventory.count(it.type))
    await a.bot.toss(it.type, null, n)
    return `tossed ${n} ${item} to ${player}`
  },
  async equip (a, { item }) {
    const it = findItem(a.bot, item)
    if (!it) return `you have no ${item}. Inventory: ${invText(a.bot)}`
    // armour is worn, a shield goes in the other hand, everything else is held
    const slot = /_helmet$|^turtle_helmet$/.test(item) ? 'head' : /_chestplate$|^elytra$/.test(item) ? 'torso' : /_leggings$/.test(item) ? 'legs' : /_boots$/.test(item) ? 'feet' : item === 'shield' ? 'off-hand' : 'hand'
    await a.bot.equip(it, slot)
    return slot === 'hand' ? `holding ${item}` : slot === 'off-hand' ? `${item} is in your off hand` : `wearing ${item}`
  },
  async attack (a, { entity }) {
    const bot = a.bot
    const find = () => bot.nearestEntity(e => e.name === entity && e.position.distanceTo(bot.entity.position) < 24)
    let target = find()
    if (!target) return `no ${entity} within 24 blocks`
    const weapon = bestWeapon(bot)
    if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
    const end = Date.now() + 20000
    let lastPos = target.position.clone()
    while (Date.now() < end && target && target.isValid) {
      lastPos = target.position.clone()
      if (bot.entity.position.distanceTo(target.position) > 3) {
        await walkTo(bot, new goals.GoalFollow(target, 2), 6000).catch(() => {})
      }
      if (target.isValid && bot.entity.position.distanceTo(target.position) <= 3.5) {
        await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.6, 0))
        bot.attack(target)
      }
      await sleep(600)
    }
    if (target.isValid) return `${entity} is still alive after 20s. Health ${Math.round(bot.health)}/20`
    // walk onto the spot where it died so the drops are picked up
    const before = invText(bot)
    await sleep(500)
    await walkTo(bot, new goals.GoalNear(lastPos.x, lastPos.y, lastPos.z, 0), 5000).catch(() => {})
    await sleep(1200)
    const after = invText(bot)
    return `killed the ${entity}${after === before ? ' (it dropped nothing you could pick up)' : ''}. Health ${Math.round(bot.health)}/20. Inventory: ${after}`
  },
  async eat (a) {
    const foods = a.mcData.foodsByName
    const it = a.bot.inventory.items().find(i => foods[i.name])
    if (!it) return 'no food in inventory'
    await a.bot.equip(it, 'hand')
    await withTimeout(a.bot.consume(), 6000)
    return `ate ${it.name}. Food: ${a.bot.food}/20`
  },
  async smelt (a, { item, fuel, count = 1 }) {
    const bot = a.bot
    const fb = bot.findBlock({ matching: [a.mcData.blocksByName.furnace.id], maxDistance: 4 })
    if (!fb) return 'no furnace within 4 blocks'
    const inp = findItem(bot, item); const fu = findItem(bot, fuel)
    if (!inp) return `you have no ${item}`
    if (!fu) return `you have no ${fuel}`
    const n = Math.min(count, bot.inventory.count(inp.type), 8)
    const furnace = await bot.openFurnace(fb)
    try {
      await furnace.putFuel(fu.type, null, Math.min(bot.inventory.count(fu.type), Math.ceil(n / 1.5) + 1))
      await furnace.putInput(inp.type, null, n)
      const end = Date.now() + n * 11000 + 5000
      while (Date.now() < end) {
        await sleep(2000)
        const out = furnace.outputItem()
        if (out && out.count >= n) break
      }
      if (furnace.outputItem()) await furnace.takeOutput()
    } finally { furnace.close() }
    return `smelting done. Inventory: ${invText(bot)}`
  },
  async use (a, { item } = {}) {
    if (item) {
      const it = findItem(a.bot, item)
      if (!it) return `you have no ${item}. Inventory: ${invText(a.bot)}`
      await a.bot.equip(it, 'hand')
    }
    a.bot.activateItem()
    await sleep(1200)
    a.bot.deactivateItem()
    return `used ${a.bot.heldItem ? a.bot.heldItem.name : 'empty hand'}. Inventory: ${invText(a.bot)}`
  },
  async use_on (a, { x, y, z, item }) {
    const bot = a.bot
    const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    if (!b) return 'that position is not loaded'
    if (item) {
      const it = findItem(bot, item)
      if (!it) return `you have no ${item}. Inventory: ${invText(bot)}`
      await bot.equip(it, 'hand')
    }
    if (bot.entity.position.distanceTo(b.position) > 4) await walkTo(bot, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 3))
    await bot.lookAt(b.position.offset(0.5, 0.5, 0.5))
    if (/_bed$/.test(b.name)) {
      try { await withTimeout(bot.sleep(b), 8000); return 'sleeping' } catch (e) { return `cannot sleep: ${e.message}` }
    }
    await withTimeout(bot.activateBlock(b), 6000)
    await sleep(500)
    const now = bot.blockAt(b.position)
    return `used ${bot.heldItem ? bot.heldItem.name : 'hand'} on ${b.name} at ${fmt(b.position)}; it is now ${now ? now.name : '?'}. Inventory: ${invText(bot)}`
  },
  async chest (a, { action, item, count = 1 }) {
    const bot = a.bot
    const ids = ['chest', 'trapped_chest', 'barrel'].map(n => a.mcData.blocksByName[n]).filter(Boolean).map(x => x.id)
    const cb = bot.findBlock({ matching: ids, maxDistance: 4 })
    if (!cb) return 'no chest within 4 blocks'
    const win = await withTimeout(bot.openContainer(cb), 8000)
    try {
      const listing = () => {
        const c = {}
        for (const it of win.containerItems()) c[it.name] = (c[it.name] || 0) + it.count
        return Object.entries(c).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'
      }
      if (action === 'list') return `chest holds: ${listing()}`
      const def = a.mcData.itemsByName[item]
      if (!def) return `unknown item "${item}"`
      if (action === 'put') {
        const n = Math.min(count, bot.inventory.count(def.id))
        if (!n) return `you have no ${item}`
        await win.deposit(def.id, null, n)
      } else {
        const have = win.containerItems().filter(i => i.type === def.id).reduce((s, i) => s + i.count, 0)
        if (!have) return `the chest has no ${item}. It holds: ${listing()}`
        await win.withdraw(def.id, null, Math.min(count, have))
      }
      await sleep(300)
      return `done. Chest: ${listing()}. Inventory: ${invText(bot)}`
    } finally { win.close() }
  },
  async scan (a, { radius = 24 } = {}) { return scanText(a, Math.min(48, radius), 40) },
  async ask_adviser (a, { question }) {
    const r = await consultAdviser(`${a.name} asked`, String(question || '').slice(0, 500), a)
    return r.fresh ? `The adviser says: ${r.text}` : `The adviser was asked less than ${cfg.adviser.minGapSeconds}s ago, so here is its latest advice again: ${r.text}`
  },
  async plan (a, { text }) {
    team.plan = String(text).slice(0, 600)
    team.planBy = a.name
    saveTeam()
    for (const o of agents) if (o !== a) o.remember(`EVENT: ${a.name} updated the team plan.`)
    return 'team plan updated'
  },
  async note (a, { text }) { a.notes.push(String(text).slice(0, 300)); a.saveNotes(); return 'noted' },
  async wait (a, { seconds = 30 } = {}) {
    const end = Date.now() + Math.max(1, Math.min(180, Number(seconds) || 30)) * 1000
    const had = a.inbox.length
    while (Date.now() < end) {
      await sleep(1000)
      if (a.inbox.length > had) return `stopped waiting after ${Math.round((Date.now() - (end - Math.max(1, Math.min(180, Number(seconds) || 30)) * 1000)) / 1000)}s: a new message arrived (observe to read it)`
    }
    return 'waited'
  }
}

const BORING = new Set(['air', 'cave_air', 'void_air', 'bedrock', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'water', 'lava', 'snow', 'dead_bush', 'vine', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
function scanText (a, radius, limit) {
  const bot = a.bot
  const me = bot.entity.position
  const seen = new Map()
  const positions = bot.findBlocks({ matching: b => b && !BORING.has(b.name), maxDistance: radius, count: 4000 })
  for (const p of positions) {
    const name = bot.blockAt(p).name
    const d = p.distanceTo(me)
    const cur = seen.get(name)
    if (!cur) seen.set(name, { n: 1, d, p })
    else { cur.n++; if (d < cur.d) { cur.d = d; cur.p = p } }
  }
  const rows = [...seen.entries()].sort((x, y) => x[1].d - y[1].d).slice(0, limit)
  return rows.map(([name, v]) => `${name} (${v.n}, nearest ${fmt(v.p)})`).join('; ') || 'nothing notable'
}

function stateText (a) {
  const bot = a.bot
  const me = bot.entity.position
  const t = bot.time.timeOfDay
  const phase = t < 12000 ? 'day' : t < 13800 ? 'dusk' : t < 22200 ? 'night (hostile mobs spawn)' : 'dawn'
  const ents = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position.distanceTo(me) < 24 && (e.type === 'player' || e.type === 'mob' || e.type === 'hostile' || e.type === 'animal' || e.type === 'passive'))
    .sort((x, y) => x.position.distanceTo(me) - y.position.distanceTo(me)).slice(0, 10)
    .map(e => `${e.username || e.name} at ${fmt(e.position)} (${Math.round(e.position.distanceTo(me))}m)`)
  const mateLines = agents.filter(x => x !== a).map(m => {
    if (!m.ready) return `Teammate ${m.name}: offline`
    const pp = m.bot.entity.position
    return `Teammate ${m.name}: at ${fmt(pp)} (${Math.round(pp.distanceTo(me))}m away), health ${Math.round(m.bot.health)}/20, food ${m.bot.food}/20, ${m.doing ? `busy with: ${m.doing}` : 'idle'}\n  ${m.name} is carrying: ${invText(m.bot).split(', ').slice(0, 14).join(', ')}`
  })
  a.turnsSinceSay = (a.turnsSinceSay || 0) + 1
  const news = a.inbox.splice(0)
  for (const n of news) a.remember(`CHAT ${n}`)
  const below = bot.blockAt(me.offset(0, -1, 0))
  return [
    `Position: ${fmt(me)} (standing on ${below ? below.name : '?'})   Health: ${Math.round(bot.health)}/20   Food: ${bot.food}/20   Time: ${phase}`,
    ...mateLines,
    `Holding: ${bot.heldItem ? bot.heldItem.name : 'nothing'}`,
    `Inventory: ${invText(bot)}`,
    `Nearby entities: ${ents.join('; ') || 'none'}`,
    `Nearby blocks (16m): ${scanText(a, 16, 18)}`,
    `Your notes: ${a.notes.length ? a.notes.slice(-12).map(n => '- ' + n).join(' ') : 'none'}`,
    `Shared team plan${team.planBy ? ` (last written by ${team.planBy})` : ''}: ${team.plan || 'none yet. Agree one with your teammate and write it with the plan tool.'}`,
    `Deaths so far: ${agents.map(x => `${x.name} ${team.deaths[x.name] || 0}`).join(', ')}`,
    team.advice && team.advice.text ? `Adviser's guidance (${Math.max(0, Math.round((Date.now() - team.advice.at) / 60000))} min ago; from a stronger model that watches both of you. Follow it unless it is clearly out of date, and use ask_adviser when stuck):\n${team.advice.text}` : '',
    '',
    'Recent log (oldest first):',
    ...(a.history.length ? a.history : ['(nothing yet)']),
    '',
    news.length ? `NEW MESSAGES since your last turn:\n${news.join('\n')}\nAnswer your teammate with say this turn (reply to what they actually said), then act.` : 'No new messages.',
    !news.length && a.turnsSinceSay > 40 ? `You have not spoken to your teammate for ${a.turnsSinceSay - 1} turns. Check in with say: what you just did, what you need or can spare, and a question or suggestion for them.` : '',
    '',
    'Choose your next action(s).'
  ].join('\n')
}

// Run one tool for a player on behalf of an outside brain (Claude Code through the tool API).
// One tool at a time per player; the result text goes back to the caller and into the player's log.
async function runTool (a, name, input) {
  const prev = a.toolQueue || Promise.resolve()
  let release
  a.toolQueue = new Promise(resolve => { release = resolve })
  await prev
  try {
    if (!a.ready) return 'You are not connected to the world right now (reconnecting). Try again shortly.'
    input = input && typeof input === 'object' ? input : {}
    const fn = Object.prototype.hasOwnProperty.call(impl, name) ? impl[name] : null
    const args = JSON.stringify(input)
    logFile.write(`${new Date().toISOString().slice(11, 19)} [${a.name}] START ${name} ${args}\n`)
    if (name !== 'say') a.doing = `${name} ${Object.values(input).join(' ')}`.slice(0, 80)
    let out
    // long actions are cut short the moment the player takes damage, so it can decide what to do
    const interruptible = ['goto', 'goto_player', 'mine', 'wait', 'smelt', 'give', 'dig', 'chest'].includes(name)
    let hurtTimer = null
    const hurt = new Promise(resolve => { if (interruptible) a.onHurt = () => { hurtTimer = setTimeout(() => resolve('__hurt__'), 150) } })
    try {
      const run = a.bot.run = { cancelled: false }
      out = fn ? await Promise.race([fn(a, input), hurt]) : `unknown tool ${name}`
      if (out === '__hurt__') {
        run.cancelled = true // the interrupted action must not keep walking or digging behind the next one
        haltPath(a.bot); try { a.bot.collectBlock.cancelTask() } catch {}
        out = `INTERRUPTED: ${a.hurt.text}. Your ${name} was stopped. Decide right now: fight back (attack), get away (goto), eat, or block yourself in (place).`
      }
    } catch (e) { out = `FAILED: ${e.message}`; haltPath(a.bot) } finally { a.onHurt = null; clearTimeout(hurtTimer) }
    a.doing = ''
    a.calls++
    if (!['say', 'wait', 'note', 'plan', 'scan'].includes(name) && !/^(FAILED|INTERRUPTED|could not|cannot|no |unknown|you have no|you cannot)/.test(String(out))) a.acts = (a.acts || 0) + 1
    if (name === 'say') a.turnsSinceSay = 0
    log(`[${a.name}] ${name} ${args} -> ${String(out).slice(0, 200)}`)
    a.remember(name === 'say' ? `YOU SAID: ${input.text}` : `ACTION ${name} ${args} -> ${String(out).slice(0, 220)}`)
    return String(out)
  } finally { release() }
}

// ---------------------------------------------------------- decision loop --
async function think (a) {
  const res = await client.messages.create({
    model: cfg.model,
    max_tokens: 4000,
    system: systemPrompt(a),
    tools: TOOLS,
    output_config: { effort: cfg.effort },
    messages: [{ role: 'user', content: stateText(a) }]
  })
  a.calls++
  if (res.stop_reason === 'refusal') { a.remember('NOTE: your last turn produced no action.'); log(`[${a.name}] refusal`); return }
  const uses = res.content.filter(b => b.type === 'tool_use')
  if (!uses.length) {
    const txt = res.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
    a.remember('NOTE: you answered with plain text and no tool call, so nothing happened. Use say to talk.' + (txt ? ` (text was: ${txt.slice(0, 120)})` : ''))
    return
  }
  const did = []
  for (const u of uses.slice(0, 5)) {
    const fn = impl[u.name]
    const args = JSON.stringify(u.input)
    let out
    logFile.write(`${new Date().toISOString().slice(11, 19)} [${a.name}] START ${u.name} ${args}\n`)
    if (u.name !== 'say') a.doing = `${u.name} ${Object.values(u.input || {}).join(' ')}`.slice(0, 80) // shown to the teammate
    try {
      out = fn ? await fn(a, u.input || {}) : `unknown tool ${u.name}`
    } catch (e) {
      out = `FAILED: ${e.message}`
      haltPath(a.bot)
    }
    log(`[${a.name}] ${u.name} ${args} -> ${String(out).slice(0, 200)}`)
    a.doing = ''
    if (u.name === 'say') a.turnsSinceSay = 0
    a.remember(u.name === 'say' ? `YOU SAID: ${u.input.text}` : `ACTION ${u.name} ${args} -> ${String(out).slice(0, 400)}`)
    if (u.name !== 'say') did.push(`${u.name} ${Object.values(u.input || {}).join(' ')}`.trim() + (String(out).startsWith('FAILED') || /^(could not|cannot|no |unknown|you have no)/.test(String(out)) ? ' ✗' : ''))
    if (!a.ready) break
  }
  await postTurnShot(a, did).catch(e => log(`[${a.name}] turn screenshot: ${e.message}`))
}

// Turn the head toward the most open direction, so the picture is not a block in the face.
async function lookOpen (bot) {
  const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
  let best = null
  for (let i = 0; i < 12; i++) {
    const yaw = (i / 12) * Math.PI * 2
    const dir = new Vec3(-Math.sin(yaw), -0.12, -Math.cos(yaw)).normalize()
    let d = 0
    for (; d < 24; d += 1) {
      const b = bot.blockAt(eye.plus(dir.scaled(d + 1)))
      if (!b || b.boundingBox === 'block') break
    }
    // prefer keeping roughly the current heading when it is equally open
    const turn = Math.abs(Math.atan2(Math.sin(yaw - bot.entity.yaw), Math.cos(yaw - bot.entity.yaw)))
    const score = d - turn * 0.8
    if (!best || score > best.score) best = { yaw, score }
  }
  await bot.look(best.yaw, -0.12, true)
}

// After every turn: this bot posts a picture of its own view.
async function postTurnShot (a, did) {
  if (!cfg.discord.turnScreenshots || !viewPage || !a.discord) return
  let ch = a.channel
  if (cfg.discord.streamChannelId) {
    if (!a.shotChannel) a.shotChannel = await a.discord.channels.fetch(cfg.discord.streamChannelId)
    ch = a.shotChannel
  }
  if (!ch) return
  await lookOpen(a.bot).catch(() => {})
  await sleep(900) // let the view catch up
  const idx = agents.indexOf(a)
  const buf = await shoot({ type: 'jpeg', quality: 75, clip: { x: idx * Math.floor(1280 / agents.length), y: 0, width: Math.floor(1280 / agents.length), height: VIEW_H } })
  const p = a.bot.entity.position
  const caption = `${SHOT_TAG} ${did.length ? did.join(' · ').slice(0, 300) : 'talking'}  (at ${fmt(p)})`
  await ch.send({ content: caption, files: [{ attachment: Buffer.from(buf), name: `${a.name.toLowerCase()}.jpg` }] })
}

async function runAgent (a) {
  while (!stopping) {
    if (!a.ready) { await sleep(2000); continue }
    // Their chat lives in Discord: hold the AI until a channel is available.
    if (!NO_DISCORD && cfg.discord.waitForChannel && !agents.some(x => x.channel)) { await sleep(3000); continue }
    if (cfg.maxCallsPerAgent > 0 && a.calls >= cfg.maxCallsPerAgent) { // 0 = no cap
      log(`[${a.name}] reached the cap of ${cfg.maxCallsPerAgent} decisions; idle. Restart to continue.`)
      return
    }
    const t0 = Date.now()
    try { await think(a) } catch (e) {
      log(`[${a.name}] think failed: ${e.status || ''} ${e.message}`)
      await sleep(8000)
    }
    const left = cfg.stepSeconds * 1000 - (Date.now() - t0)
    if (left > 0) await sleep(left)
  }
}

// ------------------------------------------------------------- Discord -----
async function startDiscord () {
  const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js')
  for (const a of agents) {
    const token = process.env[a.spec.tokenEnv]
    if (!token) { log(`[${a.name}] no ${a.spec.tokenEnv}; Discord off for this bot`); continue }
    const dc = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })
    a.discord = dc
    dc.on('messageCreate', m => {
      if (!a.channel || m.channelId !== a.channel.id) return
      if ([STREAM_TAG, SHOT_TAG, SERVER_TAG, RELAY_TAG, ADVISER_TAG].some(t => m.content.startsWith(t))) return
      const text = m.cleanContent.trim()
      if (!text) return
      const author = m.author.bot && agents.find(x => x.discord && x.discord.user && x.discord.user.id === m.author.id)
      const isAgent = !!author
      // only the players hear each other, unless listenToHumans is on or the human is on the allowlist
      const allowed = (cfg.discord.humanAllowlist || []).includes(m.author.username.toLowerCase())
      if (!isAgent && !cfg.discord.listenToHumans && !(allowed && !m.author.bot)) return
      const line = `${isAgent ? author.name : `[human] ${m.author.username}`}: ${text.slice(0, 600)}`
      if (m.author.id !== dc.user.id) a.inbox.push(line)
      // players without a Discord account of their own are fed by the first bot's connection
      if (agents.find(x => x.discord) === a) for (const o of agents) if (!o.discord && o !== author) o.inbox.push(line)
    })
    dc.on('guildCreate', () => pickChannel().catch(e => log('pickChannel: ' + e.message)))
    dc.on('error', e => log(`[${a.name}] discord error: ${e.message}`))
    await dc.login(token)
    await new Promise(r => dc.isReady() ? r() : dc.once('ready', r))
    log(`[${a.name}] Discord ready as ${dc.user.tag} in ${dc.guilds.cache.size} server(s)`)
  }

  async function pickChannel () {
    const first = agents.find(a => a.discord)
    if (!first) return
    let id = cfg.discord.channelId
    if (!id) {
      // a server every bot is in, other than the excluded ones
      const guilds = [...first.discord.guilds.cache.values()].filter(g =>
        !cfg.discord.excludeGuilds.includes(g.id) && agents.every(a => !a.discord || a.discord.guilds.cache.has(g.id)))
      for (const g of guilds) {
        const chans = (await g.channels.fetch()).filter(c => c && c.type === ChannelType.GuildText)
        const me = await g.members.fetchMe()
        const can = c => c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
        let c = chans.find(c => c.name.includes(cfg.discord.preferChannelName) && can(c))
        if (!c && me.permissions.has(PermissionFlagsBits.ManageChannels)) {
          try { c = await g.channels.create({ name: cfg.discord.preferChannelName, type: ChannelType.GuildText }) } catch (e) { log('create channel failed: ' + e.message) }
        }
        if (!c) c = chans.find(can)
        if (c) { id = c.id; break }
      }
    }
    if (!id) { log('Discord: no usable server yet (bots talk in game chat until both are invited to one)'); return }
    for (const a of agents) {
      if (!a.discord) continue
      try { a.channel = await a.discord.channels.fetch(id) } catch (e) { log(`[${a.name}] cannot open channel ${id}: ${e.message}`) }
    }
    const ch = first.channel
    if (ch) log(`Discord channel: #${ch.name} in "${ch.guild.name}"`)
  }
  await pickChannel()
}

// ----------------------------------------------- web page + channel stream -
const STREAM_TAG = '📺'
const SHOT_TAG = '📷'
const SERVER_TAG = '🖥️'
const RELAY_TAG = '💬' // a player without its own Discord account, speaking through the first bot
const ADVISER_TAG = '🧠'

// ------------------------------------------------------------- adviser -----
// A stronger model (Opus) that sees both players and gives strategy. It is asked
// every few minutes, after a death, and whenever a player uses ask_adviser.
// Its advice is shown to both players every turn and posted in Discord.
let adviserBusy = null
async function consultAdviser (reason, question, asker) {
  const ad = cfg.adviser
  if (!ad || !ad.enabled || !client) return { fresh: false, text: 'no adviser is available' }
  const last = team.advice && team.advice.at ? team.advice.at : 0
  if (Date.now() - last < ad.minGapSeconds * 1000 && team.advice.text) return { fresh: false, text: team.advice.text }
  if (adviserBusy) return adviserBusy // one consultation at a time; everyone waiting gets the same answer
  adviserBusy = (async () => {
    const players = agents.map(a => {
      if (!a.ready) return `## ${a.name}: offline`
      const b = a.bot
      return [`## ${a.name}`,
        `Position ${fmt(b.entity.position)}, health ${Math.round(b.health)}/20, food ${b.food}/20, deaths ${team.deaths[a.name] || 0}, ${a.doing ? 'busy with: ' + a.doing : 'idle'}`,
        `Inventory: ${invText(b)}`,
        `Own notes: ${a.notes.slice(-6).join(' | ') || 'none'}`,
        'Recent log (oldest first):', ...a.history.slice(-22)].join('\n')
    }).join('\n\n')
    const t = agents[0].ready ? agents[0].bot.time.timeOfDay : 0
    const prompt = [`Why you are being asked now: ${reason}.`, question ? `Question from ${asker ? asker.name : 'a player'}: ${question}` : '',
      `Time of day: ${t < 12000 ? 'day' : t < 13800 ? 'dusk' : t < 22200 ? 'night' : 'dawn'}. Keep-inventory is OFF: when a player dies, everything they carry drops at the death spot (it disappears after about 5 minutes) and they respawn at the world spawn on the surface with nothing. Dying is now very costly, so weigh safety heavily: armour on, food up, shelter at night, valuables stored in the base chest before risky trips.`,
      `Shared team plan: ${team.plan || 'none'}`, `Your previous advice: ${team.advice && team.advice.text ? team.advice.text : 'none'}`, '', players].filter(Boolean).join('\n')
    const system = `You are the strategy adviser for ${agents.map(a => a.name).join(' and ')}, two AI players cooperating in a Minecraft 1.21 survival world. They are weaker models than you and play through a small set of tools, one or a few tool calls per turn. You cannot act; you only advise, and both of them read your advice every turn until you replace it.

Their goal: ${cfg.goal}

Their tools: ${TOOLS.map(t => t.name).join(', ')}. Notes on the tools: "mine" finds and digs the nearest blocks of a type within 48 blocks and needs the right pickaxe in the inventory; "goto" and "goto_player" walk (and dig) there; "give" walks to the teammate and tosses items; "craft" needs a crafting_table within 4 blocks for 3x3 recipes; "smelt" needs a furnace within 4 blocks; "chest" stores or takes items at a chest within 4 blocks; "use_on" right-clicks a block with an item (flint_and_steel on obsidian, a bucket on water or lava, a bed); "place" puts a block down. They have no tool to see the screen: they only get coordinates, a list of nearby block types, and each other's position and inventory.

Write advice they can act on immediately:
- Start with the single most important thing each player should do next, by name.
- Then the next 3 to 5 steps toward the goal in order, with exact item names, quantities and coordinates taken from their state.
- Call out mistakes you can see in their logs (for example repeated failed actions, a pack full of junk, wandering, splitting up at night, digging straight down into danger, forgetting to eat or wear armour) and say what to do instead.
- If a player asked a question, answer it first.
- Keep it under 220 words, plain sentences, no headings.`
    try {
      const res = await client.messages.create({ model: ad.model, max_tokens: 6000, output_config: { effort: ad.effort || 'medium' }, system, messages: [{ role: 'user', content: prompt }] })
      const text = res.stop_reason === 'refusal' ? '' : res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (!text) { log(`adviser gave no text (stop_reason ${res.stop_reason})`); return { fresh: false, text: team.advice && team.advice.text ? team.advice.text : 'the adviser did not answer' } }
      team.advice = { text: text.slice(0, 2500), at: Date.now(), reason }
      team.adviceCount = (team.adviceCount || 0) + 1
      saveTeam()
      log(`ADVISER (${reason}; ${res.usage.input_tokens} in, ${res.usage.output_tokens} out): ${text.replace(/\s+/g, ' ').slice(0, 400)}`)
      const hub = agents.find(x => x.channel)
      if (hub) { try { await hub.channel.send(`${ADVISER_TAG} **Adviser** (${reason}):\n${text}`.slice(0, 1950)) } catch (e) { log('adviser post failed: ' + e.message) } }
      return { fresh: true, text: team.advice.text }
    } catch (e) {
      log(`adviser failed: ${e.status || ''} ${e.message}`)
      return { fresh: false, text: team.advice && team.advice.text ? team.advice.text : 'the adviser could not be reached' }
    }
  })()
  try { return await adviserBusy } finally { adviserBusy = null }
}
const COLORS = ['#ff9a2e', '#3fe0ff', '#a6ff4d', '#ff6bd6', '#ffe14d']
const serverLines = []
// post queued server messages in small batches (the bots do not read these back)
setInterval(async () => {
  if (!serverLines.length) return
  const ch = agents[0] && agents[0].channel
  if (!cfg.discord.serverMessages) { serverLines.length = 0; return }
  if (!ch) { if (serverLines.length > 50) serverLines.splice(0, serverLines.length - 50); return } // keep them until the channel is ready
  const batch = serverLines.splice(0, 10)
  try { await ch.send(`${SERVER_TAG} ` + batch.join(`\n${SERVER_TAG} `).slice(0, 1800)) } catch (e) { log('server message post failed: ' + e.message) }
}, 2500)
const VIEW_W = 640
const VIEW_H = 400
let viewPage = null
let shotQueue = Promise.resolve()
// one screenshot at a time
function shoot (opts) {
  const run = shotQueue.then(() => viewPage.screenshot(opts))
  shotQueue = run.catch(() => {})
  return run
}
function startWeb () {
  const app = express()
  // ---- tool API for an outside brain (Claude Code). Needs the token in api-token.txt on every call,
  // so nobody on the network or a public link can drive the players.
  const apiToken = require('crypto').randomBytes(24).toString('hex')
  fs.writeFileSync(path.join(HERE, 'api-token.txt'), apiToken)
  const api = express.Router()
  api.use(express.json({ limit: '200kb' }))
  api.use((req, res, next) => req.get('x-token') === apiToken ? next() : res.status(403).json({ error: 'bad token' }))
  const agentOf = req => agents.find(a => a.name.toLowerCase() === String(req.params.agent).toLowerCase())
  api.get('/agents', (req, res) => res.json(agents.map(a => ({ name: a.name, ready: a.ready, model: a.spec.model || null }))))
  api.get('/hurt', (req, res) => res.json(Object.fromEntries(agents.map(a => [a.name, Object.assign(a.hurt ? { seq: a.hurt.seq, at: a.hurt.at, text: a.hurt.text } : { seq: 0 }, { acts: a.acts || 0, inbox: a.inbox.length, night: a.ready ? a.bot.time.timeOfDay > 13000 && a.bot.time.timeOfDay < 23000 : false })]))))
  api.get('/tools', (req, res) => res.json(TOOLS.filter(t => t.name !== 'ask_adviser' || (client && cfg.adviser && cfg.adviser.enabled))))
  api.get('/system/:agent', (req, res) => { const a = agentOf(req); a ? res.json({ text: systemPrompt(a) }) : res.status(404).json({ error: 'no such player' }) })
  api.get('/observe/:agent', (req, res) => {
    const a = agentOf(req)
    if (!a) return res.status(404).json({ error: 'no such player' })
    res.json({ text: a.ready ? stateText(a) : 'You are not connected to the world right now (reconnecting). Wait and observe again.' })
  })
  api.post('/tool/:agent/:tool', async (req, res) => {
    const a = agentOf(req)
    if (!a) return res.status(404).json({ error: 'no such player' })
    try { res.json({ text: await runTool(a, req.params.tool, req.body) }) } catch (e) { res.json({ text: `FAILED: ${e.message}` }) }
  })
  app.use('/api', api)
  // Everything is served from this one port (so one tunnel is enough):
  // /<player>/ and /free/ are passed through to the viewer servers.
  const http = require('http')
  const net = require('net')
  const routes = { '/free': cfg.freePort }
  for (const a of agents) routes['/' + a.name.toLowerCase()] = a.spec.viewerPort
  const bigCache = new Map() // file -> { gz, type }
  const bigPending = new Map()
  const targetOf = url => { for (const p in routes) if (routes[p] && (url === p || url.startsWith(p + '/') || url.startsWith(p + '?'))) return routes[p] }
  app.use((req, res, next) => {
    const port = targetOf(req.url)
    if (!port) return next()
    if (routes[req.url]) return res.redirect(req.url + '/')
    // The viewer's big static files (a 63 MB worker script, 12 MB of block shapes) are identical for every
    // view. Serve them compressed and cacheable, from memory after the first request.
    const clean = req.url.split('?')[0]
    const rel = clean.replace(/^\/[^/]+\//, '')
    if (req.method === 'GET' && /^(worker\.js|index\.js|blocksStates\/[\w.]+\.json)$/.test(rel) && /\bgzip\b/.test(req.get('accept-encoding') || '')) {
      const sendBig = entry => { res.writeHead(200, { 'content-type': entry.type, 'content-encoding': 'gzip', 'content-length': entry.gz.length, 'cache-control': 'public, max-age=604800', vary: 'Accept-Encoding' }); res.end(entry.gz) }
      if (bigCache.has(rel)) return sendBig(bigCache.get(rel))
      if (!bigPending.has(rel)) {
        bigPending.set(rel, new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port, path: clean, headers: { 'accept-encoding': 'identity' } }, up => {
            if (up.statusCode !== 200) { up.resume(); return reject(new Error('status ' + up.statusCode)) }
            const parts = []
            up.on('data', d => parts.push(d))
            up.on('end', () => require('zlib').gzip(Buffer.concat(parts), { level: 6 }, (err, gz) => err ? reject(err) : resolve({ gz, type: up.headers['content-type'] || 'application/octet-stream' })))
            up.on('error', reject)
          }).on('error', reject)
        }).then(entry => { bigCache.set(rel, entry); return entry }).finally(() => bigPending.delete(rel)))
      }
      return bigPending.get(rel).then(sendBig, () => { res.statusCode = 502; res.end('view not ready') })
    }
    const pr = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, up => {
      const headers = { ...up.headers }
      if (req.method === 'GET' && /\.(png|js|json)$/.test(clean)) headers['cache-control'] = 'public, max-age=86400' // textures and scripts never change
      res.writeHead(up.statusCode, headers); up.pipe(res)
    })
    pr.on('error', () => { res.statusCode = 502; res.end('view not ready') })
    req.pipe(pr)
  })
  // The page draws ONE 3D view at a time (each view is a full renderer, and several at once make a browser crawl).
  // Tabs along the top pick a player, the free camera, or all views together. ?shots=1 opens straight in "all" mode
  // (used by the timelapse recorder).
  const page = `<!doctype html><meta charset="utf-8"><title>Minecraft bots</title>
<style>html,body{margin:0;height:100%;background:#111;color:#eee;font:14px system-ui;overflow:hidden}
#tabs{display:flex;gap:6px;padding:6px 8px;height:44px;box-sizing:border-box;background:#1b1b1b;border-bottom:1px solid #000;overflow-x:auto}
.tab{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 12px;border-radius:6px;border:1px solid #333;background:#262626;color:#ddd;cursor:pointer;font:600 14px system-ui;white-space:nowrap}
.tab.on{background:#3a3a3a;border-color:#888;color:#fff}.tab small{font:500 12px system-ui;color:#aaa}
#stage{position:absolute;left:0;right:0;top:44px;bottom:0;display:flex}
.v{flex:1;position:relative;border-right:2px solid #000;min-width:0}
iframe{width:100%;height:100%;border:0;display:block}
.t{position:absolute;left:10px;top:8px;background:#000a;padding:3px 9px;border-radius:4px;font-weight:600;font-size:18px}
.nt{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;background:#050a2a;opacity:0;transition:opacity 2s}
.s{position:absolute;right:10px;top:8px;background:#000a;padding:3px 9px;border-radius:4px;font-weight:600}
.hb{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);display:flex;background:#000b;padding:3px;border-radius:4px}
.sl{width:34px;height:34px;margin:1px;border:2px solid #777;background:#8b8b8b55;position:relative;box-sizing:border-box;overflow:hidden}
.sl.on{border-color:#fff;box-shadow:0 0 0 2px #fff}
.sl img{width:28px;height:28px;position:absolute;left:1px;top:1px;image-rendering:pixelated}
.sl .n{position:absolute;right:1px;bottom:-1px;font:700 13px system-ui;text-shadow:1px 1px 0 #000,-1px -1px 0 #000}
.sl .x{position:absolute;left:1px;top:1px;right:1px;font:600 8px/9px system-ui;word-break:break-all}</style>
<div id="tabs"></div><div id="stage"></div>
<script>
const PLAYERS = ${JSON.stringify(agents.map((a, i) => ({ name: a.name, path: '/' + a.name.toLowerCase() + '/', color: COLORS[i % COLORS.length] })))}
const HAS_FREE = ${cfg.freePort ? 'true' : 'false'}
let mode = new URLSearchParams(location.search).has('shots') ? 'all' : (decodeURIComponent(location.hash.slice(1)) || PLAYERS[0].name)
let state = []
function dark (t) { return t < 12000 ? 0 : t < 13800 ? (t - 12000) / 1800 : t < 22200 ? 1 : 1 - (t - 22200) / 1800 }
function viewHtml (p) { return '<div class="v" data-name="' + p.name + '"><iframe src="' + p.path + '"></iframe><div class="nt"></div><div class="t" style="color:' + p.color + '">' + p.name + '</div><div class="s"></div><div class="hb"></div></div>' }
function build () {
  const stage = document.getElementById('stage')
  if (mode === 'all') stage.innerHTML = PLAYERS.map(viewHtml).join('')
  else if (mode === 'free') stage.innerHTML = '<div class="v"><iframe src="/free/"></iframe><div class="nt"></div><div class="t">Free camera: drag to look around, wheel to zoom, right-drag to move. Each cage is the colour of that player name</div></div>'
  else stage.innerHTML = viewHtml(PLAYERS.find(p => p.name === mode) || PLAYERS[0])
  if (!new URLSearchParams(location.search).has('shots')) location.hash = encodeURIComponent(mode)
  tabs(); paint()
}
function tabs () {
  const el = document.getElementById('tabs')
  el.innerHTML = ''
  const add = (key, html) => { const b = document.createElement('div'); b.className = 'tab' + (mode === key ? ' on' : ''); b.innerHTML = html; b.onclick = () => { if (mode !== key) { mode = key; build() } }; el.appendChild(b) }
  PLAYERS.forEach(p => {
    const a = state.find(x => x.name === p.name)
    add(p.name, '<span style="color:' + p.color + '">' + p.name + '</span><small>' + (!a ? '' : a.offline ? 'offline' : '\\u2764 ' + a.health + '  \\ud83c\\udf57 ' + a.food + '  \\u2620 ' + a.deaths) + '</small>')
  })
  if (HAS_FREE) add('free', 'Free camera')
  add('all', 'All views <small>(heavy)</small>')
}
function paint () {
  const lit = state.find(a => !a.offline)
  if (lit) document.querySelectorAll('.nt').forEach(e => { e.style.opacity = 0.62 * dark(lit.time) })
  document.querySelectorAll('.v[data-name]').forEach(v => {
    const a = state.find(x => x.name === v.dataset.name)
    if (!a) return
    v.querySelector('.s').textContent = (a.offline ? 'offline' : '\\u2764 ' + a.health + '/20   \\ud83c\\udf57 ' + a.food + '/20   ' + (dark(a.time) > 0.5 ? '\\ud83c\\udf19 night' : '\\u2600 day')) + '   \\u2620 ' + a.deaths
    const hb = v.querySelector('.hb')
    hb.innerHTML = ''
    for (let k = 0; k < 9; k++) {
      const it = (a.hotbar || [])[k]
      const d = document.createElement('div')
      d.className = 'sl' + (k === a.selected ? ' on' : '')
      if (it) {
        if (it.icon) { const im = document.createElement('img'); im.src = it.icon; d.appendChild(im) }
        else { const x = document.createElement('div'); x.className = 'x'; x.textContent = it.name.replace(/_/g, ' '); d.appendChild(x) }
        if (it.count > 1) { const n = document.createElement('div'); n.className = 'n'; n.textContent = it.count; d.appendChild(n) }
      }
      hb.appendChild(d)
    }
  })
}
async function tick () { try { state = await (await fetch('/state')).json(); tabs(); paint() } catch (e) {} }
build(); tick(); setInterval(tick, 1500)
</script>`
  app.get('/', (req, res) => res.send(page))
  // hotbar + health for the overlay on each view
  let icons = null
  try { icons = require('minecraft-assets')(cfg.mcVersion).textureContent } catch (e) {
    try { icons = require('minecraft-assets')('1.21.1').textureContent } catch { log('no item icons: ' + e.message) }
  }
  const iconCache = {}
  const iconFor = name => {
    if (!(name in iconCache)) iconCache[name] = (icons && icons[name] && icons[name].texture) || null
    return iconCache[name]
  }
  app.get('/state', (req, res) => res.json(agents.map(a => {
    if (!a.ready) return { name: a.name, offline: true, deaths: team.deaths[a.name] || 0, hotbar: [] }
    const bot = a.bot
    const hotbar = []
    for (let i = 0; i < 9; i++) {
      const it = bot.inventory.slots[36 + i]
      hotbar.push(it ? { name: it.name, count: it.count, icon: iconFor(it.name) } : null)
    }
    return { name: a.name, health: Math.round(bot.health), food: bot.food, time: bot.time.timeOfDay, deaths: team.deaths[a.name] || 0, selected: bot.quickBarSlot, hotbar }
  })))
  app.get('/frame.jpg', (req, res) => {
    const f = path.join(HERE, 'frames', 'latest.jpg')
    fs.existsSync(f) ? res.sendFile(f) : res.status(404).end()
  })
  const server = app.listen(cfg.webPort, cfg.webHost || '0.0.0.0', () => log(`both views: http://localhost:${cfg.webPort}/`))
  server.on('upgrade', (req, socket, head) => {
    const port = targetOf(req.url)
    if (!port) return socket.destroy()
    const up = net.connect(port, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
      if (head && head.length) up.write(head)
      socket.pipe(up); up.pipe(socket)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
}

async function startStream () {
  let puppeteer
  try { puppeteer = require('puppeteer-core') } catch { log('stream: puppeteer-core not installed; channel stream off'); return }
  fs.mkdirSync(path.join(HERE, 'frames'), { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: cfg.chromePath,
    headless: 'new',
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio', '--window-size=1280,400', `--user-data-dir=${path.join(HERE, '.chrome-profile')}`]
  })
  browserRef = browser
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 400 })
  await page.goto(`http://127.0.0.1:${cfg.webPort}/?shots=1`, { waitUntil: 'load' })
  viewPage = page
  log('stream: capturing frames')
  let msg = null
  let busy = false
  const started = Date.now()
  setInterval(async () => {
    if (busy || stopping) return
    busy = true
    try {
      const buf = await shoot({ type: 'jpeg', quality: 72 })
      fs.writeFileSync(path.join(HERE, 'frames', 'latest.jpg'), buf)
      let ch = cfg.discord.liveMessage ? agents[0].channel : null
      if (cfg.discord.liveMessage && cfg.discord.streamChannelId && agents[0].discord) {
        if (!streamChannel) streamChannel = await agents[0].discord.channels.fetch(cfg.discord.streamChannelId)
        ch = streamChannel
      }
      if (ch) {
        const mins = Math.floor((Date.now() - started) / 60000)
        const payload = { content: `${STREAM_TAG} Live view: ${agents[0].name} (left), ${agents[1].name} (right). Running ${mins} min.`, files: [{ attachment: Buffer.from(buf), name: 'view.jpg' }], attachments: [] }
        if (!msg || msg.channelId !== ch.id) msg = await ch.send(payload)
        else await msg.edit(payload)
      }
    } catch (e) { log('stream: ' + e.message); if (/Unknown Message/.test(e.message)) msg = null }
    busy = false
  }, cfg.discord.streamSeconds * 1000)
}

// Mark where each bot is: a tall coloured cage around it, drawn in the free
// camera (both bots) and in each first-person view (the partner).
const MARK = [0xff8a1e, 0x2fd8ff, 0xa6ff4d, 0xff6bd6, 0xffe14d]
function startHighlights () {
  const last = {}
  setInterval(() => {
    for (const viewer of agents) {
      if (!viewer.ready || !viewer.viewers) continue
      viewer.viewers.forEach((v, vi) => {
        agents.forEach((target, ti) => {
          const isFree = vi === 1
          if (!isFree && target === viewer) return // not around your own head
          if (!target.ready) return
          const p = target.bot.entity.position
          const key = `${viewer.name}:${vi}:${ti}`
          const sig = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`
          if (last[key] === sig) return
          last[key] = sig
          const h = isFree ? 40 : 12
          const c = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([dx, dz]) => [p.offset(dx, 0, dz), p.offset(dx, h, dz)])
          try {
            v.drawBoxGrid(`box${ti}`, p.offset(-0.5, 0, -0.5), p.offset(0.5, 2, 0.5), MARK[ti])
            v.drawLine(`beam${ti}`, [c[0][0], c[0][1], c[1][1], c[1][0], c[2][0], c[2][1], c[3][1], c[3][0], c[0][0]], MARK[ti])
          } catch {}
        })
      })
    }
  }, 500)
}

// ------------------------------------------------------------------ main ---
let stopping = false
let browserRef = null
let streamChannel = null
async function shutdown () {
  if (stopping) return
  stopping = true
  log('stopping')
  for (const a of agents) { try { a.bot.quit() } catch {} ; try { a.discord && a.discord.destroy() } catch {} }
  try { browserRef && await browserRef.close() } catch {}
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', e => log('unhandled: ' + (e && e.message)))
process.on('uncaughtException', e => log('uncaught: ' + (e && e.stack)))

;(async () => {
  fs.writeFileSync(path.join(HERE, 'main.pid'), String(process.pid))
  try { new (require('worker_threads').Worker)(path.join(HERE, 'memwatch.js'), { workerData: { limitMB: 350, hardMB: 1000, dir: HERE } }).unref() } catch (e) { log('memwatch not started: ' + e.message) }
  for (const spec of cfg.agents) agents.push(makeAgent(spec))
  for (const a of agents) { connect(a); await sleep(3000) }
  startWeb()
  startHighlights()
  if (!NO_DISCORD) await startDiscord().catch(e => log('discord start failed: ' + e.message))
  await sleep(4000)
  // the hidden browser is only needed when pictures are posted to Discord
  if (!process.argv.includes('--no-stream') && (cfg.discord.turnScreenshots || cfg.discord.liveMessage)) startStream().catch(e => log('stream start failed: ' + e.message))
  setInterval(() => {
    const heap = Math.round(process.memoryUsage().heapUsed / 1e6)
    if (heap > 400) log(`mem heap ${heap}MB`)
    if (heap > 600) for (const a of agents) { try { a.bot.pathfinder.setGoal(null) } catch {} }
    if (heap > 1100) { log('memory too high; restarting'); process.exit(3) }
  }, 5000)
  // one-off announcement to the players: put text in announce.txt and restart
  try {
    const f = path.join(HERE, 'announce.txt')
    const text = fs.readFileSync(f, 'utf8').trim()
    if (text) for (const a of agents) a.inbox.push(`[world rules] ${text}`)
    fs.unlinkSync(f)
  } catch {}
  if (!NO_AI) for (const a of agents) { runAgent(a); await sleep(2000) }
  if (!NO_AI && cfg.adviser && cfg.adviser.enabled) {
    const tickAdviser = () => { if (agents.some(a => a.ready) && (NO_DISCORD || !cfg.discord.waitForChannel || agents.some(x => x.channel))) consultAdviser('regular check-in', '', null).catch(() => {}) }
    setTimeout(tickAdviser, 45000)
    setInterval(tickAdviser, cfg.adviser.everyMinutes * 60000)
  }
  else log('--no-ai: bots are idle')
})()
