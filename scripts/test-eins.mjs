import { loadConfig } from '../dist/core/config.js';
import { ProPublicaClient } from '../dist/domain/nonprofit/propublica-client.js';
import { CsvDataStore } from '../dist/data-sources/csv-data-store.js';
import { VettingStore } from '../dist/data-sources/vetting-store.js';
import { IrsRevocationClient } from '../dist/domain/red-flags/irs-revocation-client.js';
import { OfacSdnClient } from '../dist/domain/red-flags/ofac-sdn-client.js';
import * as tools from '../dist/domain/nonprofit/tools.js';

const config = loadConfig();
const client = new ProPublicaClient(config.propublica);
const dataStore = new CsvDataStore(config.redFlag);
const vettingStore = new VettingStore(config.redFlag.dataDir);
const irsClient = new IrsRevocationClient(dataStore);
const ofacClient = new OfacSdnClient(dataStore);

await dataStore.initialize();
vettingStore.initialize();

const eins = [
  { label: 'Homeboy Industries', ein: '95-3135649' },
  { label: 'Habitat for Humanity Intl', ein: '91-1914868' },
  { label: 'Khan Academy', ein: '26-1544963' },
  { label: 'Feeding America', ein: '36-3673599' },
  { label: 'Wounded Warrior Project', ein: '20-2370934' },
  { label: 'NRA Foundation', ein: '52-1710886' },
  { label: 'NAACP (c4)', ein: '23-7028846' },
  { label: 'No Labels (c4)', ein: '27-1432208' },
  { label: 'Trump Foundation', ein: '13-3404773' },
  { label: '360 Grassroots', ein: '27-2657135' },
];

console.log('=== Tier 1 Vetting Results ===\n');

for (const { label, ein } of eins) {
  try {
    const result = await tools.checkTier1(client, { ein }, config.thresholds, irsClient, ofacClient);
    if (result.success && result.data) {
      const d = result.data;
      const flags = d.red_flags.map(f => `${f.type}(${f.severity})`).join(', ') || 'none';
      const gateInfo = d.gate_blocked ? `BLOCKED by ${d.gates.blocking_gate}` : 'all passed';
      const scoreStr = d.score !== null ? String(d.score) : 'n/a';

      console.log(`${label}`);
      console.log(`  EIN: ${ein} | Rec: ${d.recommendation} | Score: ${scoreStr}`);
      console.log(`  Gates: ${gateInfo}`);
      console.log(`  Red flags: ${flags}`);

      // Print checks if not gate-blocked
      if (d.checks) {
        for (const c of d.checks) {
          console.log(`  [${c.result}] ${c.name}: ${c.detail}`);
        }
      }
      console.log('');

      // Save to SQLite
      vettingStore.saveResult(d, 'test-script');
    } else {
      console.log(`${label}`);
      console.log(`  EIN: ${ein} | ERROR: ${result.error || 'unknown'}\n`);
    }
  } catch (err) {
    console.log(`${label}`);
    console.log(`  EIN: ${ein} | EXCEPTION: ${err.message}\n`);
  }
}

// Summary
const stats = vettingStore.getStats();
console.log('=== Summary ===');
console.log(`Total: ${stats.total} | PASS: ${stats.pass} | REVIEW: ${stats.review} | REJECT: ${stats.reject}`);

vettingStore.close();
