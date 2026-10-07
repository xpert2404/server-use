// Real sshd + cron + curl + Python stdlib HTTP receiver: checks the complete CLI/daemon/script contract.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { skip, sandbox, until, RUN } from './helpers.mjs'

describe('e2e: check and watch', { skip }, () => {
  let s
  const host = `e2e-check-${RUN}`
  const cron = `cw-${RUN}`
  const httpjob = `cw-http-${RUN}`
  const remoteDir = `.server-use/e2e-watch-${RUN}`
  const key = `watch-hmac-${RUN}-private`
  const allKinds = 'disk,inodes,mem,oom,unit,container,cron,job,deploy,cert,backup,reboot,updates,ssh,watch'
  const su = (args, options = {}) => s.su(args, { timeout: 120_000, ...options })
  const sh = (cmd) => s.sh(host, cmd)
  const setCheck = async (spec) => {
    const r = await su(['set', host, `check=${spec}`]); assert.equal(r.code, 0, r.all)
  }
  const watchRun = async () => {
    const r = await su(['cron', 'run', host, 'watch'])
    assert.equal(r.code, 0, r.all); return r
  }
  const records = async () => {
    const r = await sh(`cat "$HOME/${remoteDir}/requests.jsonl" 2>/dev/null || true`)
    return r.out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  before(async () => {
    s = sandbox()
    await s.add(host, 'alice')
    assert.equal((await su(['set', host, 'policy=open'])).code, 0)
  })
  after(async () => {
    if (s) {
      await su(['watch', 'off', host, '--yes']).catch(() => {})
      await su(['cron', 'rm', host, cron, '--yes']).catch(() => {})
      await su(['job', 'stop', host, httpjob, '--yes']).catch(() => {})
      await sh(`rm -rf "$HOME/${remoteDir}" "$HOME/.server-use/jobs/${httpjob}"`).catch(() => {})
      await s.cleanup()
    }
  })

  test('check reports real disk findings, tracks new/ongoing/resolved, and exits 10 only as documented', async () => {
    const skipExceptDisk = allKinds.split(',').filter((kind) => kind !== 'disk').join(',')
    await setCheck(`disk=0 skip=${skipExceptDisk}`)
    const first = await su(['check', host, '--json'])
    assert.equal(first.code, 10, first.all)
    assert.ok(JSON.parse(first.out).results[0].items.some((i) => i.kind === 'disk' && i.state === 'new'))
    const same = await su(['check', host, '--changed', '--json'])
    assert.equal(same.code, 0, same.all)
    assert.ok(JSON.parse(same.out).results[0].items.some((i) => i.kind === 'disk' && i.state === 'ongoing'))
    await setCheck(`skip=${allKinds}`)
    const recovered = await su(['check', host, '--changed', '--json'])
    assert.equal(recovered.code, 10, recovered.all)
    assert.ok(JSON.parse(recovered.out).results[0].resolved.some((i) => i.kind === 'disk'))
    const healthy = await su(['check', host]); assert.equal(healthy.code, 0, healthy.all); assert.match(healthy.out, /all 1 server ok/)
  })

  test('failed cron and missing configured backup both need attention, and a dead host never hides the healthy one', async () => {
    let r = await su(['cron', 'add', host, cron, '0 0 * * *', 'exit 7', '--yes'])
    assert.equal(r.code, 0, r.all)
    r = await su(['cron', 'run', host, cron]); assert.equal(r.code, 7, r.all)
    await setCheck(`backup=/tmp/server-use-${RUN}-missing:24 skip=${allKinds.split(',').filter((k) => !['cron', 'backup'].includes(k)).join(',')}`)
    r = await su(['check', host, '--json']); assert.equal(r.code, 10, r.all)
    const items = JSON.parse(r.out).results[0].items
    assert.ok(items.some((i) => i.kind === 'cron' && i.id === cron))
    assert.ok(items.some((i) => i.kind === 'backup' && /missing/.test(i.text)))
    await su(['cron', 'rm', host, cron, '--yes'])
    await setCheck(`skip=${allKinds}`)
    const dead = `e2e-dead-${RUN}`
    // Inventory-only clone on a closed local port; avoids an onboarding login to an unreachable address.
    const { readFileSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { default: YAML } = await import('yaml')
    const inventoryPath = join(s.home, 'servers.yaml')
    const original = readFileSync(inventoryPath, 'utf8')
    // The inventory writer may keep a flow-style root mapping; append through the YAML document API.
    const document = YAML.parseDocument(original)
    assert.equal(document.errors.length, 0)
    document.set(dead, { host: '127.0.0.1', port: 1, user: 'alice', policy: 'readonly' })
    writeFileSync(inventoryPath, String(document))
    try {
      r = await su(['check', `${dead},${host}`, '--json']); assert.equal(r.code, 5, r.all)
      const rows = JSON.parse(r.out).results
      assert.ok(rows.find((x) => x.host === dead).items.some((i) => i.kind === 'connect'))
      assert.equal(rows.find((x) => x.host === host).items.length, 0)
    } finally { writeFileSync(inventoryPath, original) }
  })

  test('watch installs cron, signs real webhook requests, debounces HTTP faults/recovery, mutes and sends heartbeat', { timeout: 240_000 }, async () => {
    const server = `from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json,time
p=Path.home()/"${remoteDir}"
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  code=int((p/"code").read_text()) if self.path=="/health" else 204
  with (p/"requests.jsonl").open("a") as f: f.write(json.dumps({"method":"GET","path":self.path})+"\\n")
  self.send_response(code); self.end_headers()
 def do_POST(self):
  time.sleep(1)
  body=self.rfile.read(int(self.headers.get("Content-Length","0"))).decode()
  with (p/"requests.jsonl").open("a") as f: f.write(json.dumps({"method":"POST","body":body,"signature":self.headers.get("X-Server-Use-Signature","")})+"\\n")
  self.send_response(204); self.end_headers()
server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
(p/"port").write_text(str(server.server_port))
server.serve_forever()
`
    let r = await sh(`mkdir -p "$HOME/${remoteDir}"\nprintf 204 >"$HOME/${remoteDir}/code"\ncat >"$HOME/${remoteDir}/server.py" <<'PY'\n${server}PY\n`)
    assert.equal(r.code, 0, r.err)
    r = await su(['job', 'start', host, httpjob, `python3 "$HOME/${remoteDir}/server.py"`, '--yes'])
    assert.equal(r.code, 0, r.all)
    await until(async () => (await sh(`test -s "$HOME/${remoteDir}/port"`)).code === 0 || 'HTTP capture server has not started', 30_000, 500)
    const port = (await sh(`cat "$HOME/${remoteDir}/port"`)).out.trim()
    const base = `http://127.0.0.1:${port}`
    await setCheck(`skip=${allKinds}`)
    r = await su(['watch', 'on', host, '--every', '1h', '--notify', `webhook:${base}/notify`, '--stdin', '--url', `${base}/health=204`, '--heartbeat', `${base}/heartbeat`, '--yes'], { input: key })
    assert.equal(r.code, 0, r.all)
    assert.match((await su(['cron', 'ls', host])).out, /watch/)
    assert.match((await su(['watch', 'ls', host])).out, /notify webhook/)
    const testing = su(['watch', 'test', host, '--yes'])
    // The receiver delays a response so curl is still live while we inspect its process arguments.
    await until(async () => (await sh('ps -eo args | grep "[c]url --disable --config" | grep -q -- "--config -"')).code === 0 || 'notification curl is not live yet', 15_000, 100)
    assert.equal((await sh('ps -eo args | grep "[c]url --disable --config" | grep -q watch-hmac && exit 1 || exit 0')).code, 0)
    r = await testing; assert.equal(r.code, 0, r.all)
    const first = (await records()).find((record) => record.method === 'POST')
    assert.equal(first.signature, `sha256=${createHmac('sha256', key).update(first.body).digest('hex')}`)
    assert.match(JSON.parse(first.body).message, /test notification/)
    await sh(`printf 503 >"$HOME/${remoteDir}/code"`)
    await watchRun(); assert.equal((await records()).filter((x) => x.method === 'POST').length, 1)
    await watchRun(); assert.equal((await records()).filter((x) => x.method === 'POST').length, 2)
    assert.match(JSON.parse((await records()).filter((x) => x.method === 'POST').at(-1).body).message, /HTTP probe 1 returned 503/)
    await watchRun(); assert.equal((await records()).filter((x) => x.method === 'POST').length, 2)
    await sh(`printf 204 >"$HOME/${remoteDir}/code"`)
    await watchRun(); assert.equal((await records()).filter((x) => x.method === 'POST').length, 2)
    await watchRun(); assert.equal((await records()).filter((x) => x.method === 'POST').length, 3)
    assert.match(JSON.parse((await records()).filter((x) => x.method === 'POST').at(-1).body).message, /RESOLVED http:1/)
    r = await su(['watch', 'mute', host, 'http:1', '--for', '1h', '--yes']); assert.equal(r.code, 0, r.all)
    await sh(`printf 503 >"$HOME/${remoteDir}/code"`); await watchRun(); await watchRun()
    assert.equal((await records()).filter((x) => x.method === 'POST').length, 3)
    assert.ok((await records()).some((x) => x.path === '/heartbeat'))
    r = await su(['watch', 'mute', host, 'http:1', '--for', '0', '--yes']); assert.equal(r.code, 0, r.all)
    await watchRun(); assert.equal((await records()).filter((x) => x.method === 'POST').length, 4)
    // Examine permissions/argv absence on the server without returning credential contents to the model.
    r = await sh(`test "$(stat -c %a "$HOME/.server-use/watch/secret")" = 600 && ! crontab -l | grep -q 'watch-hmac'`)
    assert.equal(r.code, 0, r.err)
    s.assertNoLeak([key])
    r = await su(['watch', 'off', host, '--yes']); assert.equal(r.code, 0, r.all)
    assert.doesNotMatch((await su(['cron', 'ls', host])).out, /^watch\s/m)
    assert.equal((await sh('test ! -e "$HOME/.server-use/watch/secret"')).code, 0)
  })
})
