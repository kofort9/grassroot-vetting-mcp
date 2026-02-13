import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { RateLimiter } from "../core/rate-limiter.js";
import {
  logDebug,
  logWarn,
  getErrorMessage,
} from "../core/logging.js";
import type {
  GivingTuesdayConfig,
  GtApiResponse,
  GtFilingIndexEntry,
} from "../domain/nonprofit/types.js";

// SSRF prevention: only allow downloads from these origins
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/irs-990-efiler-data\.s3\.amazonaws\.com\//,
  /^https:\/\/990-infrastructure\.gtdata\.org\//,
];

function validateDownloadUrl(url: string): void {
  if (!ALLOWED_URL_PATTERNS.some((p) => p.test(url))) {
    throw new Error(`Blocked download from untrusted URL: ${url}`);
  }
}

function sanitizeObjectId(objectId: string): string {
  return objectId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class GivingTuesdayClient {
  private config: GivingTuesdayConfig;
  private rateLimiter: RateLimiter;

  constructor(config: GivingTuesdayConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(config.rateLimitMs);
  }

  async getFilingIndex(ein: string): Promise<GtFilingIndexEntry[]> {
    const normalized = ein.replace(/[-\s]/g, "");
    const url = `${this.config.apiBaseUrl}/irs-data/efilexml?ein=${normalized}`;

    await this.rateLimiter.waitIfNeeded();

    const response = await this.fetchWithRetry<GtApiResponse>(url);
    if (!response?.body?.results) return [];

    return response.body.results;
  }

  async downloadXml(
    filing: GtFilingIndexEntry,
  ): Promise<string> {
    // SSRF check
    validateDownloadUrl(filing.URL);

    // File size check
    const sizeBytes = parseInt(filing.FileSizeBytes, 10);
    if (!isNaN(sizeBytes) && sizeBytes > this.config.maxXmlSizeBytes) {
      throw new Error(
        `Filing ${filing.ObjectId} too large: ${sizeBytes} bytes (limit: ${this.config.maxXmlSizeBytes})`,
      );
    }

    // Cache path with sanitized ObjectId
    const sanitizedId = sanitizeObjectId(filing.ObjectId);
    const einDir = path.join(
      this.config.xmlCacheDir,
      filing.EIN.replace(/[-\s]/g, ""),
    );
    const cachePath = path.join(einDir, `${sanitizedId}_public.xml`);

    // Check cache: if file exists and SHA matches, return from cache
    if (fs.existsSync(cachePath)) {
      const cached = await fsp.readFile(cachePath, "utf-8");
      if (filing.FileSha256 && this.verifySha256(cached, filing.FileSha256)) {
        logDebug(`Cache hit: ${cachePath}`);
        return cached;
      }
      logDebug(`Cache stale (SHA mismatch): ${cachePath}`);
    }

    // Download
    await this.rateLimiter.waitIfNeeded();

    const response = await this.fetchWithRetry<string>(filing.URL, {
      responseType: "text",
      maxContentLength: this.config.maxXmlSizeBytes,
      maxBodyLength: this.config.maxXmlSizeBytes,
    });

    if (!response) {
      throw new Error(`Failed to download XML for ${filing.ObjectId}`);
    }

    // SHA verification (log warning only — SHA source is same untrusted API)
    if (filing.FileSha256 && !this.verifySha256(response, filing.FileSha256)) {
      logWarn(
        `SHA256 mismatch for ${filing.ObjectId} — downloaded content may differ from index`,
      );
    }

    // Cache to disk
    await fsp.mkdir(einDir, { recursive: true });
    await fsp.writeFile(cachePath, response);
    logDebug(`Cached XML: ${cachePath}`);

    return response;
  }

  async getLatestXml(
    ein: string,
  ): Promise<{ xml: string; metadata: GtFilingIndexEntry } | null> {
    const filings = await this.getFilingIndex(ein);
    if (filings.length === 0) return null;

    // Sort all filings by TaxYear descending, then TaxPeriod descending
    const byRecency = (a: GtFilingIndexEntry, b: GtFilingIndexEntry): number => {
      const yearDiff = parseInt(b.TaxYear, 10) - parseInt(a.TaxYear, 10);
      if (yearDiff !== 0) return yearDiff;
      return b.TaxPeriod.localeCompare(a.TaxPeriod);
    };

    // Prefer latest full 990, fall back to any filing type (990EZ, 990PF)
    const full990s = filings.filter((f) => f.FormType === "990").sort(byRecency);
    const target = full990s[0] ?? filings.sort(byRecency)[0];

    if (!target) return null;

    const xml = await this.downloadXml(target);
    return { xml, metadata: target };
  }

  private verifySha256(content: string, expectedHash: string): boolean {
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return hash.toLowerCase() === expectedHash.toLowerCase();
  }

  private async fetchWithRetry<T>(
    url: string,
    axiosOpts?: Record<string, unknown>,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await axios.get(url, {
          timeout: 30_000,
          ...axiosOpts,
        });
        return response.data as T;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const msg = getErrorMessage(error);

        const isRetryable =
          msg.includes("429") ||
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("ECONNRESET") ||
          msg.includes("timeout");

        if (!isRetryable || attempt === this.config.maxRetries) {
          break;
        }

        const backoffMs =
          this.config.retryBackoffMs * Math.pow(2, attempt);
        logWarn(
          `Retry ${attempt + 1}/${this.config.maxRetries} for ${url} in ${backoffMs}ms: ${msg}`,
        );
        await new Promise<void>((r) => setTimeout(r, backoffMs));
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
  }
}
