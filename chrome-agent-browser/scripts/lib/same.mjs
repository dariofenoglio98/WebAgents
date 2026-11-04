/** Structural equality with object keys sorted: fixtures match, and the extension stores, canonical JSON. */
export const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value));
export const same = (a, b) => canonical(a) === canonical(b);
