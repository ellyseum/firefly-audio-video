#!/usr/bin/env node
import { VERSION } from './index.js';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-V')) {
  console.log(VERSION);
  process.exit(0);
}

console.log(`dgr ${VERSION}`);
console.log('Adobe Firefly Services audio/video (DGR) CLI.');
console.log('Commands are not implemented yet — this is a scaffold stub.');
