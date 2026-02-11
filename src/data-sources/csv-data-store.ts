import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse/sync";
import * as unzipper from "unzipper";
import { RedFlagConfig } from "../core/config.js";
import {
  logInfo,
  logError,
  logDebug,
  logWarn,
  getErrorMessage,
} from "../core/logging.js";
import {
  IrsRevocationRow,
  OfacSdnRow,
  OfacAltRow,
  DataManifest,
} from "../domain/nonprofit/types.js";
import { normalizeName } from "./name-normalizer.js";

const IRS_REVOCATION_URL =
  "https://apps.irs.gov/pub/epostcard/data-download-revocation.zip";
const OFAC_SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";
const OFAC_ALT_URL = "https://www.treasury.gov/ofac/downloads/alt.csv";

const MANIFEST_FILE = "data-manifest.json";

// Safety limits to prevent zip bomb / data poisoning
const MAX_ZIP_SIZE_BYTES = 200 * 1024 * 1024; // 200MB uncompressed limit (IRS list is ~142MB as of 2026)
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024; // 60MB download limit
const MIN_IRS_ROWS = 400_000; // IRS list has ~600K rows; below this suggests corruption
const MIN_OFAC_ENTRIES = 4_000; // OFAC SDN has ~12K entries; below this suggests corruption
const REFRESH_COOLDOWN_MS = 60_000; // Minimum 60s between refresh calls

export class CsvDataStore {
  private irsMap = new Map<string, IrsRevocationRow>();
  private ofacNameMap = new Map<string, OfacSdnRow[]>();
  private config: RedFlagConfig;
  private lastRefreshAt = 0;
  private operationLock: Promise<void> = Promise.resolve();

  constructor(config: RedFlagConfig) {
    this.config = config;
  }

