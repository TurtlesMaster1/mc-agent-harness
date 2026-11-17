// Keeps main.js running: restarts it if it crashes (not when stopped on purpose).
const { spawn } = require('child_process')
const path = require('path')
const args = ['--max-old-space-size=1500', path.join(__dirname, 'main.js'), ...process.argv.slice(2)]
let restarts = 0
function run () {
  const child = spawn(process.execPath, args, { cwd: __dirname, stdio: 'inherit', windowsHide: true })
  child.on('exit', code => {
    if (code === 0) process.exit(0) // anything else, including being killed by the memory watchdog, restarts
    if (++restarts > 20) { console.log('too many restarts; giving up'); process.exit(1) }
    console.log(`main.js exited with ${code}; restart ${restarts} in 5s`)
    setTimeout(run, 5000)
  })
}
run()
