// Q9 Fastify (offline, fastify.inject): same TypeBox schema as route body schema.
//   default ajv options vs. strict ajv options (no coercion, no removeAdditional).
import Fastify from "fastify";
import { Type } from "typebox";
import { obj, str, int, opt } from "@earendil-works/pi-schema";
import { log } from "./lib.ts";

const RouteParams = Type.Object(
  { from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }), adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })), extra: Type.Optional(Type.Never()) },
  { additionalProperties: false },
);
const PiParams = obj({ from: str({ minLength: 1 }), to: str({ minLength: 1 }), adults: opt(int({ minimum: 1, maximum: 9 })) });
const bodies: [string, any][] = [
  ["valid", { from: "Rome", to: "Oslo", adults: 2 }],
  ["extra field", { from: "Rome", to: "Oslo", foo: 1 }],
  ["extra(never)", { from: "Rome", to: "Oslo", extra: "x" }],
  ["from=1", { from: 1, to: "Oslo" }],
  ["adults='2'", { from: "Rome", to: "Oslo", adults: "2" }],
  ["adults=2.5", { from: "Rome", to: "Oslo", adults: 2.5 }],
  ["missing to", { from: "Rome" }],
];
async function run(label: string, schema: any, ajvOpts?: any) {
  const app = Fastify(ajvOpts ? { ajv: { customOptions: ajvOpts } } : {});
  app.post("/r", { schema: { body: schema, response: { 200: { type: "object", properties: { got: schema } } } } }, async (req) => ({ got: req.body }));
  for (const [name, body] of bodies) {
    const r = await app.inject({ method: "POST", url: "/r", payload: body });
    const j = r.json();
    log(`q9-fastify[${label}]`, { case: name, status: r.statusCode, result: r.statusCode === 200 ? j.got : j.message });
  }
  await app.close();
}
await run("typebox/default-ajv", RouteParams);
await run("typebox/strict-ajv", RouteParams, { coerceTypes: false, removeAdditional: false });
await run("pi-schema/strict-ajv", PiParams, { coerceTypes: false, removeAdditional: false });
