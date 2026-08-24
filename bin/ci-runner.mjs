#!/usr/bin/env node
/**
 * ci-runner CLI launcher. The implementation lives in src/cli.js (ESM).
 */
import { main } from '../src/cli.js'

const code = await main(process.argv.slice(2))
process.exitCode = code
