// FG-839: a content guard over the dashboard browser tier's SOURCES, for the crash-on-
// import class the FG-642 census cannot see.
//
// Three times an agent-written suite defaulted its screenshot directory to the container
// path `/task/screenshots` and created it at module scope (FG-823, FG-832 at 46cd08f7,
// a near miss on FG-829). On the CI runner and any host that path is EACCES, so the file
// throws on import, its tests never register, and the only signal is the FG-642
// fail-first proof reporting the tier as short — a full CI cycle and a fix pass each
// time. The rule was in every brief; it is enforced here instead.
//
// Every dashboard/browser-tests/*.test.ts is parsed (not executed) and fails, naming
// file and line, on:
//
//   (a) a string literal starting with `/task/` used as the fallback of `??`/`||`, or
//       passed to mkdirSync / mkdtempSync / writeFileSync;
//   (b) a module-scope mkdirSync whose path is not rooted in a temp dir or in the
//       env-override branch. Accepted:
//         const SHOTS = process.env.<NAME>_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "<prefix>-"));
//         mkdirSync(SHOTS, { recursive: true });
//       plus paths derived from tmpdir()/mkdtempSync(), and a bare `process.env.X` only
//       under an `if (X)` guard;
//   (c) two suites declaring the same fixture `*PORT` constant value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript";
import { tierSource, tierSuites } from "./browser-tier-census.js";

const TIER = join("dashboard", "browser-tests");

interface Suite {
  file: string;
  source: string;
}

interface PortDecl {
  file: string;
  line: number;
  name: string;
  value: number;
}

type Root = "temp" | "env-temp" | "env" | "other";

const FS_WRITERS = new Set(["mkdirSync", "mkdtempSync", "writeFileSync"]);
const PATH_BUILDERS = new Set(["join", "resolve", "realpathSync", "mkdtempSync"]);
const PORT_NAME = /(?:^|_)PORT$/;
const TASK_PATH = /^\/task(?:\/|$)/;

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function isProcessEnv(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "env" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "process"
  );
}

function isEnvRead(expression: ts.Expression): boolean {
  expression = unwrap(expression);
  return (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    isProcessEnv(expression.expression)
  );
}

function isFallback(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  );
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassLike(node);
}

/** Every node that runs when the module is imported: descends everything except function and class bodies. */
function forEachModuleScopeNode(sourceFile: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    if (isFunctionBoundary(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);
}

function forEachNode(sourceFile: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);
}

function moduleBindings(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  forEachModuleScopeNode(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    // `for (const dir of [a, b]) mkdirSync(dir)` — the loop variable is each element in turn.
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const name = node.initializer.declarations[0]?.name;
      if (name && ts.isIdentifier(name) && ts.isArrayLiteralExpression(unwrap(node.expression))) bindings.set(name.text, node.expression);
    }
  });
  return bindings;
}

/** The literal a path expression starts from, following identifiers and join/resolve's first argument. */
function literalRoot(expression: ts.Expression, bindings: Map<string, ts.Expression>, seen = new Set<string>()): string | undefined {
  expression = unwrap(expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) {
    if (expression.head.text !== "") return expression.head.text;
    return literalRoot(expression.templateSpans[0]!.expression, bindings, seen);
  }
  if (ts.isIdentifier(expression)) {
    const init = bindings.get(expression.text);
    if (!init || seen.has(expression.text)) return undefined;
    seen.add(expression.text);
    return literalRoot(init, bindings, seen);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((e) => literalRoot(e, bindings, new Set(seen))).find((r) => r !== undefined && TASK_PATH.test(r));
  }
  if (ts.isCallExpression(expression) && PATH_BUILDERS.has(calleeName(expression) ?? "") && expression.arguments[0]) {
    return literalRoot(expression.arguments[0], bindings, seen);
  }
  return undefined;
}

function pathRoot(expression: ts.Expression, bindings: Map<string, ts.Expression>, seen = new Set<string>()): Root {
  expression = unwrap(expression);
  if (isEnvRead(expression)) return "env";
  if (isFallback(expression)) {
    if (!isEnvRead(expression.left)) return "other";
    const fallback = pathRoot(expression.right, bindings, seen);
    return fallback === "temp" || fallback === "env-temp" ? "env-temp" : "other";
  }
  if (ts.isIdentifier(expression)) {
    const init = bindings.get(expression.text);
    if (!init || seen.has(expression.text)) return "other";
    seen.add(expression.text);
    return pathRoot(init, bindings, seen);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const roots = new Set(expression.elements.map((e) => pathRoot(e, bindings, new Set(seen))));
    return roots.size === 1 ? [...roots][0]! : "other";
  }
  if (ts.isTemplateExpression(expression) && expression.head.text === "") {
    return pathRoot(expression.templateSpans[0]!.expression, bindings, seen);
  }
  if (ts.isCallExpression(expression)) {
    const name = calleeName(expression);
    if (name === "tmpdir") return "temp";
    if (PATH_BUILDERS.has(name ?? "") && expression.arguments[0]) return pathRoot(expression.arguments[0], bindings, seen);
  }
  return "other";
}

