import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import ts from 'typescript';

/**
 * THE LEGACY CHAT PATH IS GONE, AND STAYS GONE.
 *
 * The app talks to the messaging platform through `@allo/react` and through
 * `lib/allo/`, and nothing else. This is a census over the SOURCE, parsed with
 * the TypeScript compiler rather than grepped, so a comment quoting the old
 * import (as several files do, to explain what replaced it) cannot count, and
 * an import written in any legal form — `import x from`, `import type`,
 * `require()`, `import()`, `export … from` — is seen.
 *
 * Four rules:
 *
 *  1. `socket.io-client` is imported nowhere. The SDK owns the socket.
 *  2. AsyncStorage is imported by nothing under `lib/allo/` and by no chat
 *     screen or component. Message data lives in the encrypted store; a
 *     preference store may still use it, and it may still import it — the
 *     rule is on the chat path, not the whole app.
 *  3. No `api.*`/`fetch` call names a legacy messaging endpoint
 *     (`/conversations`, `/messages`, `/devices`).
 *  4. Every import of `@allo/core` outside `lib/allo/` is type-only. A value
 *     import is a second place a client could be constructed.
 *
 * With a positive control — a synthetic file that breaks all four rules must
 * produce all four findings — and a vacuity floor on the number of files the
 * walk actually parsed, so a broken walker cannot report a clean tree.
 */

