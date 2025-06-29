import { promises as fs } from "node:fs";
import * as path from "node:path";
import process from "node:process";

// Based on "Storage Combinators" paper.

export type Operation = "get" | "put" | "delete";
/**
 * The Store class, based on the Storage protocol from Figure 3.
 * It provides a generic, REST-like interface for accessing data.
 * This base class provides default implementations that throw "Not implemented" errors.
 */
export class Store<T> {
  async get(ref: string): Promise<T | null> {
    throw new Error("Not implemented");
  }

  async put(ref: string, data: T): Promise<void> {
    throw new Error("Not implemented");
  }

  // have not found a use for merge yet
  async merge(ref: string, data: T): Promise<void> {
    throw new Error("Not implemented");
  }

  async delete(ref: string): Promise<void> {
    throw new Error("Not implemented");
  }
}

/**
 * A Store that keeps data in an in-memory Map.
 * This is analogous to DictStore from the paper.
 */
export class DictStore<T> extends Store<T> {
  private readonly data = new Map<string, T>();

  async get(ref: string): Promise<T | null> {
    return this.data.get(ref) ?? null;
  }

  async put(ref: string, data: T): Promise<void> {
    this.data.set(ref, data);
  }

  async delete(ref: string): Promise<void> {
    this.data.delete(ref);
  }

  async merge(ref: string, data: T): Promise<void> {
    const existing = this.data.get(ref);
    if (
      existing && typeof existing === "object" && existing !== null &&
      typeof data === "object" && data !== null
    ) {
      const merged = { ...existing, ...data };
      this.data.set(ref, merged as T);
    } else {
      // For primitives, or if not existing, merge is same as put.
      this.data.set(ref, data);
    }
  }
}

/**
 * A base class for stores that handle metadata alongside data.
 * It extends the base Store class, with the stored type constrained
 * to be an object containing data and optional metadata.
 */
export abstract class StoreWithMetadata<D, M>
  extends Store<{ data: D; metadata?: M }> { }

/**
 * A Store for fetching resources over HTTP.
 * This acts as our primary data source.
 * It returns the response body as data, and a Store for the headers as metadata.
 */