/** `if (X) mkdirSync(X, ...)` — the env var named a dir, so creating it is the operator's request. */
function guardedBy(node: ts.Node, identifier: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isIfStatement(parent) && ts.isIdentifier(unwrap(parent.expression)) && (unwrap(parent.expression) as ts.Identifier).text === identifier) {
      return true;
    }
  }
  return false;
}

function scanSuite({ file, source }: Suite): { findings: string[]; ports: PortDecl[] } {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = moduleBindings(sourceFile);
  const findings: string[] = [];
  const ports: PortDecl[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const at = (node: ts.Node): string => `${file}:${lineOf(node)}`;

  forEachNode(sourceFile, (node) => {
    if (isFallback(node)) {
      const root = literalRoot(node.right, bindings);
      if (root !== undefined && TASK_PATH.test(root)) {
        findings.push(
          `${at(node)}: \`${node.getText(sourceFile)}\` defaults to the container path ${root} — EACCES on CI and every host; fall back to mkdtempSync(join(tmpdir(), "<prefix>-")) instead`
        );
      }
    }
    if (ts.isCallExpression(node) && FS_WRITERS.has(calleeName(node) ?? "") && node.arguments[0]) {
      const root = literalRoot(node.arguments[0], bindings);
      if (root !== undefined && TASK_PATH.test(root)) {
        findings.push(`${at(node)}: ${calleeName(node)}(${node.arguments[0].getText(sourceFile)}) writes under the container path ${root} — EACCES on CI and every host`);
      }
    }
  });

  forEachModuleScopeNode(sourceFile, (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === "mkdirSync" && node.arguments[0]) {
      const arg = unwrap(node.arguments[0]);
      const root = pathRoot(arg, bindings);
      const envGuarded = root === "env" && ts.isIdentifier(arg) && guardedBy(node, arg.text);
      if (root !== "temp" && root !== "env-temp" && !envGuarded) {
        findings.push(
          `${at(node)}: module-scope mkdirSync(${node.arguments[0].getText(sourceFile)}) runs on import and is not rooted in a temp dir or the env override — if it throws, every test in the file vanishes; use process.env.<NAME>_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "<prefix>-"))`
        );
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && PORT_NAME.test(node.name.text) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isNumericLiteral(init)) ports.push({ file, line: lineOf(node), name: node.name.text, value: Number(init.text) });
    }
  });

  return { findings, ports };
}

function portCollisions(ports: PortDecl[]): string[] {
  const byValue = new Map<number, PortDecl[]>();
  for (const port of ports) byValue.set(port.value, [...(byValue.get(port.value) ?? []), port]);
  return [...byValue]
    .filter(([, decls]) => new Set(decls.map((d) => d.file)).size > 1)
    .map(
      ([value, decls]) =>
        `fixture port ${value} is declared by more than one browser suite — ${decls.map((d) => `${d.file}:${d.line} (${d.name})`).join(", ")}; suites run concurrently, so pick an unused port`
    );
}

function guardTier(suites: Suite[]): { findings: string[]; ports: PortDecl[] } {
  const scanned = suites.map(scanSuite);
  const ports = scanned.flatMap((s) => s.ports);
  return { findings: [...scanned.flatMap((s) => s.findings), ...portCollisions(ports)], ports };
}

const fixture = (name: string, source: string): Suite => ({ file: join(TIER, name), source });

test("FG-839: every dashboard/browser-tests suite passes the content guard", () => {
  const suites = tierSuites().map((name) => fixture(name, tierSource(name)));
  assert.ok(suites.length > 0, `no suites found under ${TIER}`);
  const { findings, ports } = guardTier(suites);
  assert.ok(ports.length > 1, "the guard found no fixture PORT constants — the port rule would be vacuous");
  assert.deepEqual(findings, [], `browser-tier content guard (src/util/fg839-browser-tier-content-guard.test.ts):\n${findings.join("\n")}`);
});

test("FG-839 (a): a `/task/` default on ?? or || is caught with file and line (the FG-832 shape)", () => {
  const { findings } = guardTier([
    fixture(
      "fg832-shape.test.ts",
      `import { mkdirSync } from "node:fs";\nconst SHOTS = process.env.FG832_SCREENSHOT_DIR ?? "/task/screenshots";\nmkdirSync(SHOTS, { recursive: true });\n`
    ),
    fixture("or-shape.test.ts", `const OUT = process.env.OUT_DIR || join("/task/out", "shots");\n`),
    fixture("template-shape.test.ts", "\n\nconst SHOTS = process.env.X_SCREENSHOT_DIR ?? `/task/screenshots`;\n"),
  ]);
  const file = (name: string, line: number) => `${join(TIER, name)}:${line}: `;
  assert.ok(findings.some((f) => f.startsWith(file("fg832-shape.test.ts", 2)) && f.includes("/task/screenshots")), findings.join("\n"));
  assert.ok(findings.some((f) => f.startsWith(file("fg832-shape.test.ts", 3)) && f.includes("module-scope mkdirSync(SHOTS)")), findings.join("\n"));
  assert.ok(findings.some((f) => f.startsWith(file("or-shape.test.ts", 1)) && f.includes("/task/out")), findings.join("\n"));
  assert.ok(findings.some((f) => f.startsWith(file("template-shape.test.ts", 3))), findings.join("\n"));
});

