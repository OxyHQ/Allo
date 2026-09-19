/**
 * No route reads message content out of a request body.
 *
 * The backend stores and relays ciphertext. The one shape a regression would
 * take is a handler reaching for `req.body.text` / `.body` / `.content`, or a
 * zod schema for a conversation event growing such a field. Both are checked
 * against the TypeScript AST — not comments, not strings — so a comment
 * explaining the rule cannot trip it and a renamed identifier cannot dodge it.
 *
 * Two halves:
 * 1. Every `src/routes/**` and `src/services/platform/**` file: no property
 *    access chain rooted at `req.body` (or `request.body`) ends in a
 *    plaintext-shaped name, and no destructuring of `req.body` binds one.
 * 2. The contract: `submitEventRequestSchema`, `createConversationRequestSchema`,
 *    `typingEventSchema` and `createStatusRequestSchema` accept NO
 *    plaintext-shaped key, proven by parsing
 *    (a `z.object` strips unknown keys; a key that survives is declared).
 *
 * Anti-vacuity: the file census has a floor, the AST walker is pinned against a
 * source that DOES contain the shape, and the schema half asserts the schemas
 * accept their real fields.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  createConversationRequestSchema,
  createStatusRequestSchema,
  submitEventRequestSchema,
  typingEventSchema,
} from "@allo/shared-types";

const SRC = join(__dirname, "..", "..");
const SCANNED_DIRS = [join(SRC, "routes"), join(SRC, "services", "platform"), join(SRC, "app.ts")];

/** Names that would mean the server read something a human typed. */
const PLAINTEXT_NAMES = new Set(["text", "body", "content", "message", "plaintext", "caption", "name", "title"]);
const BODY_ROOTS = new Set(["req", "request"]);

function listFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target).flatMap((entry) => listFiles(join(target, entry))).filter((f) => f.endsWith(".ts"));
}

/** `req.body.<name>` chains and `const { <name> } = req.body` bindings. */
export function findPlaintextReads(source: string, fileName = "probe.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];

  const isReqBody = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "body" &&
    ts.isIdentifier(node.expression) &&
    BODY_ROOTS.has(node.expression.text);

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isReqBody(node.expression) && PLAINTEXT_NAMES.has(node.name.text)) {
      hits.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} req.body.${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node) && isReqBody(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
      if (PLAINTEXT_NAMES.has(node.argumentExpression.text)) {
        hits.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} req.body[${node.argumentExpression.text}]`);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isReqBody(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const bound = element.propertyName ?? element.name;
        if (ts.isIdentifier(bound) && PLAINTEXT_NAMES.has(bound.text)) {
          hits.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} destructures ${bound.text} from req.body`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

describe("the AST walker", () => {
  it("catches each shape it exists for, and ignores the same words in comments and strings", () => {
    expect(findPlaintextReads(`router.post("/", (req, res) => { const t = req.body.text; });`)).toHaveLength(1);
    expect(findPlaintextReads(`const { content } = request.body;`)).toHaveLength(1);
    expect(findPlaintextReads(`const { text: t } = req.body;`)).toHaveLength(1);
    expect(findPlaintextReads(`const v = req.body["message"];`)).toHaveLength(1);
    expect(findPlaintextReads(`// req.body.text is never read\nconst s = "req.body.content";\nconst ok = req.body.payload;`)).toEqual([]);
    expect(findPlaintextReads(`const other = somethingElse.body.text;`)).toEqual([]);
  });
});

describe("the routes and platform services", () => {
  it("never read a plaintext-shaped field out of a request body", () => {
    const files = SCANNED_DIRS.flatMap(listFiles);
    // Floor: the v1 routers and the platform services must be among what was scanned.
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files.some((f) => f.endsWith(join("routes", "v1", "events.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("services", "platform", "eventService.ts")))).toBe(true);

    const hits = files.flatMap((file) => findPlaintextReads(readFileSync(file, "utf8"), relative(SRC, file)));
    expect(hits).toEqual([]);
  });
});

describe("the contract", () => {
  it("strips any plaintext-shaped key from a conversation event, a create, and a typing frame", () => {
    const payload = Buffer.from("x").toString("base64");
    const extra = Object.fromEntries([...PLAINTEXT_NAMES].map((name) => [name, "hello"]));
    const event = submitEventRequestSchema.parse({ idempotencyKey: "k", kind: "app_message", epoch: 0, payload, ...extra });
    expect(Object.keys(event).sort()).toEqual(["epoch", "idempotencyKey", "kind", "payload"]);
    const create = createConversationRequestSchema.parse({
      kind: "group",
      mlsGroupId: payload,
      memberAccountIds: [],
      idempotencyKey: "k",
      ...extra,
    });
    expect(Object.keys(create).sort()).toEqual(["idempotencyKey", "kind", "memberAccountIds", "mlsGroupId"]);
    const typing = typingEventSchema.parse({ conversationId: "conv-00000001", ciphertext: payload, ...extra });
    expect(Object.keys(typing).sort()).toEqual(["ciphertext", "conversationId"]);
    // A status update is the one place a caption legitimately exists — inside
    // the ciphertext, never as a field. The request must drop one offered to it.
    const status = createStatusRequestSchema.parse({
      idempotencyKey: "k",
      payload,
      nonce: payload,
      sha256: "a".repeat(64),
      recipients: [{ instanceId: "inst-0000001", sealedKey: payload }],
      signature: Buffer.alloc(64, 1).toString("base64"),
      ...extra,
    });
    expect(Object.keys(status).sort()).toEqual([
      "blobIds",
      "idempotencyKey",
      "nonce",
      "payload",
      "recipients",
      "sha256",
      "signature",
    ]);
  });
});
