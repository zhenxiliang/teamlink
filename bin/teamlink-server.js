#!/usr/bin/env node
import { runServerCli } from '../src/server/main.ts';

runServerCli(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
