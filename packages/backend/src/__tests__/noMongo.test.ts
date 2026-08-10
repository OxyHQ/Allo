/**
 * The repo does not reach MongoDB, and cannot start doing so by accident.
 *
 * Allo's Mongo → Postgres port finished in four domain switches plus a final
 * cleanup. This guard exists because the residue outlived the port three
 * separate times — a dependency kept for a script that had already run, a
 * `MONGODB_URI` in an onboarding doc a claims ledger's own file list had missed,
 * and a CI step downloading a `mongod` binary for a package nobody installed. A
 * repo that currently happens not to use Mongo is worth less than one that
 * cannot regress to it.
 *
 * ## What it scans, and what it deliberately EXEMPTS
 *
 * Comments and markdown are exempt, as they are in every Oxy repo carrying this
 * check — and saying so here matters, because that exemption is precisely where
 * the residue kept surviving. Prose is allowed to mention Mongo: `CONVENTIONS.md`
 * explains why an id column is `text` by naming the ObjectId hex it has to hold,
 * and the Dockerfile records that its Node pin was originally justified by the
 * MongoDB driver. Those are explanations of decisions that are still binding.
 * What is NOT allowed is anything that could reconnect the process: a
 * dependency, an import, or a connection string.
 *
 * So a failure here always names something executable. If this ever fires on a
 * comment, the comment stripper is wrong — fix it rather than deleting the
 * sentence, because the sentence is usually the one explaining why a column
 * looks odd.
 *
 * ## Anti-vacuity
 *
 * Every assertion in a check like this passes on an empty input set, and an
 * empty set is exactly what a broken traversal produces. Three defences:
 *
 * - `git ls-files` is the enumerator, so the scan cannot disagree with what git
 *   tracks and build output is excluded for free rather than by an ignore list
 *   that rots. A path in the index that is missing from the working tree is
 *   recorded as a FAILURE rather than skipped — an unreadable file is exactly
 *   where a reintroduction would hide.
 *
 *   The consequence is worth stating because it looks like a hole and is not:
 *   `git ls-files` reads the INDEX, so a file that exists on disk but has never
 *   been `git add`-ed is invisible here. Measured — an untracked
 *   `probeMongo.ts` importing mongoose left this suite fully green, and staging
 *   the same file turned it red naming the path. That is the right boundary:
 *   CI runs against the committed tree, so anything that can reach `main` is in
 *   the index by definition. It does mean that when mutation-testing this file
 *   you must `git add -f` the probe first, or you are measuring emptiness.
 * - Floors on the number of files actually scanned, per kind. A traversal that
 *   silently matched nothing fails instead of passing.
 * - The predicate is pinned against buffers that really contain the offending
 *   text, and against ones where it appears only in a comment — so the check is
 *   proven able to tell those two apart rather than assumed to be.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** `packages/backend/src/__tests__` → the repo root. */
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Package names that mean "this process can open a Mongo connection".
 *
 * Matched as the whole name or a scoped/suffixed variant, so
 * `mongodb-memory-server` and `@types/mongodb` are caught without
 * `mongodb-anything-unrelated` being matched by a bare substring.
 */
const MONGO_PACKAGE_PATTERN = /^(@types\/)?(mongoose|mongodb|bson)(-[\w.-]+)?$/;

/** Tokens that cannot appear in executable code without meaning Mongo. */
const MONGO_CODE_TOKENS = [
  "mongoose",
  "mongodb://",
  "mongodb+srv://",
  "MONGODB_URI",
];

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The ONE file exempt from the source scan: this one.
 *
 * It has to contain the offending tokens as STRING LITERALS, because the
 * predicate cases at the bottom pin the check against text that really contains
 * them — that is what stops the whole suite passing with a stripper that removes
 * everything. Those literals are not comments, so the stripper correctly keeps
 * them, and the scan correctly flags the file. The exemption is the resolution.
 *
 * It is a single literal path rather than a pattern, and the cases below assert
 * the list has exactly one entry and that the entry is a test file — so this
 * cannot quietly grow into a hole, and can never be pointed at production code.
 * A rename makes the exemption dead and the renamed file gets scanned, which
 * fails loudly rather than silently widening anything.
 *
 * Found by CI rather than locally, and the reason is worth keeping: `git
 * ls-files` reads the INDEX, and this file was untracked while it was being
 * written, so the run that "passed" had never scanned it. **A new file must be
 * staged before a run of this suite means anything.** That is the same trap
 * documented above for mutation probes, met from the other direction.
 */
