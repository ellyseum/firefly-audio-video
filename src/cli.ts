#!/usr/bin/env node
import 'dotenv/config';
import { createProgram } from './cli/program.js';

// The program sets process.exitCode rather than calling process.exit(), so
// the process ends once its sockets and any cancel request have drained, and
// its parseAsync() never rejects, so nothing here awaits it.
void createProgram().parseAsync(process.argv);
