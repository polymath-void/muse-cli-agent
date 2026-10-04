import { createHash } from "crypto";

export class ResponseCache {
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private maxCacheSize: number;
  private ttlSeconds: number;

  constructor(maxCacheSize = 1000, ttlSeconds = 60.0) {
    this.maxCacheSize = maxCacheSize;
    this.ttlSeconds = ttlSeconds;
  }

  private computeHash(model: string, body: any): string {
    const serialized = JSON.stringify({ model, body });
    return createHash("sha256").update(serialized).digest("hex");
  }

  get(model: string, body: any): any | null {
    const key = this.computeHash(model, body);
    const entry = this.cache.get(key);
    if (!entry) return null;
    const now = Date.now() / 1000;
    if (now - entry.timestamp > this.ttlSeconds) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(model: string, body: any, data: any) {
    const key = this.computeHash(model, body);
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, timestamp: Date.now() / 1000 });
  }
}
