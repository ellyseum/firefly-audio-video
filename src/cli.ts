#!/usr/bin/env node
import 'dotenv/config';
import { createProgram } from './cli/program.js';

// createProgram()'s parseAsync() never rejects — every exit path, including
// commander's own, calls process.exit() itself — so nothing here awaits it.
void createProgram({
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
}).parseAsync(process.argv);
