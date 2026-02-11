// Tool Response Wrappers

import type { NonprofitSearchResult } from "./profile.js";

export interface SearchNonprofitResponse {
  results: NonprofitSearchResult[];
  total: number;
  attribution: string;
}

export interface ToolResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  attribution: string;
}
