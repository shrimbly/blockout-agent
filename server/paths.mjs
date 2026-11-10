// Where Camera Canvas keeps its data (scenes, saves, exports, the server's pid and log).
// A git checkout keeps everything inside the repo, as before. An installed copy (the Claude Code plugin,
// whose folder is replaced on every update) keeps it in ~/Camera Canvas instead. CANVAS_DATA overrides both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function dataDir() {
  if (process.env.CANVAS_DATA) return path.resolve(process.env.CANVAS_DATA);
  if (fs.existsSync(path.join(ROOT, '.git'))) return ROOT;
  return path.join(os.homedir(), 'Camera Canvas');
}
