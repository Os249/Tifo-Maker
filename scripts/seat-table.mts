/**
 * Writes server/data/seat-table.json: every shipped ground's seat count and
 * locked seats, from the seat-map generator (performance plan P1.31; see
 * server/src/seatTable.ts for why the server reads a table at all).
 *
 *   npm run seats:table             write the table
 *   npm run seats:table -- --check  exit 1 if the file is not what the generator makes now
 *
 * The Docker build runs the first (npm run build:server), so the image always
 * carries a table made by the code in it; test:deploy runs the comparison.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { formatSeatTable, generateSeatTable, SEAT_TABLE_PATH } from '../server/src/seatTable';

const started = Date.now();
const entries = generateSeatTable();
const text = formatSeatTable(entries);
const took = ((Date.now() - started) / 1000).toFixed(1);
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(SEAT_TABLE_PATH, 'utf8');
  } catch {
    /* missing is different */
  }
  if (current !== text) {
    console.error(`seat table: ${SEAT_TABLE_PATH} is not what the generator makes now; run \`npm run seats:table\` and commit it`);
    process.exit(1);
  }
  console.log(`seat table: up to date (${entries.length} grounds, checked in ${took}s)`);
} else {
  writeFileSync(SEAT_TABLE_PATH, text);
  console.log(`seat table: wrote ${entries.length} grounds to ${SEAT_TABLE_PATH} (${took}s)`);
}
