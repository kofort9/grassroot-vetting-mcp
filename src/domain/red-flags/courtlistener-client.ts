import axios, { AxiosInstance, AxiosError } from "axios";
import { RedFlagConfig } from "../../core/config.js";
import { logDebug, logError, logWarn } from "../../core/logging.js";
import { CourtListenerCase, CourtRecordsResult } from "../nonprofit/types.js";

class RateLimiter {
  private lastRequestTime = 0;
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;

    if (elapsed < this.delayMs) {
      const waitTime = this.delayMs - elapsed;
      logDebug(`Rate limiting: waiting ${waitTime}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    // Update timestamp AFTER wait completes (not before)
    this.lastRequestTime = Date.now();
  }
}

interface CourtListenerSearchResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: CourtListenerDocket[];
}

interface CourtListenerDocket {
  id: number;
  case_name: string;
  court: string;
  date_argued: string | null;
  date_filed: string | null;
  docket_number: string;
  absolute_url: string;
}

export class CourtListenerClient {
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor(config: RedFlagConfig) {
    this.rateLimiter = new RateLimiter(config.courtlistenerRateLimitMs);

    this.client = axios.create({
      baseURL: config.courtlistenerBaseUrl,
      headers: {
        Authorization: `Token ${config.courtlistenerApiToken}`,
        "Content-Type": "application/json",
        "User-Agent": "nonprofit-vetting-mcp/1.0",
      },
      timeout: 30000,
      // Prevent axios from following redirects, which would forward
      // the Authorization header to potentially untrusted hosts.
      maxRedirects: 0,
    });

    this.client.interceptors.request.use(
      (reqConfig) => {
        logDebug(
          `CourtListener Request: ${reqConfig.method?.toUpperCase()} ${reqConfig.url}`,
        );
        return reqConfig;
      },
      (error) => Promise.reject(error),
    );

    this.client.interceptors.response.use(
      (response) => {
        logDebug(
          `CourtListener Response: ${response.status} ${response.config.url}`,
        );
        return response;
      },
      (error: AxiosError) => {
        if (error.response) {
          logError(
            `CourtListener Error: ${error.response.status} ${error.config?.url}`,
            error.response.data,
          );
        } else if (error.request) {
          logError("CourtListener Error: No response received", error.message);
        } else {
          logError("CourtListener Error:", error.message);
        }
        return Promise.reject(error);
      },
    );
  }

  async searchByOrgName(
    name: string,
    lookbackYears: number = 1,
  ): Promise<CourtRecordsResult> {
    await this.rateLimiter.waitIfNeeded();

    // Calculate lookback date
    const lookbackDate = new Date();
    lookbackDate.setFullYear(lookbackDate.getFullYear() - lookbackYears);
    const dateAfter = lookbackDate.toISOString().split("T")[0]; // YYYY-MM-DD

    try {
      // Strip Solr query syntax characters to prevent query injection
      const sanitizedName = name.replace(/[\\"+\-!(){}[\]^~*?:/]/g, "");

      const response = await this.client.get<CourtListenerSearchResponse>(
        "/search/",
        {
          params: {
            q: `"${sanitizedName}"`,
            type: "r", // dockets (case records)
            filed_after: dateAfter,
            order_by: "dateFiled desc",
            page_size: 20,
          },
        },
      );

      const results = response.data.results || [];
      const totalCount = response.data.count || 0;

      if (results.length === 0) {
        return {
          found: false,
          detail: `No federal court cases found for "${name}" in the past ${lookbackYears} year(s)`,
          caseCount: 0,
          cases: [],
        };
      }

      const cases: CourtListenerCase[] = results.map((d) => ({
        id: d.id,
        caseName: d.case_name || "",
        court: d.court || "",
        dateArgued: d.date_argued,
        dateFiled: d.date_filed,
        docketNumber: d.docket_number || "",
        absoluteUrl:
          d.absolute_url && d.absolute_url.startsWith("/")
            ? `https://www.courtlistener.com${d.absolute_url}`
            : "",
      }));

      return {
        found: true,
        detail: `Found ${totalCount} federal court case(s) for "${name}" in the past ${lookbackYears} year(s)`,
        caseCount: totalCount,
        cases,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error("CourtListener API token is invalid or expired");
        }
        if (error.response?.status === 429) {
          logWarn("CourtListener rate limit hit");
          return {
            found: false,
            detail: "CourtListener rate limit exceeded — try again later",
            caseCount: 0,
            cases: [],
          };
        }
      }
      throw error;
    }
  }
}
