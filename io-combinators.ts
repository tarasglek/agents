import { Store, Operation } from "./storage-combinators.ts";
import { promises as fs } from "node:fs";

export async function replayJSONL<T>(
    src: string,
    dest: Store<T>,
): Promise<void> {
    let content: string;
    try {
        content = await fs.readFile(src, 'utf-8');
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    const lines = content.split("\n");
    for (const line of lines) {
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
}
