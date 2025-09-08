// src/music/search.ts
import youtubeDl, { Flags } from 'youtube-dl-exec';

export interface SearchResult {
  title: string;
  url: string;
  duration: string;
  uploader: string;
  viewCount: number;
  thumbnail?: string;
}

export class MusicSearch {
  private searchCache: Map<string, SearchResult[]> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private cacheTimestamps: Map<string, number> = new Map();

  public async searchSongs(query: string, maxResults: number = 10): Promise<SearchResult[]> {
    // Check cache first
    const cacheKey = `search_${query.toLowerCase()}`;
    const cached = this.getCachedResults(cacheKey);
    if (cached) {
      console.log(`Using cached search results for: ${query}`);
      return cached.slice(0, maxResults);
    }

    try {
      console.log(`Searching for: ${query}`);
      
      const searchFlags: Flags = {
        dumpSingleJson: true,
        flatPlaylist: true,
        defaultSearch: 'ytsearch',
        simulate: true,
        maxDownloads: maxResults
      };

      // Search for videos
      const searchResults = await youtubeDl(`ytsearch${maxResults}:${query}`, searchFlags) as any;
      
      if (!searchResults || !Array.isArray(searchResults.entries)) {
        console.log('No search results found');
        return [];
      }

      const results: SearchResult[] = searchResults.entries.map((entry: any) => ({
        title: entry.title || 'Unknown Title',
        url: entry.url || entry.webpage_url || '',
        duration: this.formatDuration(entry.duration || 0),
        uploader: entry.uploader || entry.channel || 'Unknown Artist',
        viewCount: entry.view_count || 0,
        thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url
      }));

      // Cache the results
      this.cacheResults(cacheKey, results);
      
      console.log(`Found ${results.length} search results for: ${query}`);
      return results;

    } catch (error) {
      console.error('Error searching for songs:', error);
      return [];
    }
  }

  public async searchByArtist(artist: string, maxResults: number = 10): Promise<SearchResult[]> {
    const query = `artist:${artist}`;
    return this.searchSongs(query, maxResults);
  }

  public async searchByGenre(genre: string, maxResults: number = 10): Promise<SearchResult[]> {
    const query = `genre:${genre} music`;
    return this.searchSongs(query, maxResults);
  }

  public async getVideoInfo(url: string): Promise<SearchResult | null> {
    try {
      const flags: Flags = {
        dumpSingleJson: true,
        simulate: true
      };

      const videoInfo = await youtubeDl(url, flags) as any;
      
      if (!videoInfo) {
        return null;
      }

      return {
        title: videoInfo.title || 'Unknown Title',
        url: videoInfo.url || videoInfo.webpage_url || url,
        duration: this.formatDuration(videoInfo.duration || 0),
        uploader: videoInfo.uploader || videoInfo.channel || 'Unknown Artist',
        viewCount: videoInfo.view_count || 0,
        thumbnail: videoInfo.thumbnail || videoInfo.thumbnails?.[0]?.url
      };

    } catch (error) {
      console.error('Error getting video info:', error);
      return null;
    }
  }

  private formatDuration(seconds: number): string {
    if (!seconds || seconds === 0) {
      return 'Unknown';
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  private getCachedResults(key: string): SearchResult[] | null {
    const timestamp = this.cacheTimestamps.get(key);
    if (!timestamp || Date.now() - timestamp > this.CACHE_DURATION) {
      this.searchCache.delete(key);
      this.cacheTimestamps.delete(key);
      return null;
    }

    return this.searchCache.get(key) || null;
  }

  private cacheResults(key: string, results: SearchResult[]): void {
    this.searchCache.set(key, results);
    this.cacheTimestamps.set(key, Date.now());
  }

  public clearCache(): void {
    this.searchCache.clear();
    this.cacheTimestamps.clear();
    console.log('Search cache cleared');
  }

  public getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.searchCache.size,
      keys: Array.from(this.searchCache.keys())
    };
  }
}