test("FG-839 (a): a `/task/` path passed to mkdirSync or writeFileSync is caught, even inside a hook", () => {
  const { findings } = guardTier([
    fixture("write.test.ts", `writeFileSync("/task/result.json", "{}");\n`),
    fixture("hook.test.ts", `before(() => {\n  mkdirSync("/task/screenshots", { recursive: true });\n});\n`),
  ]);
  assert.ok(findings.some((f) => f.startsWith(`${join(TIER, "write.test.ts")}:1: writeFileSync`)), findings.join("\n"));
  assert.ok(findings.some((f) => f.startsWith(`${join(TIER, "hook.test.ts")}:2: mkdirSync`)), findings.join("\n"));
});

test("FG-839 (b): a module-scope mkdirSync on a literal, an unguarded env var, or a non-temp root is caught", () => {
  const { findings } = guardTier([
    fixture("literal.test.ts", `import { mkdirSync } from "node:fs";\nmkdirSync("/var/forge-shots", { recursive: true });\n`),
    fixture("bound-literal.test.ts", `const SHOTS = "/tmp/fixed-shots";\nmkdirSync(SHOTS, { recursive: true });\n`),
    fixture("env-only.test.ts", `const SHOTS = process.env.X_SCREENSHOT_DIR;\nmkdirSync(SHOTS!, { recursive: true });\n`),
    fixture("env-literal.test.ts", `const SHOTS = process.env.X_SCREENSHOT_DIR ?? "shots";\nmkdirSync(SHOTS, { recursive: true });\n`),
    fixture("homedir.test.ts", `mkdirSync(join(homedir(), ".forge-shots"), { recursive: true });\n`),
    fixture("loop.test.ts", `const home = mkdtempSync(join(tmpdir(), "x-"));\nfor (const dir of [home, "/srv/shots"]) {\n  mkdirSync(dir);\n}\n`),
  ]);
  for (const [name, line] of [
    ["literal.test.ts", 2],
    ["bound-literal.test.ts", 2],
    ["env-only.test.ts", 2],
    ["env-literal.test.ts", 2],
    ["homedir.test.ts", 1],
    ["loop.test.ts", 3],
  ] as const) {
    assert.ok(
      findings.some((f) => f.startsWith(`${join(TIER, name)}:${line}: module-scope mkdirSync`)),
      `expected a module-scope mkdirSync finding at ${name}:${line}:\n${findings.join("\n")}`
    );
  }
});

test("FG-839 (c): two suites declaring the same fixture PORT value are caught, naming both", () => {
  const { findings } = guardTier([
    fixture("one.test.ts", `import { test } from "node:test";\nconst PORT = 18836;\n`),
    fixture("two.test.ts", `const TEST_PORT = 18836;\n`),
    fixture("three.test.ts", `const PORT = 18837;\n`),
  ]);
  assert.equal(findings.length, 1, findings.join("\n"));
  const [collision = ""] = findings;
  assert.match(collision, /fixture port 18836/);
  assert.ok(collision.includes(`${join(TIER, "one.test.ts")}:2 (PORT)`), collision);
  assert.ok(collision.includes(`${join(TIER, "two.test.ts")}:1 (TEST_PORT)`), collision);
  assert.ok(!collision.includes("three.test.ts"), collision);
});

test("FG-839: the accepted shapes pass", () => {
  const { findings } = guardTier([
    fixture(
      "canonical.test.ts",
      `const SHOTS = process.env.FG839_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg839-screenshots-"));\nmkdirSync(SHOTS, { recursive: true });\nconst PORT = 18901;\n`
    ),
    fixture(
      "tmp-join.test.ts",
      `const SHOTS = process.env.FG746_SCREENSHOT_DIR ?? join(tmpdir(), "fg746-screenshots");\nmkdirSync(SHOTS, { recursive: true });\n`
    ),
    fixture(
      "temp-home.test.ts",
      `const home = realpathSync(mkdtempSync(join(tmpdir(), "forge-x-")));\nconst forgeHome = join(home, ".forge");\nmkdirSync(forgeHome, { recursive: true });\nmkdirSync(\`\${home}/checkouts\`);\nfor (const dir of [forgeHome, join(home, "b")]) mkdirSync(dir);\nconst PORT = 18902;\n`
    ),
    fixture(
      "guarded-env.test.ts",
      `const SHOT_DIR = process.env.X_SHOT_DIR;\nif (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });\nbefore(() => { mkdirSync(process.env.Y as string); });\n`
    ),
    fixture("api-path.test.ts", `const url = BASE + "/api/task/" + (id ?? "task-1");\n`),
  ]);
  assert.deepEqual(findings, []);
});
