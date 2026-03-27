#!/usr/bin/env node
import fs from 'node:fs'
const PATH = '/root/clawd-evan/TODO.md'
try {
  const txt = fs.readFileSync(PATH, 'utf8')
  process.stdout.write(txt)
} catch (e) {
  console.error(`ERROR: unable to read ${PATH}: ${e.message}`)
  process.exit(1)
}
