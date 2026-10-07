import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { skip, sandbox, RUN } from './helpers.mjs'
import { scriptSource } from '../../src/remote.mjs'
import { parseDoctor } from '../../src/ops/doctor.mjs'

describe('e2e: doctor', { skip }, () => {
  let s
  const dir = `/root/.server-use/doctor-fixture-${RUN}`
  const path = `${dir}/su-doctor-${RUN}.log`
  const secret = `doctor-private-${RUN}`
  before(async () => { s = sandbox(); await s.add('lab', 'root') })
  after(async () => {
    try {
      if (s) {
        await s.su(['set', 'lab', 'policy=open'])
        const clean = await s.sh('lab', `rm -f '${path}' '${dir}/bin/journalctl'; rmdir '${dir}/bin' '${dir}'; test ! -e '${dir}'`, '--yes')
        assert.equal(clean.code, 0, clean.err)
      }
    } finally { await s?.cleanup() }
  })
  test('real snapshot ranks repeated log errors and redacts credentials in all local output/state', async () => {
    const r = await s.sh('lab', `mkdir -m 700 '${dir}'; mkdir '${dir}/bin'; printf '#!/bin/sh\\nexit 1\\n' > '${dir}/bin/journalctl'; chmod 700 '${dir}/bin/journalctl'
printf '2026-10-07T12:00:00Z error request refused password=${secret}\\n2026-10-07T12:00:01Z error request refused password=${secret}\\n' > '${path}'`)
    assert.equal(r.code, 0, r.err)
    const d = await s.su(['doctor', 'lab', '--json'], { timeout: 180_000 })
    assert.equal(d.code, 0, d.all)
    const data = JSON.parse(d.out).results[0].data
    assert.ok(data.meta.now)
    // The real host may have more than 15 frequent error signatures. Isolate the two-line grouping control,
    // while the normal doctor call above still exercises CLI/daemon integration against its actual logs.
    const probe = await s.sh('lab', `PATH='${dir}/bin':$PATH\nSU_LOGDIR='${dir}'\n${scriptSource('doctor')}`, '--full', '--yes')
    assert.equal(probe.code, 0, probe.err)
    const isolated = parseDoctor(probe.out)
    assert.ok(!(isolated.sections.errors || []).some(line => line.startsWith('err\t') && line.endsWith('\tjournal')), 'journal stub must isolate the file source')
    assert.ok(isolated.findings.some(f => f.title.includes('2 errors from su-doctor-')), probe.out)
    assert.ok(isolated.findings.some(f => f.evidence.includes('password=***')), probe.out)
    s.assertNoLeak([secret])
  })
  test('readonly permits doctor and invalid windows fail before SSH', async () => {
    assert.equal((await s.su(['set', 'lab', 'policy=readonly'])).code, 0)
    const r = await s.su(['doctor', 'lab', '--since', '10m'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /Incident snapshot/)
    assert.equal((await s.su(['doctor', 'lab', '--since', '8d'])).code, 2)
    assert.equal((await s.su(['set', 'lab', 'policy=confirm'])).code, 0)
  })
})
