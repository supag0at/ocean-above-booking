// Q9 offline (0 API calls): TypeBox schema as pi tool parameters; pi validation/coercion; pi-schema export.
import { Type } from "typebox";
import { Value } from "typebox/value";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { obj, str, int, opt } from "@earendil-works/pi-schema";
import { log } from "./lib.ts";

export const RouteParams = Type.Object(
  { from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }), adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })), extra: Type.Optional(Type.Never()) },
  { additionalProperties: false },
);
log("q9.typebox.raw", RouteParams);
log("q9.typebox.ownKeys(incl. symbols/non-enumerable)", Reflect.ownKeys(RouteParams).map(String));
log("q9.typebox.JSON.stringify", JSON.stringify(RouteParams));

const tool: any = { name: "find_route", description: "Find route", parameters: RouteParams };
const cases: [string, any][] = [
  ["valid", { from: "Rome", to: "Oslo" }],
  ["valid+adults", { from: "Rome", to: "Oslo", adults: 2 }],
  ["extra field", { from: "Rome", to: "Oslo", foo: 1 }],
  ["extra (never)", { from: "Rome", to: "Oslo", extra: "x" }],
  ["number->string? from=1", { from: 1, to: "Oslo" }],
  ["bool->string? from=true", { from: true, to: "Oslo" }],
  ["string->int adults='2'", { from: "Rome", to: "Oslo", adults: "2" }],
  ["float adults=2.5", { from: "Rome", to: "Oslo", adults: 2.5 }],
  ["null optional adults=null", { from: "Rome", to: "Oslo", adults: null }],
  ["missing to", { from: "Rome" }],
  ["empty from", { from: "", to: "Oslo" }],
];
for (const [name, args] of cases) {
  const tb = Value.Check(RouteParams, args);
  try {
    const out = validateToolArguments(tool, { type: "toolCall", id: "x", name: "find_route", arguments: structuredClone(args) } as any);
    log("q9.pi.ACCEPT", { case: name, in: args, out, coerced: JSON.stringify(out) !== JSON.stringify(args), typeboxCheckOnRaw: tb });
  } catch (e: any) {
    log("q9.pi.REJECT", { case: name, in: args, err: e.message.split("\n").slice(1).join(" ").trim(), typeboxCheckOnRaw: tb });
  }
}

// pi-schema -> plain JSON Schema
const piSchema = obj({ from: str({ minLength: 1 }), to: str({ minLength: 1 }), adults: opt(int({ minimum: 1, maximum: 9 })) });
log("q9.pischema.ownKeys", Reflect.ownKeys(piSchema).map(String));
log("q9.pischema.JSON", JSON.stringify(piSchema));
log("q9.pischema.isPlainObject", Object.getPrototypeOf(piSchema) === Object.prototype);
log("q9.pischema.roundtripEqual", JSON.stringify(JSON.parse(JSON.stringify(piSchema))) === JSON.stringify(piSchema));
// Cross-check: TypeBox Value.Check on pi-schema JSON (any JSON Schema engine can consume it)
log("q9.pischema.checkedByTypeBox", { valid: Value.Check(piSchema as any, { from: "a", to: "b" }), extra: Value.Check(piSchema as any, { from: "a", to: "b", z: 1 }) });
