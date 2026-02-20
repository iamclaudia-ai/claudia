#!/usr/bin/env bun
import { recoverStuckFiles } from "../extensions/memory/src/ingest";
import { getStats, getDb, closeDb, getStuckFiles } from "../extensions/memory/src/db";

getDb();

const stuck = getStuckFiles();
console.log(`\n  Stuck files: ${stuck.length}`);
for (const f of stuck) {
  console.log(`    ${f.filePath} (status=${f.status}, last_ts=${f.lastEntryTimestamp})`);
}

const recovered = recoverStuckFiles(60, (level, msg) => console.log(`  [${level}] ${msg}`));
console.log(`\n  Recovered: ${recovered} file(s)`);

const stats = getStats();
console.log(`  Entries after recovery: ${stats.entryCount}`);

const stuckAfter = getStuckFiles();
console.log(`  Stuck files after: ${stuckAfter.length}\n`);

closeDb();
