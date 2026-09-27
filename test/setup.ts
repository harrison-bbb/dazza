import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Task worktrees go under the data dir; keep tests' out of the user's.
process.env.DAZZA_DATA_DIR = mkdtempSync(join(tmpdir(), 'dazza-data-'));
