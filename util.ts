import { stringify } from "jsr:@std/yaml";

export function stringifyYaml(obj: unknown): string {
    try {
        obj = obj.map(msg => {
            let role = msg.role;
            if (role === "assistant") {
                role = "🤖 " + role
            }
            return { ...msg, role };
        });
    } catch (_e) {
    }
    return stringify(obj, { skipInvalid: true, quotingType: "'" });
}
