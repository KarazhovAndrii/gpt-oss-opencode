// Minimal JSON Schema validator with conservative coercion, sized for the
// tool-parameter schemas OpenCode sends (zod -> JSON Schema 2020-12).
//
// It validates model-generated tool arguments and repairs only unambiguous
// mistakes (numeric strings for numbers, null for optional fields, JSON-encoded
// objects/arrays, ...). Every repair is reported so it can be logged.

export type JSONSchema = { [key: string]: any };

export interface Issue {
  path: string;
  message: string;
}

export interface CoerceResult {
  value: unknown;
  issues: Issue[];
  repairs: string[];
}

const DROP = Symbol("drop");

interface Ctx {
  root: JSONSchema;
  issues: Issue[];
  repairs: string[];
}

export function coerceAndValidate(schema: JSONSchema | undefined, value: unknown): CoerceResult {
  if (!schema || typeof schema !== "object") return { value, issues: [], repairs: [] };
  const ctx: Ctx = { root: schema, issues: [], repairs: [] };
  const out = walk(schema, value, "", ctx, false);
  return { value: out === DROP ? undefined : out, issues: ctx.issues, repairs: ctx.repairs };
}

function resolveRef(ref: string, root: JSONSchema): JSONSchema | undefined {
  if (!ref.startsWith("#")) return undefined;
  let cur: any = root;
  for (const part of ref.slice(1).split("/").filter(Boolean)) {
    cur = cur?.[decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))];
  }
  return cur;
}

function typesOf(schema: JSONSchema): string[] | undefined {
  if (schema.type === undefined) {
    if (schema.properties) return ["object"];
    if (schema.items) return ["array"];
    return undefined;
  }
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(t: string, v: unknown): boolean {
  const jt = jsonType(v);
  if (t === "number") return jt === "number" || jt === "integer";
  return t === jt;
}

function label(path: string): string {
  return path || "arguments";
}

/** Walks one schema node; returns the (possibly coerced) value or DROP. */
function walk(schema: JSONSchema | boolean, value: unknown, path: string, ctx: Ctx, optional: boolean): unknown {
  if (schema === true || schema === undefined) return value;
  if (schema === false) {
    ctx.issues.push({ path: label(path), message: "is not allowed" });
    return value;
  }
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, ctx.root);
    if (target) return walk({ ...target, ...withoutKey(schema, "$ref") }, value, path, ctx, optional);
  }
  if (Array.isArray(schema.allOf)) {
    let v = value;
    for (const sub of schema.allOf) v = walk(sub, v, path, ctx, optional);
    value = v;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    // Prefer a branch that accepts the value as-is; only then one that needs coercion.
    let best: { value: unknown; issues: Issue[]; repairs: string[] } | undefined;
    let coerced: { value: unknown; repairs: string[] } | undefined;
    for (const sub of union) {
      const sctx: Ctx = { root: ctx.root, issues: [], repairs: [] };
      const v = walk(sub, value, path, sctx, optional);
      if (sctx.issues.length === 0 && sctx.repairs.length === 0) return v;
      if (sctx.issues.length === 0) coerced ??= { value: v, repairs: sctx.repairs };
      else if (!best || sctx.issues.length < best.issues.length) best = { value: v, issues: sctx.issues, repairs: sctx.repairs };
    }
    if (coerced) {
      ctx.repairs.push(...coerced.repairs);
      return coerced.value;
    }
    if (best) {
      ctx.issues.push(...best.issues);
      return best.value;
    }
  }

  const types = typesOf(schema);

  if (value === null && !(types?.includes("null") ?? true)) {
    if (optional) {
      ctx.repairs.push(`removed null for optional '${label(path)}'`);
      return DROP;
    }
  }

  if (types && !types.some((t) => matchesType(t, value))) {
    const coerced = coerceScalar(types, value, path, ctx);
    if (coerced.ok) value = coerced.value;
    else {
      if (optional) {
        ctx.repairs.push(`removed optional '${label(path)}' with invalid type ${jsonType(value)} (expected ${types.join("|")})`);
        return DROP;
      }
      ctx.issues.push({ path: label(path), message: `must be ${types.join(" or ")}, got ${jsonType(value)}` });
      return value;
    }
  }

  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    ctx.issues.push({ path: label(path), message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
    const sv = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    const fixed = sv !== undefined ? schema.enum.find((e: unknown) => typeof e === "string" && e.toLowerCase() === sv) : undefined;
    if (fixed !== undefined) {
      ctx.repairs.push(`normalized '${label(path)}' to enum value ${JSON.stringify(fixed)}`);
      value = fixed;
    } else if (optional) {
      ctx.repairs.push(`removed optional '${label(path)}': ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
      return DROP;
    } else {
      ctx.issues.push({ path: label(path), message: `must be one of ${JSON.stringify(schema.enum)}` });
    }
  }

  const jt = jsonType(value);
  if (jt === "object") return walkObject(schema, value as Record<string, unknown>, path, ctx);
  if (jt === "array") return walkArray(schema, value as unknown[], path, ctx);
  if (jt === "number" || jt === "integer") {
    const n = value as number;
    const bad =
      (typeof schema.minimum === "number" && n < schema.minimum) ||
      (typeof schema.maximum === "number" && n > schema.maximum) ||
      (typeof schema.exclusiveMinimum === "number" && n <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === "number" && n >= schema.exclusiveMaximum);
    if (bad) {
      if (optional) {
        ctx.repairs.push(`removed optional '${label(path)}'=${n}: out of range`);
        return DROP;
      }
      ctx.issues.push({ path: label(path), message: `value ${n} is out of the allowed range` });
    }
  }
  if (jt === "string") {
    const s = value as string;
    if (typeof schema.minLength === "number" && s.length < schema.minLength) {
      ctx.issues.push({ path: label(path), message: `must have at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === "number" && s.length > schema.maxLength) {
      ctx.issues.push({ path: label(path), message: `must have at most ${schema.maxLength} characters` });
    }
  }
  return value;
}

function withoutKey(o: JSONSchema, k: string): JSONSchema {
  const { [k]: _omit, ...rest } = o;
  return rest;
}

function walkObject(schema: JSONSchema, obj: Record<string, unknown>, path: string, ctx: Ctx): unknown {
  const props: Record<string, JSONSchema> = schema.properties ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const sub = props[k];
    const childPath = path ? `${path}.${k}` : k;
    if (sub !== undefined) {
      if (v === undefined) continue;
      const r = walk(sub, v, childPath, ctx, !required.includes(k));
      if (r !== DROP) out[k] = r;
      continue;
    }
    if (schema.additionalProperties === false) {
      ctx.repairs.push(`removed unknown property '${childPath}'`);
      continue;
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const r = walk(schema.additionalProperties, v, childPath, ctx, true);
      if (r !== DROP) out[k] = r;
      continue;
    }
    out[k] = v;
  }
  for (const k of required) {
    if (out[k] === undefined) {
      ctx.issues.push({ path: path ? `${path}.${k}` : k, message: "is required" });
    }
  }
  return out;
}