  /**
   * Serialize async operations to prevent race conditions between
   * initialize() and refresh() writing to the same maps concurrently.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto whatever is currently running
    const prev = this.operationLock;
    let resolve!: () => void;
    this.operationLock = new Promise<void>((r) => {
      resolve = r;
    });
    try {
      await prev;
      return await fn();
    } finally {
      resolve();
    }
  }

  get irsRowCount(): number {
    return this.irsMap.size;
  }

  get ofacEntryCount(): number {
    return this.ofacNameMap.size;
  }

  async initialize(): Promise<void> {
    return this.withLock(async () => {
      await fsp.mkdir(this.config.dataDir, { recursive: true });
      const manifest = await this.loadManifest();

      const irsStale = this.isStale(manifest.irs_revocation?.downloaded_at);
      const ofacStale = this.isStale(manifest.ofac_sdn?.downloaded_at);

      if (irsStale) {
        await this.downloadAndParseIrs(manifest);
      } else {
        await this.parseIrsFromDisk();
      }

      if (ofacStale) {
        await this.downloadAndParseOfac(manifest);
      } else {
        await this.parseOfacFromDisk();
      }

      logInfo(
        `Data loaded: ${this.irsMap.size} IRS revocations, ${this.ofacNameMap.size} OFAC entries`,
      );
    });
  }

  async refresh(
    source?: "irs" | "ofac" | "all",
  ): Promise<{ irs_refreshed: boolean; ofac_refreshed: boolean }> {
    return this.withLock(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRefreshAt;
      if (elapsed < REFRESH_COOLDOWN_MS) {
        const waitSec = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000);
        throw new Error(`Refresh cooldown: try again in ${waitSec}s`);
      }

      const manifest = await this.loadManifest();
      const target = source ?? "all";
      const refreshIrs = target === "irs" || target === "all";
      const refreshOfac = target === "ofac" || target === "all";

      if (refreshIrs) await this.downloadAndParseIrs(manifest);
      if (refreshOfac) await this.downloadAndParseOfac(manifest);

      this.lastRefreshAt = Date.now();
      return { irs_refreshed: refreshIrs, ofac_refreshed: refreshOfac };
    });
  }

  lookupEin(ein: string): IrsRevocationRow | undefined {
    const normalized = ein.replace(/[-\s]/g, "");
    return this.irsMap.get(normalized);
  }

  lookupName(name: string): OfacSdnRow[] {
    const normalized = normalizeName(name);
    return this.ofacNameMap.get(normalized) || [];
  }

  private async downloadAndParseIrs(manifest: DataManifest): Promise<void> {
    logInfo("Downloading IRS revocation list...");
    const zipPath = path.join(this.config.dataDir, "irs-revocation.zip");
    const csvPath = path.join(this.config.dataDir, "irs-revocation.csv");

    try {
      const response = await axios.get(IRS_REVOCATION_URL, {
        responseType: "arraybuffer",
        timeout: 120000, // 2 min — file is ~15MB
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
      });

      await fsp.writeFile(zipPath, Buffer.from(response.data));

      // Extract ZIP
      const directory = await unzipper.Open.file(zipPath);
      if (directory.files.length === 0) {
        throw new Error("IRS ZIP file is empty");
      }

      const file = directory.files[0];

      // Guard against zip bombs: check uncompressed size before extracting
      if (file.uncompressedSize && file.uncompressedSize > MAX_ZIP_SIZE_BYTES) {
        throw new Error(
          `IRS ZIP entry too large: ${file.uncompressedSize} bytes (limit: ${MAX_ZIP_SIZE_BYTES})`,
        );
      }

      const content = await file.buffer();

      // Guard against zip bombs: verify actual extracted size (header can be spoofed)
      if (content.length > MAX_ZIP_SIZE_BYTES) {
        throw new Error(
          `IRS ZIP extracted content too large: ${content.length} bytes (limit: ${MAX_ZIP_SIZE_BYTES})`,
        );
      }

      await fsp.writeFile(csvPath, content);

      // Parse into local var -- don't touch live data until validated
      const newMap = this.parseIrsCsv(content.toString("utf-8"));

      if (newMap.size < MIN_IRS_ROWS) {
        throw new Error(
          `IRS data too small: ${newMap.size} rows (expected >= ${MIN_IRS_ROWS})`,
        );
      }

      // Validation passed -- swap atomically
      this.irsMap = newMap;

      manifest.irs_revocation = {
        downloaded_at: new Date().toISOString(),
        row_count: this.irsMap.size,
      };
      await this.saveManifest(manifest);

      logInfo(`IRS revocation list loaded: ${this.irsMap.size} entries`);
    } catch (error) {
      const msg = getErrorMessage(error);
      logError("Failed to download IRS revocation list:", msg);
      // Fall back to disk if available
      if (fs.existsSync(csvPath)) {
        logWarn("Falling back to cached IRS data");
        await this.parseIrsFromDisk();
      } else {
        throw new Error(`Cannot load IRS revocation data: ${msg}`);
      }
    }
  }

  private async parseIrsFromDisk(): Promise<void> {
    const csvPath = path.join(this.config.dataDir, "irs-revocation.csv");
    if (!fs.existsSync(csvPath)) {
      // No cached data — need to download
      const manifest = await this.loadManifest();
      await this.downloadAndParseIrs(manifest);
      return;
    }

    const content = await fsp.readFile(csvPath, "utf-8");
    const loaded = this.parseIrsCsv(content);
    if (loaded.size < MIN_IRS_ROWS) {
      logWarn(
        `Cached IRS data suspiciously small: ${loaded.size} rows (expected >= ${MIN_IRS_ROWS})`,
      );
    }
    this.irsMap = loaded;
    logDebug(`IRS data loaded from disk: ${this.irsMap.size} entries`);
  }

  // IRS file is pipe-delimited (not CSV), so we use manual splitting
  // instead of csv-parse. This also avoids overhead for ~600K rows.
  private parseIrsCsv(content: string): Map<string, IrsRevocationRow> {
    const map = new Map<string, IrsRevocationRow>();
    const lines = content.split("\n");

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const fields = line.split("|");
      if (fields.length < 12) continue;

      const ein = fields[0].trim().replace(/[-\s]/g, "");
      if (!/^\d{9}$/.test(ein)) continue;

      const row: IrsRevocationRow = {
        ein,
        legalName: fields[1]?.trim() || "",
        dba: fields[2]?.trim() || "",
        address: fields[3]?.trim() || "",
        city: fields[4]?.trim() || "",
        state: fields[5]?.trim() || "",
        zip: fields[6]?.trim() || "",
        country: fields[7]?.trim() || "",
        exemptionType: fields[8]?.trim() || "",
        revocationDate: fields[9]?.trim() || "",
        postingDate: fields[10]?.trim() || "",
        reinstatementDate: fields[11]?.trim() || "",
      };

      map.set(ein, row);
    }

    return map;
  }

  private async downloadAndParseOfac(manifest: DataManifest): Promise<void> {
    logInfo("Downloading OFAC SDN lists...");
    const sdnPath = path.join(this.config.dataDir, "sdn.csv");
    const altPath = path.join(this.config.dataDir, "alt.csv");

    try {
      const [sdnResponse, altResponse] = await Promise.all([
        axios.get(OFAC_SDN_URL, {
          responseType: "text",
          timeout: 60000,
          maxContentLength: MAX_DOWNLOAD_BYTES,
          maxBodyLength: MAX_DOWNLOAD_BYTES,
        }),
        axios.get(OFAC_ALT_URL, {
          responseType: "text",
          timeout: 60000,
          maxContentLength: MAX_DOWNLOAD_BYTES,
          maxBodyLength: MAX_DOWNLOAD_BYTES,
        }),
      ]);

      await Promise.all([
        fsp.writeFile(sdnPath, sdnResponse.data),
        fsp.writeFile(altPath, altResponse.data),
      ]);

      const sdnRows = this.parseSdnCsv(sdnResponse.data);
      const altRows = this.parseAltCsv(altResponse.data);

      // Parse into local var -- don't touch live data until validated
      const newMap = this.buildOfacNameMap(sdnRows, altRows);

      if (newMap.size < MIN_OFAC_ENTRIES) {
        throw new Error(
          `OFAC data too small: ${newMap.size} entries (expected >= ${MIN_OFAC_ENTRIES})`,
        );
      }

      // Validation passed -- swap atomically
      this.ofacNameMap = newMap;

      manifest.ofac_sdn = {
        downloaded_at: new Date().toISOString(),
        sdn_count: sdnRows.length,
        alt_count: altRows.length,
      };
      await this.saveManifest(manifest);

      logInfo(
        `OFAC loaded: ${sdnRows.length} SDN entries, ${altRows.length} aliases`,
      );
    } catch (error) {
      const msg = getErrorMessage(error);
      logError("Failed to download OFAC lists:", msg);
      if (fs.existsSync(sdnPath) && fs.existsSync(altPath)) {
        logWarn("Falling back to cached OFAC data");
        await this.parseOfacFromDisk();
      } else {
        throw new Error(`Cannot load OFAC data: ${msg}`);
      }
    }
  }

  private async parseOfacFromDisk(): Promise<void> {
    const sdnPath = path.join(this.config.dataDir, "sdn.csv");
    const altPath = path.join(this.config.dataDir, "alt.csv");

    if (!fs.existsSync(sdnPath) || !fs.existsSync(altPath)) {
      const manifest = await this.loadManifest();
      await this.downloadAndParseOfac(manifest);
      return;
    }

    const [sdnContent, altContent] = await Promise.all([
      fsp.readFile(sdnPath, "utf-8"),
      fsp.readFile(altPath, "utf-8"),
    ]);

    const sdnRows = this.parseSdnCsv(sdnContent);
    const altRows = this.parseAltCsv(altContent);
    const loaded = this.buildOfacNameMap(sdnRows, altRows);
    if (loaded.size < MIN_OFAC_ENTRIES) {
      logWarn(
        `Cached OFAC data suspiciously small: ${loaded.size} entries (expected >= ${MIN_OFAC_ENTRIES})`,
      );
    }
    this.ofacNameMap = loaded;
    logDebug(`OFAC data loaded from disk: ${this.ofacNameMap.size} entries`);
  }

  private parseSdnCsv(content: string): OfacSdnRow[] {
    const rows: OfacSdnRow[] = [];

    // OFAC CSVs have no header row — fields are positional
    const records = parse(content, {
      relax_column_count: true,
      skip_empty_lines: true,
      quote: '"',
    }) as string[][];

    for (const record of records) {
      if (record.length < 6) continue;

      rows.push({
        entNum: record[0]?.trim() || "",
        name: record[1]?.trim() || "",
        sdnType: record[2]?.trim() || "",
        program: record[3]?.trim() || "",
        title: record[4]?.trim() || "",
        remarks: record[5]?.trim() || "",
      });
    }

    return rows;
  }

  private parseAltCsv(content: string): OfacAltRow[] {
    const rows: OfacAltRow[] = [];

    const records = parse(content, {
      relax_column_count: true,
      skip_empty_lines: true,
      quote: '"',
    }) as string[][];

    for (const record of records) {
      if (record.length < 5) continue;

      rows.push({
        entNum: record[0]?.trim() || "",
        altNum: record[1]?.trim() || "",
        altType: record[2]?.trim() || "",
        altName: record[3]?.trim() || "",
        altRemarks: record[4]?.trim() || "",
      });
    }

    return rows;
  }

  private buildOfacNameMap(
    sdnRows: OfacSdnRow[],
    altRows: OfacAltRow[],
  ): Map<string, OfacSdnRow[]> {
    const map = new Map<string, OfacSdnRow[]>();

    // Index SDN entries by entNum for alias lookups
    const sdnByEntNum = new Map<string, OfacSdnRow>();
    for (const row of sdnRows) {
      sdnByEntNum.set(row.entNum, row);

      // Index by normalized primary name
      const normalized = normalizeName(row.name);
      if (normalized) {
        const existing = map.get(normalized) || [];
        existing.push(row);
        map.set(normalized, existing);
      }
    }

    // Index aliases
    for (const alt of altRows) {
      const sdnRow = sdnByEntNum.get(alt.entNum);
      if (!sdnRow) continue;

      const normalized = normalizeName(alt.altName);
      if (normalized) {
        const existing = map.get(normalized) || [];
        if (!existing.some((r) => r.entNum === sdnRow.entNum)) {
          existing.push(sdnRow);
        }
        map.set(normalized, existing);
      }
    }

    return map;
  }

  private async loadManifest(): Promise<DataManifest> {
    const manifestPath = path.join(this.config.dataDir, MANIFEST_FILE);
    try {
      const content = await fsp.readFile(manifestPath, "utf-8");
      return JSON.parse(content) as DataManifest;
    } catch {
      return {};
    }
  }

  private async saveManifest(manifest: DataManifest): Promise<void> {
    const manifestPath = path.join(this.config.dataDir, MANIFEST_FILE);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  private isStale(downloadedAt: string | undefined): boolean {
    if (!downloadedAt) return true;
    const downloaded = new Date(downloadedAt);
    const now = new Date();
    const diffDays =
      (now.getTime() - downloaded.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays > this.config.dataMaxAgeDays;
  }
}