const FRONTEND = join(__dirname, '..', '..');
const SOURCE_DIRS = ['app', 'components', 'hooks', 'lib', 'stores', 'utils'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** Where the chat path is. Anything under these prefixes is subject to rule 2. */
const CHAT_PATH_PREFIXES = [
  'lib/allo/',
  'lib/chat/',
  'app/(chat)/index.tsx',
  'app/(chat)/new.tsx',
  'app/(chat)/c/',
  'app/(chat)/_layout.tsx',
  'app/(chat)/settings/devices.tsx',
  'components/conversation/',
  'components/messages/',
  'components/media/',
  'components/ContactDetails.tsx',
  'hooks/useConversation',
  'hooks/useChatConversations',
  'hooks/useCreateConversation',
  'hooks/useSenderInfo',
  'hooks/usePerson',
];

const LEGACY_ENDPOINT = /\/(conversations|messages|devices)(\/|$|\?)/;

export interface Finding {
  readonly file: string;
  readonly rule: 1 | 2 | 3 | 4;
  readonly detail: string;
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      found.push(...walk(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

function isChatPath(file: string): boolean {
  return CHAT_PATH_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/** Every module specifier a file names, with whether the import carries only types. */
interface ModuleUse {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function moduleUses(source: ts.SourceFile): ModuleUse[] {
  const uses: ModuleUse[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause === undefined
          ? false
          : clause.isTypeOnly ||
            (clause.name === undefined &&
              clause.namedBindings !== undefined &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.length > 0 &&
              clause.namedBindings.elements.every((element) => element.isTypeOnly));
      uses.push({ specifier: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      uses.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const [argument] = node.arguments;
      if ((isRequire || isDynamicImport) && argument && ts.isStringLiteral(argument)) {
        uses.push({ specifier: argument.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** The literal text of the first argument of every `api.<verb>(…)`, `authenticatedClient.<verb>(…)` and `fetch(…)` call. */
function requestPaths(source: ts.SourceFile): string[] {
  const paths: string[] = [];
  const literalText = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join('');
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isApi =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === 'api' || callee.expression.text === 'authenticatedClient') &&
        ['get', 'post', 'put', 'patch', 'delete'].includes(callee.name.text);
      const isFetch = ts.isIdentifier(callee) && callee.text === 'fetch';
      const [argument] = node.arguments;
      if ((isApi || isFetch) && argument) {
        const text = literalText(argument);
        if (text !== undefined) paths.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return paths;
}

/** The census over one file. Exported so the positive control runs the same code as the measurement. */
export function findingsFor(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const inChatPath = isChatPath(file);
  const inLibAllo = file.startsWith('lib/allo/');

  for (const use of moduleUses(source)) {
    if (use.specifier === 'socket.io-client' || use.specifier.startsWith('socket.io-client/')) {
      findings.push({ file, rule: 1, detail: `imports ${use.specifier}` });
    }
    if (use.specifier === '@react-native-async-storage/async-storage' && inChatPath) {
      findings.push({ file, rule: 2, detail: 'imports AsyncStorage on the chat path' });
    }
    if ((use.specifier === '@allo/core' || use.specifier.startsWith('@allo/core/')) && !inLibAllo && !use.typeOnly) {
      findings.push({ file, rule: 4, detail: `value import of ${use.specifier} outside lib/allo/` });
    }
  }
  for (const path of requestPaths(source)) {
    if (LEGACY_ENDPOINT.test(path)) findings.push({ file, rule: 3, detail: `requests ${path}` });
  }
  return findings;
}

function census(): { findings: Finding[]; scanned: number } {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const directory of SOURCE_DIRS) {
    for (const full of walk(join(FRONTEND, directory))) {
      const file = relative(FRONTEND, full).split(sep).join('/');
      findings.push(...findingsFor(file, readFileSync(full, 'utf8')));
      scanned += 1;
    }
  }
  return { findings, scanned };
}

describe('no legacy chat path', () => {
  const { findings, scanned } = census();

  it('parsed enough of the app to mean anything', () => {
    // A walker that found nothing would make every assertion below pass.
    expect(scanned).toBeGreaterThanOrEqual(150);
  });

  it('imports socket.io-client nowhere', () => {
    expect(findings.filter((f) => f.rule === 1)).toEqual([]);
  });

  it('keeps AsyncStorage off the chat path', () => {
    expect(findings.filter((f) => f.rule === 2)).toEqual([]);
  });

  it('calls no legacy messaging endpoint', () => {
    expect(findings.filter((f) => f.rule === 3)).toEqual([]);
  });

  it('imports @allo/core for values only inside lib/allo/', () => {
    expect(findings.filter((f) => f.rule === 4)).toEqual([]);
  });

  it('would see every shape it forbids (positive control)', () => {
    const offending = `
      // import { io } from 'socket.io-client'; — a comment must not count
      import { io } from 'socket.io-client';
      import AsyncStorage from '@react-native-async-storage/async-storage';
      import { createAlloClient, type AlloClient } from '@allo/core';
      import type { StorageAdapter } from '@allo/core';
      const sio = require('socket.io-client/dist/socket.io');
      export async function go(api: { get(p: string): Promise<unknown> }, id: string) {
        await api.get(\`/conversations/\${id}\`);
        await fetch('/api/messages?conversationId=1');
        const mod = await import('socket.io-client');
        return [io, AsyncStorage, createAlloClient, sio, mod];
      }
    `;
    const control = findingsFor('components/messages/Offending.tsx', offending);
    expect(control.filter((f) => f.rule === 1)).toHaveLength(3);
    expect(control.filter((f) => f.rule === 2)).toHaveLength(1);
    expect(control.filter((f) => f.rule === 3)).toHaveLength(2);
    // One value import; the `import type` beside it is allowed.
    expect(control.filter((f) => f.rule === 4)).toHaveLength(1);
  });

  it('allows what the rules allow (negative control)', () => {
    const allowed = `
      import type { ConversationView } from '@allo/core';
      import { useTimeline } from '@allo/react';
      export function usePreview(api: { get(p: string): Promise<unknown> }) {
        return [useTimeline, api.get('profile/settings/me')] as [unknown, Promise<ConversationView>];
      }
    `;
    expect(findingsFor('components/messages/Fine.tsx', allowed)).toEqual([]);
    // AsyncStorage in a preference store is off the chat path and permitted.
    expect(findingsFor('stores/somePreference.ts', "import AsyncStorage from '@react-native-async-storage/async-storage'; export default AsyncStorage;")).toEqual([]);
    // A value import of @allo/core inside lib/allo/ is the one place it belongs.
    expect(findingsFor('lib/allo/client.ts', "import { createAlloClient } from '@allo/core'; export default createAlloClient;")).toEqual([]);
  });
});
