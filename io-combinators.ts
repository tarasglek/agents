import { Store, Operation } from "./storage-combinators.ts";
import { TextLineStream } from "jsr:@std/streams@0.224.0/text-line-stream";
import { JsonParseStream } from "jsr:@std/json@0.224.0/json-parse-stream";

export async function replayJSONL<T>(
    src: string,
    dest: Store<T>,
): Promise<void> {
    let fileHandle;
    try {
        fileHandle = await Deno.open(src, { read: true });
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return; // File doesn't exist, exit gracefully.
        }
        throw error;
    }

    const stream = fileHandle.readable
        .pipeThrough(new TextDecoderStream()) // decode Uint8Array to string
        .pipeThrough(new TextLineStream()) // split string line by line
        .pipeThrough(new JsonParseStream()); // parse each chunk as JSON

    try {
        for await (const line of stream) {
            if (!line || typeof line !== 'object') continue;
            const { key, operation, value } = line as {
                key: string;
                operation: Operation;
                value: T;
            };
            switch (operation) {
                case "put":
                    await dest.put(key, value);
                    break;
                case "delete":
                    await dest.delete(key);
                    break;
                default:
                    throw new Error(`Unknown operation in replay log: ${operation}`);
            }
        }
    } finally {
        fileHandle.close();
    }
}

export class JSONLAppender<T> extends Store<T> {
    constructor(public filename: string, private store: Store<T>) {
        super();
    }
    async put(ref: string, data: T): Promise<void> {
        await this.store.put(ref, data);
        const logEntry = { key: ref, operation: "put", value: data };
        const line = JSON.stringify(logEntry) + "\n";
        await Deno.writeTextFile(this.filename, line, { append: true });
    }
    async delete(ref: string): Promise<void> {
        await this.store.delete(ref);
        const logEntry = { key: ref, operation: "delete", value: null };
        const line = JSON.stringify(logEntry) + "\n";
        await Deno.writeTextFile(this.filename, line, { append: true });
    }

    async get(ref: string): Promise<T | null> {
        return await this.store.get(ref);
    }
}
