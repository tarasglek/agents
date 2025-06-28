import { Store, Operation } from "./storage-combinators.ts";
import { promises as fs } from "node:fs";

export async function replayJSONL<T>(
    src: string,
    dest: Store<T>,
): Promise<void> {
    let fileHandle;
    try {
        fileHandle = await fs.open(src, "r");
    } catch (error: any) {
        if (error.code === "ENOENT") {
            return; // File doesn't exist, exit gracefully.
        }
        throw error;
    }

    // A transform stream that splits a stream of text into lines.
    class LineSplitter extends TransformStream<string, string> {
        private buffer = "";
        constructor() {
            super({
                transform: (chunk, controller) => {
                    this.buffer += chunk;
                    const lines = this.buffer.split("\n");
                    this.buffer = lines.pop()!; // The last part is either an incomplete line or an empty string.
                    for (const line of lines) {
                        controller.enqueue(line);
                    }
                },
                flush: (controller) => {
                    if (this.buffer) {
                        controller.enqueue(this.buffer);
                    }
                },
            });
        }
    }

    const stream = fileHandle.readableWebStream()
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new LineSplitter());

    try {
        for await (const line of stream) {
            if (line.trim() === "") continue;
            try {
                const { key, operation, value }: {
                    key: string;
                    operation: Operation;
                    value: T;
                } = JSON.parse(line);
                switch (operation) {
                    case "put":
                        await dest.put(key, value);
                        break;
                    case "delete":
                        await dest.delete(key);
                        break;
                    default:
                        console.warn(`Unknown operation in replay log: ${operation}`);
                }
            } catch (e) {
                console.error(`Failed to parse or process line: "${line}"`, e);
            }
        }
    } finally {
        await fileHandle.close();
    }
}

export class JSONAppender<T> extends Store<T> {
    constructor(public filename: string) {
    }
    async put(_ref: string, data: T): Promise<void> {
        //open  filename and append JSON.stringify(data) \n to it and close it
    }
}