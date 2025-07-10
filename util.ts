import { stringify } from "jsr:@std/yaml";

export function stringifyYaml(obj: unknown): string {
    // role = "🤖 " + role
    return stringify(obj, { skipInvalid: true });
}
