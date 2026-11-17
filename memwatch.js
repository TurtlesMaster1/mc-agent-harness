// Runs in a worker thread and watches the main program's memory from outside,
// so it still works when the main thread is stuck in a busy loop.
// When the heap balloons it writes which code allocated the live memory to memdiag-*.txt.
const { workerData } = require('worker_threads')
const inspector = require('inspector')
const fs = require('fs')
const path = require('path')

const LIMIT = (workerData && workerData.limitMB ? workerData.limitMB : 500) * 1e6
const HARD = (workerData && workerData.hardMB ? workerData.hardMB : 1000) * 1e6
const dir = (workerData && workerData.dir) || __dirname
const s = new inspector.Session()
s.connectToMainThread()
setInterval(() => {}, 1000) // keep this worker alive while it waits for inspector replies
const post = (m, p) => new Promise((resolve, reject) => s.post(m, p || {}, (e, r) => e ? reject(e) : resolve(r)))

;(async () => {
  await post('HeapProfiler.enable')
  await post('HeapProfiler.startSampling', { samplingInterval: 2 * 1024 * 1024 })
  let last = 0
  let n = 0
  let hardRecorded = false
  setInterval(async () => {
    try {
      const u = await post('Runtime.getHeapUsage')
      // far past normal: record what we can, then end the program at once so it restarts in seconds
      // instead of freezing for most of a minute while it runs out of memory
      const hard = u.usedSize > HARD
      const endNow = () => {
        try { fs.appendFileSync(path.join(dir, 'memdiag-kills.txt'), new Date().toISOString() + ' heap ' + (u.usedSize / 1e6).toFixed(0) + ' MB, restarting\n') } catch {}
        process.kill(process.pid)
      }
      if (u.usedSize < LIMIT) return
      // one record per spike (always one at the hard limit), at most 6 files in total
      if ((Date.now() - last < 20000 && !(hard && !hardRecorded)) || n >= 6) { if (hard) endNow(); return }
      if (hard) hardRecorded = true
      last = Date.now(); n++
      if (hard) setTimeout(endNow, 4000) // even if the record below gets stuck
      const { profile } = await post('HeapProfiler.getSamplingProfile')
      const rows = []
      ;(function walk (node, stack) {
        const f = node.callFrame
        const where = `${f.functionName || '(anonymous)'}  ${String(f.url).split(/[\\/]/).slice(-3).join('/')}:${f.lineNumber + 1}`
        const st = stack.concat(where)
        if (node.selfSize > 0) rows.push({ size: node.selfSize, st })
        for (const c of node.children || []) walk(c, st)
      })(profile.head, [])
      rows.sort((a, b) => b.size - a.size)
      const total = rows.reduce((t, r) => t + r.size, 0)
      const out = [`time ${new Date().toISOString()}`, `heap used ${(u.usedSize / 1e6).toFixed(0)} MB, sampled live ${(total / 1e6).toFixed(0)} MB`, '',
        ...rows.slice(0, 12).map(r => `${(r.size / 1e6).toFixed(0)} MB\n   ` + r.st.slice(-10).reverse().join('\n   '))].join('\n')
      fs.writeFileSync(path.join(dir, `memdiag-${n}.txt`), out)
      if (hard) endNow()
    } catch (e) {
      try { fs.appendFileSync(path.join(dir, 'memdiag-errors.txt'), e.message + '\n') } catch {}
    }
  }, 300)
})().catch(e => { try { fs.appendFileSync(path.join(dir, 'memdiag-errors.txt'), 'start: ' + e.message + '\n') } catch {} })
