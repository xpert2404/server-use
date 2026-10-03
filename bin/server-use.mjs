#!/usr/bin/env node
import { main, exitCodeFor } from '../src/cli.mjs'

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code || 0 },
  (e) => {
    process.stderr.write(`server-use: ${e.code && !['INTERNAL', 'USAGE'].includes(e.code) ? `${e.code}: ` : ''}${e.message}\n`)
    process.exitCode = exitCodeFor(e)
  },
)
