// Quick API test script
import { loadConfig } from './dist/core/config.js';
import { ProPublicaClient } from './dist/domain/nonprofit/propublica-client.js';
import * as tools from './dist/domain/nonprofit/tools.js';

async function main() {
  console.log('=== Nonprofit Vetting MCP API Test ===\n');

  const config = loadConfig();
  const client = new ProPublicaClient(config);

  // Test 1: Search
  console.log('1. Testing search_nonprofit...');
  const searchResult = await tools.searchNonprofit(client, {
    query: 'Los Angeles Regional Food Bank',
  });
  console.log('Search result:', JSON.stringify(searchResult, null, 2));

  if (!searchResult.success || searchResult.data.results.length === 0) {
    console.error('Search failed or no results!');
    process.exit(1);
  }

  const ein = searchResult.data.results[0].ein;
  console.log(`\nFound EIN: ${ein}\n`);

  // Test 2: Get Profile
  console.log('2. Testing get_nonprofit_profile...');
  const profileResult = await tools.getNonprofitProfile(client, { ein });
  console.log('Profile result:', JSON.stringify(profileResult, null, 2));

  // Test 3: Screening
  console.log('\n3. Testing check_tier1...');
  const tier1Result = await tools.checkTier1(client, { ein });
  console.log('Screening result:', JSON.stringify(tier1Result, null, 2));

  // Test 4: Get Red Flags
  console.log('\n4. Testing get_red_flags...');
  const redFlagsResult = await tools.getRedFlags(client, { ein });
  console.log('Red flags result:', JSON.stringify(redFlagsResult, null, 2));

  console.log('\n=== All tests completed! ===');
}

main().catch(console.error);
