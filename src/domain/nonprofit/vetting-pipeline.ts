import type { ProPublicaClient } from "./propublica-client.js";
import type {
  VettingThresholds,
  PortfolioFitConfig,
  Tier1Result,
  ToolResponse,
} from "./types.js";
import type { VettingStore } from "../../data-sources/vetting-store.js";
import type { IrsRevocationClient } from "../red-flags/irs-revocation-client.js";
import type { OfacSdnClient } from "../red-flags/ofac-sdn-client.js";
import type { CourtListenerClient } from "../red-flags/courtlistener-client.js";
import { checkTier1 } from "./tools.js";
import { logError } from "../../core/logging.js";

export interface VettingPipelineConfig {
  propublicaClient: ProPublicaClient;
  thresholds: VettingThresholds;
  portfolioFit: PortfolioFitConfig;
  irsClient: IrsRevocationClient;
  ofacClient: OfacSdnClient;
  courtClient?: CourtListenerClient;
  vettingStore: VettingStore;
  vettingStoreReady: boolean;
}

export interface RunTier1Options {
  forceRefresh?: boolean;
}

export interface Tier1PipelineResult {
  response: ToolResponse<Tier1Result>;
  cached: boolean;
  cachedNote?: string;
}

/**
 * VettingPipeline owns the cache-check → vet → persist lifecycle for Tier 1.
 * Calls the existing tools.checkTier1() internally — does NOT replace scoring logic.
 */
export class VettingPipeline {
  private config: VettingPipelineConfig;

  constructor(config: VettingPipelineConfig) {
    this.config = config;
  }

  async runTier1(
    ein: string,
    opts: RunTier1Options = {},
  ): Promise<Tier1PipelineResult> {
    const { vettingStore, vettingStoreReady } = this.config;

    // 1. Check cache (unless forceRefresh)
    if (!opts.forceRefresh && vettingStoreReady) {
      const cached = vettingStore.getLatestByEin(ein);
      if (cached) {
        const cachedResult = JSON.parse(cached.result_json) as Tier1Result;
        return {
          response: {
            success: true,
            data: cachedResult,
            attribution: "ProPublica Nonprofit Explorer API",
          },
          cached: true,
          cachedNote: `Previously vetted on ${cached.vetted_at} by ${cached.vetted_by}. Use force_refresh: true to re-vet.`,
        };
      }
    }

    // 2. Run vetting
    const {
      propublicaClient,
      thresholds,
      irsClient,
      ofacClient,
      portfolioFit,
      courtClient,
    } = this.config;

    const response = await checkTier1(
      propublicaClient,
      { ein },
      thresholds,
      irsClient,
      ofacClient,
      portfolioFit,
      courtClient,
    );

    // 3. Persist result (non-blocking)
    if (response.success && response.data && vettingStoreReady) {
      try {
        vettingStore.saveResult(response.data);
      } catch (err) {
        logError(
          "Failed to save vetting result:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return { response, cached: false };
  }
}
