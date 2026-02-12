import { loadConfig, type AppConfig } from "../core/config.js";
import { ProPublicaClient } from "../domain/nonprofit/propublica-client.js";
import { CsvDataStore } from "../data-sources/csv-data-store.js";
import { VettingStore } from "../data-sources/vetting-store.js";
import { IrsRevocationClient } from "../domain/red-flags/irs-revocation-client.js";
import { OfacSdnClient } from "../domain/red-flags/ofac-sdn-client.js";
import { CourtListenerClient } from "../domain/red-flags/courtlistener-client.js";
import { DiscoveryIndex } from "../data-sources/discovery-index.js";
import { DiscoveryPipeline } from "../domain/discovery/pipeline.js";
import { VettingPipeline } from "../domain/nonprofit/vetting-pipeline.js";
import { SearchHistoryStore } from "../data-sources/search-history-store.js";
import { ensureSqlJs } from "../data-sources/sqlite-adapter.js";
import { logInfo, logError } from "../core/logging.js";

export interface ServerContext {
  config: AppConfig;
  propublicaClient: ProPublicaClient;
  dataStore: CsvDataStore;
  irsClient: IrsRevocationClient;
  ofacClient: OfacSdnClient;
  courtClient: CourtListenerClient | undefined;
  vettingStore: VettingStore | undefined;
  discoveryIndex: DiscoveryIndex;
  vettingPipeline: VettingPipeline;
  searchHistoryStore: SearchHistoryStore | undefined;
  discoveryPipeline: DiscoveryPipeline;
  discoveryReady: boolean;
}

/**
 * Create and initialize the full server context.
 * All instantiation + async init happens here (not at module import time).
 */
export async function createServerContext(): Promise<ServerContext> {
  // sql.js WASM must load before any SQLite operations
  await ensureSqlJs();

  const config = loadConfig();
  const propublicaClient = new ProPublicaClient(config.propublica);
  const { thresholds: _, portfolioFit } = config;

  const dataStore = new CsvDataStore(config.redFlag);
  const irsClient = new IrsRevocationClient(dataStore);
  const ofacClient = new OfacSdnClient(dataStore);

  const courtClient = config.redFlag.courtlistenerApiToken
    ? new CourtListenerClient(config.redFlag)
    : undefined;

  let vettingStore: VettingStore | undefined;
  let searchHistoryStore: SearchHistoryStore | undefined;

  const discoveryIndex = new DiscoveryIndex(config.discovery);
  const discoveryPipeline = new DiscoveryPipeline(discoveryIndex, portfolioFit);
  let discoveryReady = false;

  // Initialize data stores (IRS/OFAC)
  try {
    await dataStore.initialize();
    logInfo("Data stores initialized");
  } catch (err) {
    logError(
      "Data store initialization failed (gates requiring IRS/OFAC will fail):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Initialize vetting result persistence (SQLite)
  try {
    const store = new VettingStore(config.redFlag.dataDir);
    store.initialize();
    vettingStore = store;
  } catch (err) {
    logError(
      "VettingStore initialization failed (persistence disabled):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Initialize discovery index (schema only — does not download data)
  try {
    discoveryIndex.initialize();
    discoveryReady = discoveryIndex.isReady();
    if (discoveryReady) {
      const stats = discoveryIndex.getStats();
      logInfo(
        `Discovery index ready: ${stats.totalOrgs} orgs (updated ${stats.lastUpdated})`,
      );
    } else {
      logInfo(
        "Discovery index not populated. Run refresh_discovery_index to build it.",
      );
    }
  } catch (err) {
    logError(
      "DiscoveryIndex initialization failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Initialize search history logging (shares SQLite db with VettingStore)
  if (vettingStore) {
    try {
      const historyStore = new SearchHistoryStore();
      historyStore.initialize(vettingStore.getDatabase());
      searchHistoryStore = historyStore;
    } catch (err) {
      logError(
        "SearchHistoryStore initialization failed (search logging disabled):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const vettingPipeline = new VettingPipeline({
    propublicaClient,
    thresholds: config.thresholds,
    portfolioFit: config.portfolioFit,
    irsClient,
    ofacClient,
    courtClient,
    vettingStore,
    cacheMaxAgeDays: config.vettingCacheMaxAgeDays,
  });

  return {
    config,
    propublicaClient,
    dataStore,
    irsClient,
    ofacClient,
    courtClient,
    vettingStore,
    vettingPipeline,
    searchHistoryStore,
    discoveryIndex,
    discoveryPipeline,
    discoveryReady,
  };
}
