import type { ProPublicaClient } from "./propublica-client.js";
import type {
  VettingThresholds,
  PortfolioFitConfig,
  ScreeningResult,
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
  vettingStore?: VettingStore;
  cacheMaxAgeDays: number;
}

export interface RunScreeningOptions {
  forceRefresh?: boolean;
}

export interface ScreeningPipelineResult {
  response: ToolResponse<ScreeningResult>;
  cached: boolean;
  cachedNote?: string;
}

// VettingPipeline orchestrates the full vetting lifecycle.
// Currently, vetting = screening (automated financial checks).
// As new layers are added (human review, impact analysis),
// they become additional methods on this class.
export class VettingPipeline {
  private config: VettingPipelineConfig;

  constructor(config: VettingPipelineConfig) {
    this.config = config;
  }

  async runScreening(
    ein: string,
    opts: RunScreeningOptions = {},
  ): Promise<ScreeningPipelineResult> {
    const { vettingStore } = this.config;

    // 1. Check cache (unless forceRefresh)
    if (!opts.forceRefresh && vettingStore) {
      const cached = vettingStore.getLatestByEin(ein);
      if (cached) {
        const parsedTime = new Date(cached.vetted_at + "Z").getTime();
        if (!Number.isNaN(parsedTime)) {
          const ageMs = Date.now() - parsedTime;
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const maxAge = this.config.cacheMaxAgeDays;

          if (ageDays >= 0 && ageDays <= maxAge) {
            const cachedResult = JSON.parse(
              cached.result_json,
            ) as ScreeningResult;
            return {
              response: {
                success: true,
                data: cachedResult,
                attribution: "ProPublica Nonprofit Explorer API",
              },
              cached: true,
              cachedNote: `Previously vetted on ${cached.vetted_at} by ${cached.vetted_by} (${Math.floor(ageDays)}d ago, TTL ${maxAge}d). Use force_refresh: true to re-vet.`,
            };
          }
        }
        // NaN date, future date, or expired cache — fall through to re-vet
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
    if (response.success && response.data && vettingStore) {
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