function walkArray(schema: JSONSchema, arr: unknown[], path: string, ctx: Ctx): unknown {
  let out = arr;
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    out = [];
    arr.forEach((item, i) => {
      const r = walk(schema.items, item, `${path}[${i}]`, ctx, false);
      if (r !== DROP) out.push(r);
    });
  }
  if (typeof schema.minItems === "number" && out.length < schema.minItems) {
    ctx.issues.push({ path: label(path), message: `must have at least ${schema.minItems} items` });
  }
  if (typeof schema.maxItems === "number" && out.length > schema.maxItems) {
    ctx.issues.push({ path: label(path), message: `must have at most ${schema.maxItems} items` });
  }
  return out;
}

function coerceScalar(types: string[], value: unknown, path: string, ctx: Ctx): { ok: boolean; value?: unknown } {
  const note = (to: string) => ctx.repairs.push(`coerced '${label(path)}' from ${jsonType(value)} to ${to}`);
  if (typeof value === "string") {
    const s = value.trim();
    if ((types.includes("integer") || types.includes("number")) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
      const n = Number(s);
      if (types.includes("number") || Number.isInteger(n)) {
        note("number");
        return { ok: true, value: n };
      }
    }
    if (types.includes("boolean") && /^(true|false)$/i.test(s)) {
      note("boolean");
      return { ok: true, value: s.toLowerCase() === "true" };
    }
    if ((types.includes("object") || types.includes("array")) && /^[[{]/.test(s)) {
      try {
        const parsed = JSON.parse(s);
        if (types.some((t) => matchesType(t, parsed))) {
          note(jsonType(parsed));
          return { ok: true, value: parsed };
        }
      } catch {
        // fall through
      }
    }
    return { ok: false };
  }
  if (types.includes("string") && (typeof value === "number" || typeof value === "boolean")) {
    note("string");
    return { ok: true, value: String(value) };
  }
  if (types.includes("string") && value !== null && typeof value === "object") {
    // e.g. write.content given a JSON object for a .json file
    note("string (JSON-serialized)");
    return { ok: true, value: JSON.stringify(value, null, 2) };
  }
  if (types.includes("array") && value !== null && typeof value === "object" && !Array.isArray(value)) {
    note("array (wrapped single item)");
    return { ok: true, value: [value] };
  }
  return { ok: false };
}

/** Compact TypeScript-like signature used in model-facing error messages. */
export function signature(schema: JSONSchema | undefined): string {
  if (!schema?.properties) return "{}";
  const req: string[] = schema.required ?? [];
  const parts = Object.entries(schema.properties as Record<string, JSONSchema>).map(
    ([k, s]) => `${k}${req.includes(k) ? "" : "?"}: ${typeName(s)}`,
  );
  return `{ ${parts.join(", ")} }`;
}

function typeName(s: JSONSchema): string {
  if (Array.isArray(s.enum)) return s.enum.map((e: unknown) => JSON.stringify(e)).join(" | ");
  const t = typesOf(s)?.[0] ?? "any";
  if (t === "array") return `${s.items ? typeName(s.items) : "any"}[]`;
  if (t === "object") return s.properties ? signature(s) : "object";
  return t === "integer" ? "integer" : t;
}