const SELF = "packages/backend/src/__tests__/noMongo.test.ts";
const SOURCE_SCAN_EXEMPTIONS = [SELF];

/**
 * Strip `//` and block comments, leaving string literals intact.
 *
 * String-aware because `"mongodb://"` inside a connection string IS the thing
 * being looked for, and a naive stripper that ignored quoting would drop a
 * `//` in the middle of a URI and hide it.
 *
 * Newlines inside stripped comments are preserved so reported line numbers stay
 * true. A regex literal containing an unescaped `/*` would be mis-read as a
 * comment opener; that can only ever HIDE code, so the pinned cases below are
 * what prove the stripper still catches a real import.
 */
export function stripComments(source: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let out = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "code") {
      if (char === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        mode = char === "'" ? "single" : char === '"' ? "double" : "template";
      }
      out += char;
      index += 1;
      continue;
    }

    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        out += char;
      }
      index += 1;
      continue;
    }

    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      if (char === "\n") out += char;
      index += 1;
      continue;
    }

    // Inside a string literal: copy verbatim, honouring escapes.
    if (char === "\\") {
      out += char;
      if (index + 1 < source.length) out += source[index + 1];
      index += 2;
      continue;
    }
    out += char;
    const closer = mode === "single" ? "'" : mode === "double" ? '"' : "`";
    if (char === closer) mode = "code";
    index += 1;
    continue;
  }

  return out;
}

/** Strip `#` comments, for formats whose comments are line-oriented. */
export function stripHashComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
}

/** Every mongo-ish dependency named by one parsed `package.json`. */
export function mongoDependenciesIn(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const record: Record<string, unknown> = manifest as Record<string, unknown>;
  const found: string[] = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const map = record[field];
    if (typeof map !== "object" || map === null) continue;
    for (const name of Object.keys(map as Record<string, unknown>)) {
      if (MONGO_PACKAGE_PATTERN.test(name)) found.push(`${field}.${name}`);
    }
  }
  return found;
}

interface Failure {
  readonly file: string;
  readonly detail: string;
}

function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return output.split("\0").filter((path) => path.length > 0);
}

/**
 * Read a tracked file. An index entry with no readable file on disk is a
 * FAILURE, never a skip — that is the one gap through which a reintroduction
 * could pass unexamined.
 */
function readTracked(path: string): { text: string } | { error: string } {
  try {
    return { text: readFileSync(join(REPO_ROOT, path), "utf8") };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `tracked by git but unreadable: ${message}` };
  }
}