export class HttpStore extends StoreWithMetadata<string, Store<string>> {
  async get(
    ref: string,
  ): Promise<{ data: string; metadata?: Store<string> | undefined } | null> {
    try {
      const response = await fetch(ref);
      if (!response.ok) {
        // 404 is treated as a valid "not found" response.
        if (response.status === 404) {
          return null;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const body = await response.text();
      return { data: body, metadata: new HeadersStore(response.headers) };
    } catch (error) {
      console.error(`HttpStore get failed for ref '${ref}':`, error);
      return null;
    }
  }

  put(
    ref: string,
    data: { data: string; metadata?: Store<string> | undefined },
  ): Promise<void> {
    // A simple read-only source doesn't implement put/merge/delete.
    throw new Error("HttpStore is read-only.");
  }

  merge(
    ref: string,
    data: { data: string; metadata?: Store<string> | undefined },
  ): Promise<void> {
    throw new Error("HttpStore is read-only.");
  }

  delete(ref: string): Promise<void> {
    throw new Error("HttpStore is read-only.");
  }
}

/**
 * A read-only Store for accessing HTTP Headers.
 * It lazily accesses headers from a Headers object.
 */
export class HeadersStore extends Store<string> {
  private readonly headers: Headers;

  constructor(headers: Headers) {
    super();
    this.headers = headers;
  }

  async get(ref: string): Promise<string | null> {
    return this.headers.get(ref);
  }

  put(ref: string, data: string): Promise<void> {
    throw new Error("HeadersStore is read-only.");
  }

  merge(ref: string, data: string): Promise<void> {
    throw new Error("HeadersStore is read-only.");
  }

  delete(ref: string): Promise<void> {
    throw new Error("HeadersStore is read-only.");
  }
}

/**
 * A Store for the local file system using node:fs/promises.
 * This will serve as our cache.
 */
export class DiskStore extends Store<string> {
  async get(ref: string): Promise<string | null> {
    try {
      return await fs.readFile(ref, "utf-8");
    } catch (error: any) {
      // A missing file is a cache miss, not an error.
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async put(ref: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(ref), { recursive: true });
    await fs.writeFile(ref, data, "utf-8");
  }

  async delete(ref: string): Promise<void> {
    try {
      await fs.unlink(ref);
    } catch (error: any) {
      // It's not an error if the file to delete doesn't exist.
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async merge(ref: string, data: string): Promise<void> {
    // For files, merge can be implemented as append.
    try {
      await fs.appendFile(ref, data, "utf-8");
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // If file doesn't exist, creating it is a valid merge outcome.
        await this.put(ref, data);
      } else {
        throw error;
      }
    }
  }
}

/**
 * A Store that logs to the console.
 * This acts as a sink for logging operations.
 */
export class ConsoleStore extends Store<string> {
  async put(_ref: string, data: string): Promise<void> {
    // Use process.stdout.write for raw output without a newline.
    await process.stdout.write(data);
  }
}

const fwdSlashJoiner = (a: string, b: string) => `${a}/${b}`;

/**
 * A RelativeStore combinator, based on Figure 15.
 * It maps references by prepending a prefix.
 */
export class RelativeStore<T> extends Store<T> {
  public readonly source: Store<T>;
  private readonly prefix: string;
  private readonly joiner: (a: string, b: string) => string;

  constructor(
    source: Store<T>,
    prefix: string,
    joiner: (a: string, b: string) => string = fwdSlashJoiner,
  ) {
    super();
    this.source = source;
    this.prefix = prefix;
    this.joiner = joiner;
  }

  private mapRef(ref: string): string {
    return this.joiner(this.prefix, ref);
  }

  async get(ref: string): Promise<T | null> {
    return this.source.get(this.mapRef(ref));
  }

  async put(ref: string, data: T): Promise<void> {
    return this.source.put(this.mapRef(ref), data);
  }

  async merge(ref: string, data: T): Promise<void> {
    return this.source.merge(this.mapRef(ref), data);
  }

  async delete(ref: string): Promise<void> {
    return this.source.delete(this.mapRef(ref));
  }
}

/**
 * A SerializerStore is a mapping store that transforms data on writes and reads.
 * It is generic over an input type `In` (the type this store presents) and
 * an output type `Out` (the type the underlying `source` store uses).
 */
export class SerializerStore<In, Out> extends Store<In> {
  private readonly source: Store<Out>;
  private readonly onWrite: (data: In) => Out;
  private readonly onRead: (data: Out) => In;

  constructor(
    source: Store<Out>,
    onWrite: (data: In) => Out,
    onRead: (data: Out) => In,
  ) {
    super();
    this.source = source;
    this.onWrite = onWrite;
    this.onRead = onRead;
  }

  async get(ref: string): Promise<In | null> {
    const dataOut = await this.source.get(ref);
    if (dataOut === null) {
      return null;
    }
    return this.onRead(dataOut);
  }

  async put(ref: string, data: In): Promise<void> {
    const dataOut = this.onWrite(data);
    return this.source.put(ref, dataOut);
  }

  async merge(ref: string, data: In): Promise<void> {
    const dataOut = this.onWrite(data);
    return this.source.merge(ref, dataOut);
  }

  async delete(ref: string): Promise<void> {
    // Pass-through for delete
    return this.source.delete(ref);
  }
}

/**
 * A CachingStore combinator, based on Figure 18.
 * It combines a source store and a cache store.
 */
export class CachingStore<T> extends Store<T> {
  private readonly source: Store<T>;
  private readonly cache: Store<T>;

  constructor(source: Store<T>, cache: Store<T>) {
    super();
    this.source = source;
    this.cache = cache;
  }

  async get(ref: string): Promise<T | null> {
    // Try to get data from cache first.
    let data = await this.cache.get(ref);
    if (data !== null) {
      return data;
    }

    // On a miss, get data from the source.
    data = await this.source.get(ref);

    // If source returned data, store it in the cache for next time.
    if (data !== null) {
      await this.cache.put(ref, data);
    }

    return data;
  }

  async put(ref: string, data: T): Promise<void> {
    // This is a write-through cache. Write to both cache and source.
    await this.cache.put(ref, data);
    await this.source.put(ref, data);
  }

  async merge(ref: string, data: T): Promise<void> {
    // This implementation follows the logic from the paper for CachingStore merge:
    // 1. Ensure the object is in the cache (by calling get).
    // 2. Merge the new data into the cached object.
    // 3. Get the full merged object from the cache.
    // 4. Write the full merged object to the source.
    await this.get(ref);
    await this.cache.merge(ref, data);
    const mergedData = await this.cache.get(ref);
    if (mergedData !== null) {
      await this.source.put(ref, mergedData);
    }
  }

  async delete(ref: string): Promise<void> {
    // Delete from both cache and source.
    await this.cache.delete(ref);
    await this.source.delete(ref);
  }
}

/**
 * A LoggingStore combinator, based on Figure 19.
 * It's a pass-through store that logs operations to another store.
 *
 * This store "watches" all operations (get, put, delete) that pass
 * through it and sends a record of them to its `logStore`. This is very
 * versatile. For simple debugging, the `logStore` can be a `ConsoleStore`
 * that prints to the screen. For more advanced systems, it could send these
 * change records to a message queue. This is the core idea behind a
 * publish/subscribe (pub/sub) system, a pattern used to keep different
 * parts of an application synchronized.
 */
export class LoggingStore<T> extends Store<T> {
  private readonly source: Store<T>;
  private readonly logStore: Store<string>;

  constructor(source: Store<T>, logStore: Store<string>) {
    super();
    this.source = source;
    this.logStore = logStore;
  }

  private async log(operation: string, ref: string) {
    const message = `${operation} ${ref}`;
    // The 'ref' for the logStore.put is arbitrary. 'log' is fine.
    return this.logStore.put("log", message);
  }

  async get(ref: string): Promise<T | null> {
    await this.log("GET", ref);
    return this.source.get(ref);
  }

  async put(ref: string, data: T): Promise<void> {
    await this.log("PUT", ref);
    return this.source.put(ref, data);
  }

  async merge(ref: string, data: T): Promise<void> {
    await this.log("MERGE", ref);
    return this.source.merge(ref, data);
  }

  async delete(ref: string): Promise<void> {
    await this.log("DELETE", ref);
    return this.source.delete(ref);
  }
}

/**
 * Example usage demonstrating the caching behavior.
 * This is analogous to the client compositions in Section 4.4.
 */
async function main() {
  // 1. Set up the stores.
  const consoleLog = new ConsoleStore();
  const sourceLogPipeline = new SerializerStore<string, string>(
    consoleLog,
    (data) => `[SOURCE] ${data}\n`,
    (data) => {
      throw new Error("sourceLogPipeline is write-only");
    },
  );
  const cacheLogPipeline = new SerializerStore<string, string>(
    consoleLog,
    (data) => `[CACHE] ${data}\n`,
    (data) => {
      throw new Error("cacheLogPipeline is write-only");
    },
  );

  const httpSource = new HttpStore();
  const relativeHttpSource = new RelativeStore(
    httpSource,
    "https://jsonplaceholder.typicode.com",
  );
  const loggedHttpSourceWithMetadata = new LoggingStore(
    relativeHttpSource,
    sourceLogPipeline,
  );

  // A SerializerStore to strip metadata from the source, so it can be
  // cached by a simple string-based cache.
  const source = new SerializerStore(
    loggedHttpSourceWithMetadata,
    // onWrite: string -> {data, metadata}. Metadata is optional.
    (data: string) => ({ data: data }),
    // onRead: {data, metadata} -> string
    (result: { data: string; metadata?: Store<string> }) => result.data,
  );

  const dictCache = new DictStore<string>();
  const loggedDictCache = new LoggingStore(dictCache, cacheLogPipeline);

  const store = new CachingStore(source, loggedDictCache);

  const resourceRef = "todos/1";

  // 2. First request for the resource.
  console.log("--- First request (should be a cache miss) ---");
  let todo = await store.get(resourceRef);
  console.log(`Data: ${todo}`);
  console.log("");

  // 3. Second request for the same resource.
  console.log("--- Second request (should be a cache hit) ---");
  todo = await store.get(resourceRef);
  console.log(`Data: ${todo}`);
  console.log("");

  // 4. Clean up the cache.
  console.log("--- Cleaning up cache ---");
  // In a real app, you might not delete from the source.
  // We use the CachingStore's delete which would try both.
  await dictCache.delete(resourceRef);
  console.log(`Cache for '${resourceRef}' cleaned.`);
}

// main().catch(console.error);
