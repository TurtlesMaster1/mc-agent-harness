# mc-agent-harness

LLM agents that play survival Minecraft together. Each agent is a real player on a normal Java server. It
thinks through short headless [Claude Code](https://claude.com/claude-code) sessions, so it runs on a
claude.ai subscription login and needs no API key.

- **Body** (`main.js`): one [mineflayer](https://github.com/PrismarineJS/mineflayer) player per agent, a
  browser page with a live 3D view of each player, optional Discord chat, a shared team plan, per-agent
  notes and a death counter.
- **Brains** (`brains.js`): for each agent, a loop of stateless `claude -p` turns whose only tools are that
  agent's Minecraft tools.
- **Tools** (`mcp.js`): a small stdio MCP server that hands one agent's tools to Claude Code by calling the
  body's local, token-guarded HTTP API.

Tools the agents get: `observe`, `say`, `goto`, `goto_player`, `mine`, `craft`, `place`, `dig`, `give`,
`equip`, `attack`, `eat`, `smelt`, `use`, `use_on`, `chest`, `scan`, `plan`, `note`, `wait`.

## Requirements

- Node.js 20 or newer
- Java 21 and a Minecraft Java server jar, version 1.21.4
- Claude Code installed and signed in (`claude` on PATH)
- Windows for the `start.cmd` / `stop.cmd` launchers. The three Node programs themselves are not
  Windows-specific, but only Windows has been tried.
- Optional: `cloudflared` on PATH for public links, Chrome for Discord screenshots and timelapse recording

## Setup

```
npm install
copy config.example.json config.json
```

Put the server in `server\`:

1. Download the 1.21.4 server jar from minecraft.net and save it as `server\server.jar`.
2. Run it once (`java -jar server.jar nogui` inside `server\`), then set `eula=true` in `server\eula.txt`.
3. In `server\server.properties` set `online-mode=false` (the agents join without Microsoft accounts) and
   `enforce-secure-profile=false`. Leave `pvp=true` if the agents should be able to fight.

An offline-mode server lets anyone join under any name. Keep it on your own machine or network unless you
know what you are exposing.

## Run

```
start.cmd        server (if not already up), bodies, brains
stop.cmd         bodies and brains
stop.cmd all     also the server and tunnels
```

Views are at `http://localhost:3000/`. Logs: `run.log` (every action), `brains.log` (one line per turn with
tokens and remaining usage).

By hand, on any OS: start the server, then `node supervisor.js`, then `node brains.js`.
`node brains.js Clade 1` runs a single turn for one agent, which is a good first test.

## config.json

| Key | Meaning |
| --- | --- |
| `agents[]` | `name` (the Minecraft username), `model` and `effort` for Claude Code (`opus`, `sonnet`, `haiku`), `pauseSeconds` between turns, `viewerPort`, `tokenEnv` (name of the Discord token variable) |
| `goal` | The instructions every agent gets. This is where you say what they are trying to do. |
| `brain` | `claude-code` for subscription turns through Claude Code. Any other value makes `main.js` call the Anthropic API itself with `ANTHROPIC_API_KEY`. |
| `claudeCode.concurrency` | How many turns may run at once |
| `claudeCode.usage` | `haltBelowPercent`: stop starting turns when a usage window has less than this left, until it resets. `burn`: near the 5-hour reset, if plenty is unused, switch every agent to `burn.model`. |
| `discord` | Off by default. With bot tokens in `.env`, agents' `say` goes to a channel. |
| `publicView`, `publicMinecraft` | Open Cloudflare quick tunnels to the view page / the server. `publicMinecraft` also starts the Warden. |
| `wardenExempt` | Player names the Warden leaves alone |

## Bring your bots to someone else's server

Your bots run on your machine and your Claude subscription; only their Minecraft players connect to the
host's server. Your team keeps its own plan and notes, and `say` goes to the server chat, so every team
hears it.

1. Pick bot names nobody else is using and send them to the host (in this repo: open a
   "Register a bot" issue). Until the host has added the names, the Warden puts your bots in spectator.
2. In `config.json` set `agents` to your bots and write your own `goal`.
3. Point at the server:
   - a normal address: set `mcHost` and `mcPort`;
   - a Cloudflare tunnel name (`something.trycloudflare.com`): install `cloudflared`, set `joinHost` to
     that name and leave `mcHost` at `127.0.0.1`. `start.cmd` opens the forward for you.
4. `start.cmd`. In join mode it does not start a local server or a Warden.

## Host other people's bots

1. Set `publicMinecraft: true` (needs `cloudflared`) or forward the server port yourself, and give people
   the address.
2. Copy `guests.example.json` to `guests.json` and list the bot names you accept. The Warden re-reads the
   file every 15 seconds, so you can add names while it runs; a bot that joined early is switched back to
   survival once its name is listed.
3. Everyone not in `agents`, `wardenExempt` or `guests.json` stays a spectator.

The server is in offline mode, so a name is not proof of who is behind it: anyone who knows a listed name
can join as it while the real bot is offline. Fine among friends; for a real competition turn on the
server whitelist as well and restart the tunnel address between events. Quick-tunnel addresses change
every time the tunnel restarts.

## Usage cost

Turns draw on the same allowance as your own Claude Code use. A Sonnet turn at low effort is roughly 3k new
plus 15-25k cached input tokens; Opus turns are several times heavier. Two Opus agents can use a quarter of
a 5-hour window in half an hour. The halt rule exists so the agents stop before you are locked out.

## Warden

`warden.js` is an operator player that puts every visitor who is not an agent into spectator mode, so a
public server can be watched but not touched. Make it an operator first (`op Warden` in the server console).

## Licence

MIT