describe("the repo cannot reach MongoDB", () => {
  const files = trackedFiles();

  it("enumerates the repository, so the scans below are not vacuous", () => {
    // A floor, not the exact count: it fails a broken traversal without
    // needing an edit every time a file is added.
    expect(files.length).toBeGreaterThan(600);
  });

  it("exempts exactly one file from the source scan, and it is a test", () => {
    // The exemption is the only hole in the source scan, so it is pinned by
    // size and by kind. Adding a second entry, or pointing this one at
    // production code, fails here rather than passing quietly.
    expect(SOURCE_SCAN_EXEMPTIONS).toEqual([SELF]);
    expect(SELF.endsWith(".test.ts")).toBe(true);
    // And it must really be tracked — an exemption for a path git does not
    // carry is an exemption that has drifted off its file.
    expect(files).toContain(SELF);
  });

  it("declares no Mongo dependency in any manifest", () => {
    const manifests = files.filter(
      (path) => path === "package.json" || path.endsWith("/package.json"),
    );
    expect(manifests.length).toBeGreaterThanOrEqual(5);

    const failures: Failure[] = [];
    for (const path of manifests) {
      const read = readTracked(path);
      if ("error" in read) {
        failures.push({ file: path, detail: read.error });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ file: path, detail: `unparseable JSON: ${message}` });
        continue;
      }
      for (const dependency of mongoDependenciesIn(parsed)) {
        failures.push({ file: path, detail: dependency });
      }
    }

    expect(failures).toEqual([]);
  });

  it("has no Mongo package in the lockfile", () => {
    const read = readTracked("bun.lock");
    if ("error" in read) throw new Error(`bun.lock ${read.error}`);
    expect(read.text.length).toBeGreaterThan(1000);

    // Lockfile entries are quoted package specifiers; the leading quote is what
    // keeps this off a transitive path that merely contains the word.
    const offenders = [...read.text.matchAll(/"(@types\/)?(mongoose|mongodb|mongodb-memory-server)[@"]/g)]
      .map((match) => match[0]);
    expect(offenders).toEqual([]);
  });

  it("imports nothing Mongo-shaped from any source file", () => {
    const sources = files.filter(
      (path) =>
        CODE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
        !SOURCE_SCAN_EXEMPTIONS.includes(path),
    );
    // Every language present must be in CODE_EXTENSIONS: a `require()` in a
    // .js file is invisible to a .ts-only scan, and that gap reads as a pass.
    expect(sources.length).toBeGreaterThan(500);

    const failures: Failure[] = [];
    for (const path of sources) {
      const read = readTracked(path);
      if ("error" in read) {
        failures.push({ file: path, detail: read.error });
        continue;
      }
      const code = stripComments(read.text);
      for (const token of MONGO_CODE_TOKENS) {
        if (code.includes(token)) {
          failures.push({ file: path, detail: `executable reference to ${token}` });
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("asks nobody to configure a Mongo connection", () => {
    const configs = files.filter(
      (path) =>
        path.endsWith(".env.example") ||
        /^\.github\/workflows\/.*\.ya?ml$/.test(path) ||
        path.endsWith("Dockerfile") ||
        path.endsWith("docker-compose.postgres.yml"),
    );
    expect(configs.length).toBeGreaterThanOrEqual(6);

    const failures: Failure[] = [];
    for (const path of configs) {
      const read = readTracked(path);
      if ("error" in read) {
        failures.push({ file: path, detail: read.error });
        continue;
      }
      const active = stripHashComments(read.text);
      for (const token of ["MONGODB_URI", "mongodb://", "mongodb+srv://", "mongodb-memory-server"]) {
        if (active.includes(token)) {
          failures.push({ file: path, detail: `active reference to ${token}` });
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

/**
 * The predicates, pinned against text that really contains the thing.
 *
 * Without these the suite above passes just as happily with a stripper that
 * removes everything, a dependency reader that always returns `[]`, or a token
 * list nothing can match.
 */
describe("the guard can tell an offence from a mention", () => {
  it("catches a real import, in each supported form", () => {
    expect(stripComments(`import mongoose from "mongoose";`)).toContain("mongoose");
    expect(stripComments(`const m = require("mongoose");`)).toContain("mongoose");
    expect(stripComments(`await import("mongodb://host/db");`)).toContain("mongodb://");
    expect(stripComments(`const uri = process.env.MONGODB_URI;`)).toContain("MONGODB_URI");
  });

  it("ignores the same text in a line comment, a block comment and a JSDoc", () => {
    expect(stripComments(`// import mongoose from "mongoose";`)).not.toContain("mongoose");
    expect(stripComments(`/* mongoose */`)).not.toContain("mongoose");
    expect(stripComments(`/**\n * MONGODB_URI used to live here.\n */`)).not.toContain(
      "MONGODB_URI",
    );
  });

  it("does not mistake a URI's slashes for a comment", () => {
    // The reason the stripper is string-aware: a naive one truncates here and
    // reports the file clean.
    expect(stripComments(`const uri = "mongodb://user:pw@host:27017/db";`)).toContain(
      "mongodb://",
    );
  });

  it("keeps code that follows a comment on the same line", () => {
    expect(stripComments(`/* note */ import mongoose from "mongoose";`)).toContain("mongoose");
  });

  it("reads every dependency field, not just `dependencies`", () => {
    expect(mongoDependenciesIn({ dependencies: { mongoose: "^9.0.0" } })).toEqual([
      "dependencies.mongoose",
    ]);
    expect(
      mongoDependenciesIn({ devDependencies: { "mongodb-memory-server": "^11.0.0" } }),
    ).toEqual(["devDependencies.mongodb-memory-server"]);
    expect(mongoDependenciesIn({ optionalDependencies: { "@types/mongodb": "^4.0.0" } })).toEqual([
      "optionalDependencies.@types/mongodb",
    ]);
  });

  it("does not flag a package that merely contains the word", () => {
    expect(mongoDependenciesIn({ dependencies: { "not-mongodb-related": "1.0.0" } })).toEqual([]);
    expect(mongoDependenciesIn({ dependencies: { postgres: "3.4.9" } })).toEqual([]);
  });

  it("treats a `#`-commented variable as inactive and a set one as active", () => {
    expect(stripHashComments("# MONGODB_URI=mongodb://localhost")).not.toContain("MONGODB_URI");
    expect(stripHashComments("MONGODB_URI=mongodb://localhost")).toContain("MONGODB_URI");
  });
});
