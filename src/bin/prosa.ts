#!/usr/bin/env node
import { runCli } from '../cli/main.js';

runCli(process.argv).catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
