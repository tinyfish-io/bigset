export interface PopulateWebSearchResult {
  title: string;
  snippet?: string;
  url: string;
  site_name?: string;
  expectation_score?: number;
}

export interface PopulateFetchedPage {
  url: string;
  final_url?: string;
  title?: string;
  text?: string;
}

export interface PopulateRuntimeWebTools {
  search(input: { query: string }): Promise<PopulateWebSearchResult[]>;
  fetch(input: { url: string }): Promise<PopulateFetchedPage>;
}

export interface PopulateRuntimeCapturedSource {
  url: string;
  text: string;
}
