import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { GivingTuesdayClient } from "../src/data-sources/givingtuesday-client.js";
import { makeGtFilingEntry, makeGivingTuesdayConfig } from "./fixtures.js";

vi.mock("axios");
const mockedAxios = vi.mocked(axios);

describe("GivingTuesdayClient", () => {
  let client: GivingTuesdayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GivingTuesdayClient(makeGivingTuesdayConfig());
  });

  describe("getFilingIndex", () => {
    it("fetches filing index for an EIN", async () => {
      const filing = makeGtFilingEntry();
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          statusCode: 200,
          body: {
            query: "131624100",
            no_results: 1,
            results: [filing],
          },
        },
      });

      const results = await client.getFilingIndex("13-1624100");
      expect(results).toHaveLength(1);
      expect(results[0].EIN).toBe("131624100");
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining("ein=131624100"),
        expect.any(Object),
      );
    });

    it("returns empty array when no filings found", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          statusCode: 200,
          body: { query: "000000000", no_results: 0, results: [] },
        },
      });

      const results = await client.getFilingIndex("000000000");
      expect(results).toEqual([]);
    });
  });

  describe("downloadXml — SSRF prevention", () => {
    it("blocks download from non-allowlisted URL", async () => {
      const filing = makeGtFilingEntry({
        URL: "http://evil.example.com/malicious.xml",
      });

      await expect(client.downloadXml(filing)).rejects.toThrow(
        "Blocked download from untrusted URL",
      );
    });

    it("allows download from S3 amazonaws.com", async () => {
      const filing = makeGtFilingEntry({
        URL: "https://irs-990-efiler-data.s3.amazonaws.com/xml/test.xml",
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: "<Return></Return>",
      });

      const xml = await client.downloadXml(filing);
      expect(xml).toBe("<Return></Return>");
    });

    it("allows download from GivingTuesday domain", async () => {
      const filing = makeGtFilingEntry({
        URL: "https://990-infrastructure.gtdata.org/xml/test.xml",
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: "<Return></Return>",
      });

      const xml = await client.downloadXml(filing);
      expect(xml).toBe("<Return></Return>");
    });

    it("blocks download from non-pinned S3 bucket", async () => {
      const filing = makeGtFilingEntry({
        URL: "https://evil-bucket.s3.amazonaws.com/xml/test.xml",
      });

      await expect(client.downloadXml(filing)).rejects.toThrow(
        "Blocked download from untrusted URL",
      );
    });

    it("blocks HTTP (non-HTTPS) URLs", async () => {
      const filing = makeGtFilingEntry({
        URL: "http://irs-990-efiler-data.s3.amazonaws.com/xml/test.xml",
      });

      await expect(client.downloadXml(filing)).rejects.toThrow(
        "Blocked download from untrusted URL",
      );
    });
  });

  describe("downloadXml — path traversal prevention", () => {
    it("sanitizes ObjectId with path traversal characters", async () => {
      const filing = makeGtFilingEntry({
        ObjectId: "../../etc/passwd",
        URL: "https://irs-990-efiler-data.s3.amazonaws.com/xml/test.xml",
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: "<Return></Return>",
      });

      // Should not throw — ObjectId gets sanitized
      const xml = await client.downloadXml(filing);
      expect(xml).toBe("<Return></Return>");
    });
  });

  describe("downloadXml — file size limit", () => {
    it("rejects filing when FileSizeBytes exceeds limit", async () => {
      const filing = makeGtFilingEntry({
        FileSizeBytes: String(100 * 1024 * 1024), // 100MB
      });

      await expect(client.downloadXml(filing)).rejects.toThrow("too large");
    });
  });

  describe("retry logic", () => {
    it("retries on 429 errors", async () => {
      const error429 = new Error("Request failed with status code 429");
      mockedAxios.get
        .mockRejectedValueOnce(error429) // First call: 429
        .mockResolvedValueOnce({
          // Second call: success
          data: {
            statusCode: 200,
            body: { query: "131624100", no_results: 1, results: [makeGtFilingEntry()] },
          },
        });

      const results = await client.getFilingIndex("131624100");
      expect(results).toHaveLength(1);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it("does not retry on non-retryable errors", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("404 Not Found"));

      await expect(client.getFilingIndex("000000000")).rejects.toThrow("404");
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLatestXml", () => {
    it("picks latest full 990 from index", async () => {
      const old990 = makeGtFilingEntry({ TaxYear: "2020", FormType: "990" });
      const new990 = makeGtFilingEntry({ TaxYear: "2022", FormType: "990" });
      const ez = makeGtFilingEntry({ TaxYear: "2023", FormType: "990EZ" });

      // First call: getFilingIndex
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          statusCode: 200,
          body: { query: "131624100", no_results: 3, results: [old990, new990, ez] },
        },
      });

      // Second call: downloadXml
      mockedAxios.get.mockResolvedValueOnce({
        data: "<Return>latest</Return>",
      });

      const result = await client.getLatestXml("131624100");
      expect(result).not.toBeNull();
      expect(result!.metadata.TaxYear).toBe("2022");
      expect(result!.xml).toBe("<Return>latest</Return>");
    });

    it("returns null when no filings available", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          statusCode: 200,
          body: { query: "000000000", no_results: 0, results: [] },
        },
      });

      const result = await client.getLatestXml("000000000");
      expect(result).toBeNull();
    });
  });
});
