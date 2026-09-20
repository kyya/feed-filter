import { storage } from '#imports';

// A small persistent, per-post-id TTL cache. Both remote passes need the exact
// same thing: results survive a browser restart so a post that scrolls out and
// back is never re-billed, and everything is invalidated wholesale when the
// settings they were produced under change.

interface Stored<T> {
  /** Signature of the settings the cached values were produced under. */
  sig: string;
  entries: Record<string, { value: T; at: number }>;
}

export interface TtlCache<T> {
  /** Cached values for `sig`, with expired entries dropped. */
  read(sig: string): Promise<Record<string, T>>;
  /** Merge fresh values in, expiring old ones and trimming to the cap. */
  write(sig: string, fresh: Record<string, T>): Promise<void>;
}

export function defineTtlCache<T>(
  key: `local:${string}`,
  ttlMs: number,
  maxEntries: number,
): TtlCache<T> {
  const empty: Stored<T> = { sig: '', entries: {} };
  const item = storage.defineItem<Stored<T>>(key, { fallback: empty });

  return {
    async read(sig) {
      const stored = (await item.getValue()) ?? empty;
      if (stored.sig !== sig) return {};
      const cutoff = Date.now() - ttlMs;
      const fresh: Record<string, T> = {};
      for (const [id, entry] of Object.entries(stored.entries ?? {})) {
        if (entry && entry.at > cutoff) fresh[id] = entry.value;
      }
      return fresh;
    },

    async write(sig, fresh) {
      const stored = (await item.getValue()) ?? empty;
      const cutoff = Date.now() - ttlMs;
      const now = Date.now();
      const entries = stored.sig === sig ? { ...stored.entries } : {};
      for (const [id, entry] of Object.entries(entries)) {
        if (!entry || entry.at <= cutoff) delete entries[id];
      }
      for (const [id, value] of Object.entries(fresh)) entries[id] = { value, at: now };

      const ids = Object.keys(entries);
      if (ids.length > maxEntries) {
        ids
          .sort((a, b) => entries[a].at - entries[b].at)
          .slice(0, ids.length - maxEntries)
          .forEach((id) => delete entries[id]);
      }
      await item.setValue({ sig, entries });
    },
  };
}
