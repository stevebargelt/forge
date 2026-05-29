#!/usr/bin/env node
// Spike for #176: prove a captured localStorage-based Supabase session, re-injected
// via CDP Page.addScriptToEvaluateOnNewDocument, flips an UNauthenticated browser
// context to authenticated. Control vs treatment experiment.
//
// Run from anywhere; resolves puppeteer-core from the browser-tools skill:
//   NODE_PATH="$HOME/.claude/skills/browser-tools/node_modules" node inject-spike.mjs <deep-url>
//
// Reuses the live Chrome already on :9222 as the capture source AND the browser we
// spin isolated incognito contexts inside.

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const DEEP_URL = process.argv[2] || "http://localhost:3000/device/6e57af4b-6980-4e61-8ffe-417656114c96";
const ORIGIN = new URL(DEEP_URL).origin;
const PROFILE_PATH = join(homedir(), ".forge", "auth", "spike-wnba.storage.json");

const log = (...a) => console.log(...a);
const section = (t) => log(`\n=== ${t} ===`);

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

async function readState(page) {
  return await page.evaluate(() => ({
    href: location.href,
    origin: location.origin,
    ls: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])),
  }));
}

// summarize whether a context looks authenticated: token present + not bounced to a login route
function verdict(state) {
  const tokenKey = Object.keys(state.ls).find((k) => k.endsWith("-auth-token"));
  const hasToken = !!tokenKey;
  const onLogin = /\/(login|signin|sign-in|auth)\b/i.test(state.href) || state.href === ORIGIN + "/";
  return { hasToken, tokenKey, onLogin, finalUrl: state.href };
}

try {
  // ---- PHASE 1: CAPTURE from the live authed tab ----
  section("CAPTURE");
  const pages = await browser.pages();
  const authedPage = pages.find((p) => p.url().startsWith(ORIGIN));
  if (!authedPage) throw new Error(`No open tab on ${ORIGIN} to capture from`);
  const captured = await readState(authedPage);
  log("captured from:", captured.href);
  log("localStorage keys:", Object.keys(captured.ls));

  const storageState = {
    cookies: [],
    origins: [
      {
        origin: ORIGIN,
        localStorage: Object.entries(captured.ls).map(([name, value]) => ({ name, value })),
      },
    ],
  };
  mkdirSync(join(homedir(), ".forge", "auth"), { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify(storageState, null, 2));
  chmodSync(PROFILE_PATH, 0o600);
  log("wrote storageState ->", PROFILE_PATH, "(mode 600)");

  // ---- PHASE 2: CONTROL — fresh incognito, NO injection ----
  section("CONTROL (no injection)");
  const ctrlCtx = await browser.createBrowserContext();
  const ctrlPage = await ctrlCtx.newPage();
  await ctrlPage.goto(DEEP_URL, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => log("nav note:", e.message));
  const ctrlState = await readState(ctrlPage);
  const ctrlVerdict = verdict(ctrlState);
  log("control verdict:", JSON.stringify(ctrlVerdict));
  await ctrlCtx.close();

  // ---- PHASE 3: TREATMENT — fresh incognito, inject localStorage before nav ----
  section("TREATMENT (inject via evaluateOnNewDocument)");
  const txCtx = await browser.createBrowserContext();
  const txPage = await txCtx.newPage();

  const lsForOrigin = storageState.origins.find((o) => o.origin === ORIGIN)?.localStorage ?? [];
  // CDP Page.addScriptToEvaluateOnNewDocument: fires at document-start for the matching
  // origin, BEFORE the app bundle reads the token.
  await txPage.evaluateOnNewDocument(
    (origin, entries) => {
      if (location.origin !== origin) return;
      try {
        for (const { name, value } of entries) localStorage.setItem(name, value);
      } catch (e) {
        /* localStorage may be unavailable on about:blank; ignore */
      }
    },
    ORIGIN,
    lsForOrigin,
  );

  await txPage.goto(DEEP_URL, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => log("nav note:", e.message));
  const txState = await readState(txPage);
  const txVerdict = verdict(txState);
  log("treatment verdict:", JSON.stringify(txVerdict));

  const shotPath = join(homedir(), ".forge", "auth", "spike-treatment.png");
  await txPage.screenshot({ path: shotPath });
  log("screenshot ->", shotPath);
  await txCtx.close();

  // ---- RESULT ----
  section("RESULT");
  const controlEnforces = ctrlVerdict.onLogin || !ctrlVerdict.hasToken;
  const treatmentAuthed = txVerdict.hasToken && !txVerdict.onLogin;
  log("control bounced/unauth :", controlEnforces);
  log("treatment authenticated:", treatmentAuthed);
  if (controlEnforces && treatmentAuthed) {
    log("\n✅ SPIKE PASS — CDP localStorage injection flips unauth → authed.");
  } else if (!controlEnforces) {
    log("\n⚠️  INCONCLUSIVE — control did not enforce auth (app may not gate this route).");
  } else {
    log("\n❌ SPIKE FAIL — injection did not authenticate the treatment context.");
  }
} finally {
  await browser.disconnect();
}
