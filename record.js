// Timelapse of both bots' views (with hotbars): one frame per second,
// encoded straight into a video that plays at 30 frames per second,
// so one hour of play becomes two minutes of video. No frames are kept on disk.
//   node record.js            run until stop-record.cmd
//   node record.js 20         run for 20 seconds (test)
// A new file starts every 2 hours; files stay playable even if the recorder is killed.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const puppeteer = require('puppeteer-core')
const cfg = require('./config.json')

const OUT = path.join(__dirname, 'recordings')
const STOP = path.join(OUT, 'STOP')
const FRAME_MS = 1000
const FRAMES_PER_FILE = 7200
const RELOAD_EVERY = 300 // frames; picks the views back up after the bots restart
const limitMs = process.argv[2] ? Number(process.argv[2]) * 1000 : Infinity
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}` }
const log = (...a) => { const line = `${new Date().toTimeString().slice(0, 8)} ${a.join(' ')}`; console.log(line); try { fs.appendFileSync(path.join(OUT, 'recorder.log'), line + '\n') } catch {} }

let browser = null
let page = null
async function openPage () {
  try { browser && await browser.close() } catch {}
  browser = await puppeteer.launch({
    executablePath: cfg.chromePath,
    headless: 'new',
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio', '--window-size=1280,720',
      `--user-data-dir=${path.join(__dirname, '.chrome-recorder')}`]
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  await page.goto(`http://127.0.0.1:${cfg.webPort}/?shots=1`, { waitUntil: 'load', timeout: 20000 })
  await sleep(5000) // let the world load
}

function startEncoder () {
  const file = path.join(OUT, `timelapse_${stamp()}.mp4`)
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-g', '60', '-pix_fmt', 'yuv420p', '-flush_packets', '1',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  ff.stderr.on('data', d => log('ffmpeg:', String(d).trim().slice(0, 200)))
  ff.stdin.on('error', () => {})
  log('writing', file)
  return { ff, file, frames: 0 }
}
function finish (enc) {
  return new Promise(resolve => { enc.ff.on('close', resolve); enc.ff.stdin.end(); setTimeout(resolve, 15000) })
    .then(() => log(`saved ${enc.file} (${enc.frames} frames, ${Math.round(fs.statSync(enc.file).size / 1024)} KB)`))
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  try { fs.unlinkSync(STOP) } catch {}
  fs.writeFileSync(path.join(OUT, 'recorder.pid'), String(process.pid))
  let enc = startEncoder()
  const started = Date.now()
  let sinceReload = 0
  let next = Date.now()
  while (!fs.existsSync(STOP) && Date.now() - started < limitMs) {
    try {
      if (!page || sinceReload >= RELOAD_EVERY) { if (page && browser) { await page.reload({ waitUntil: 'load', timeout: 20000 }); await sleep(4000) } else await openPage(); sinceReload = 0 }
      const buf = await page.screenshot({ type: 'jpeg', quality: 82 })
      if (!enc.ff.stdin.write(Buffer.from(buf))) await new Promise(r => enc.ff.stdin.once('drain', r))
      enc.frames++
      sinceReload++
      if (enc.frames >= FRAMES_PER_FILE) { await finish(enc); enc = startEncoder() }
    } catch (e) {
      // bots stopped, page gone, or the hidden browser was closed: wait and reopen
      log('capture problem:', e.message.slice(0, 120))
      page = null
      await sleep(10000)
    }
    next += FRAME_MS
    const wait = next - Date.now()
    if (wait > 0) await sleep(wait); else next = Date.now()
  }
  await finish(enc)
  try { await browser.close() } catch {}
  try { fs.unlinkSync(STOP) } catch {}
  try { fs.unlinkSync(path.join(OUT, 'recorder.pid')) } catch {}
  process.exit(0)
})().catch(e => { log('recorder failed:', e.message); process.exit(1) })
