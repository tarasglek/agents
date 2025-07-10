import { stringify } from "jsr:@std/yaml";

export function stringifyYaml(obj: unknown): string {
    const yaml = stringify(obj, { skipInvalid: true });
    return yaml.replace(/(\s*role: )assistant/g, "$1🤖 assistant")
        .replace(/(\s*role: )user/g, "$1💬 user");
}
