import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse/sync";
import { logInfo, logDebug, getErrorMessage } from "../core/logging.js";
import type { ConcordanceEntry } from "../domain/nonprofit/types.js";

const CONCORDANCE_URL =
  "https://raw.githubusercontent.com/Nonprofit-Open-Data-Collective/irs-efile-master-concordance-file/master/concordance.csv";

const DEFAULT_CSV_PATH = "data/concordance/concordance.csv";

// Form prefixes we care about (full 990 and schedules)
const ALLOWED_FORM_PREFIXES = ["F990", "IRS990"];

export class ConcordanceIndex {
  private csvPath: string;
  private byVariable = new Map<string, ConcordanceEntry[]>();
  private byVariableVersion = new Map<string, ConcordanceEntry[]>();
  private byFormPart = new Map<string, ConcordanceEntry[]>();
  private initialized = false;

  constructor(csvPath?: string) {
    this.csvPath = csvPath ?? DEFAULT_CSV_PATH;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Download CSV if not present on disk
    if (!fs.existsSync(this.csvPath)) {
      await this.downloadCsv();
    }

    const content = await fsp.readFile(this.csvPath, "utf-8");
    this.parseCsv(content);
    this.initialized = true;
    logInfo(
      `Concordance loaded: ${this.byVariable.size} variables, ${this.totalEntries()} xpath entries`,
    );
  }

  getXpaths(
    variableName: string,
    schemaVersion?: string,
  ): ConcordanceEntry[] {
    this.ensureInitialized();

    // Try version-specific lookup first
    if (schemaVersion) {
      const versionKey = `${variableName}:${schemaVersion}`;
      const versionEntries = this.byVariableVersion.get(versionKey);
      if (versionEntries && versionEntries.length > 0) {
        return versionEntries;
      }
      // Version-specific lookup failed — log the fallback
      logDebug(
        `Concordance: no version-specific match for ${variableName} @ ${schemaVersion}, falling back`,
      );
    }

    // Fallback: current_version entries, then all entries
    const allEntries = this.byVariable.get(variableName);
    if (!allEntries) return [];

    const currentEntries = allEntries.filter((e) => e.currentVersion);
    return currentEntries.length > 0 ? currentEntries : allEntries;
  }

  getVariablesByForm(
    formType: "PC" | "EZ" | "PF",
    part: string,
  ): ConcordanceEntry[] {
    this.ensureInitialized();
    const key = `${formType}:${part}`;
    return this.byFormPart.get(key) ?? [];
  }

  getDataType(
    variableName: string,
  ): "text" | "numeric" | "date" | "checkbox" {
    const entries = this.byVariable.get(variableName);
    if (!entries || entries.length === 0) return "text";
    return entries[0].dataType;
  }

  isReady(): boolean {
    return this.initialized;
  }

  private async downloadCsv(): Promise<void> {
    logInfo("Downloading NOPDC concordance CSV...");
    await fsp.mkdir(path.dirname(this.csvPath), { recursive: true });

    try {
      const response = await axios.get(CONCORDANCE_URL, {
        responseType: "text",
        timeout: 60_000,
        maxContentLength: 50 * 1024 * 1024, // 50MB safety cap
      });

      await fsp.writeFile(this.csvPath, response.data);
      logInfo(`Concordance CSV downloaded to ${this.csvPath}`);
    } catch (error) {
      throw new Error(
        `Failed to download concordance CSV: ${getErrorMessage(error)}`,
      );
    }
  }

  private parseCsv(content: string): void {
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];

    let loaded = 0;
    for (const row of records) {
      const scope = row["scope"] ?? row["form"] ?? "";
      // Filter to F990 and IRS990* forms only
      if (!ALLOWED_FORM_PREFIXES.some((p) => scope.startsWith(p))) continue;

      const variableName = row["variable_name"]?.trim();
      const xpath = row["xpath"]?.trim();
      if (!variableName || !xpath) continue;

      const versionsRaw = row["versions"] ?? "";
      const versions = versionsRaw
        .split(";")
        .map((v) => v.trim())
        .filter(Boolean);

      const entry: ConcordanceEntry = {
        xpath,
        variableName,
        relationship: row["rdb_relationship"]?.trim() === "MANY" ? "MANY" : "ONE",
        formType: this.parseFormType(scope),
        formPart: row["form_part"]?.trim() ?? "",
        dataType: this.parseDataType(row["data_type_simple"]?.trim()),
        versions,
        currentVersion: row["current_version"]?.trim().toLowerCase() === "true",
      };

      // Index by variable name
      const existing = this.byVariable.get(variableName) ?? [];
      existing.push(entry);
      this.byVariable.set(variableName, existing);

      // Index by variable_name:version for fast version-specific lookup
      for (const version of versions) {
        const vKey = `${variableName}:${version}`;
        const vExisting = this.byVariableVersion.get(vKey) ?? [];
        vExisting.push(entry);
        this.byVariableVersion.set(vKey, vExisting);
      }

      // Index by formType:formPart
      const fpKey = `${entry.formType}:${entry.formPart}`;
      const fpExisting = this.byFormPart.get(fpKey) ?? [];
      fpExisting.push(entry);
      this.byFormPart.set(fpKey, fpExisting);

      loaded++;
    }

    logDebug(
      `Concordance parsed: ${loaded} entries from ${records.length} total rows`,
    );

    if (loaded === 0) {
      throw new Error(
        "Concordance loaded 0 entries — CSV may be malformed, empty, or corrupted during download",
      );
    }
  }

  private parseFormType(scope: string): string {
    if (scope.includes("990EZ") || scope.includes("EZ")) return "EZ";
    if (scope.includes("990PF") || scope.includes("PF")) return "PF";
    return "PC";
  }

  private parseDataType(
    raw: string | undefined,
  ): "text" | "numeric" | "date" | "checkbox" {
    if (!raw) return "text";
    const lower = raw.toLowerCase();
    if (lower === "numeric" || lower === "number") return "numeric";
    if (lower === "date") return "date";
    if (lower === "checkbox" || lower === "boolean") return "checkbox";
    return "text";
  }

  private totalEntries(): number {
    let count = 0;
    for (const entries of this.byVariable.values()) {
      count += entries.length;
    }
    return count;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "ConcordanceIndex not initialized. Call initialize() first.",
      );
    }
  }
}
