#!/usr/bin/env node
// Privacy scan: blocks personal data from being committed to this public repo.
//
// Checks every file (and optionally a commit message) for:
//   1. Private terms - names, places, hostnames, entity names - loaded from
//      `.private-terms` (local, git-ignored) or the PRIVATE_TERMS environment
//      variable (GitHub Actions secret). The list itself is never committed.
//   2. Leak patterns - private IP addresses, .local hostnames, email addresses,
//      Home Assistant tokens / JWTs, bearer tokens, private keys.
//
// Usage:
//   node scripts/privacy-scan.mjs --staged        scan files staged for commit
//   node scripts/privacy-scan.mjs --all           scan all tracked files
//   node scripts/privacy-scan.mjs --range A..B    scan files changed in a range
//   node scripts/privacy-scan.mjs --message FILE  scan a commit message file
//
// Exit code 1 if anything is found.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args[0] ?? "--staged";

// ---------- private terms ----------
function loadTerms() {
  let raw = process.env.PRIVATE_TERMS ?? "";
  if (existsSync(".private-terms")) raw += "\n" + readFileSync(".private-terms", "utf8");
  return raw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith("#"));
}

const terms = loadTerms();
const requireTerms = process.env.CI === "true" || existsSync(".private-terms-required");
if (terms.length === 0) {
  const msg = "privacy-scan: no private terms loaded (.private-terms file or PRIVATE_TERMS secret).";
  if (requireTerms) {
    console.error(msg + " Refusing to pass without them.");
    process.exit(1);
  }
  console.warn("WARNING: " + msg + " Only generic leak patterns will be checked.");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRes = terms.map((t) => ({
  label: "private term",
  // whole-word, case-insensitive; underscores/dashes count as word breaks so
  // entity names like media_player.<name>_speaker are caught too
  re: new RegExp(`(^|[^A-Za-z0-9])${escapeRe(t)}(?=$|[^A-Za-z0-9])`, "i"),
  secret: true,
}));

// ---------- generic leak patterns ----------
const patterns = [
  { label: "private IPv4 address", re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { label: ".local hostname", re: /\b(?!homeassistant\.local\b)[a-z0-9-]+\.local\b/i },
  {
    label: "email address",
    re: /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org)\b|users\.noreply\.github\.com\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  },
  { label: "JWT / Home Assistant token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { label: "bearer token", re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
];

// Files that legitimately mention the patterns (this scanner, its own tests).
const SKIP = new Set(["scripts/privacy-scan.mjs", "package-lock.json"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|wav|zip|gz)$/i;

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function filesAndContents() {
  if (mode === "--message") {
    const f = args[1];
    return [[`commit message`, readFileSync(f, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n")]];
  }
  let list;
  if (mode === "--all") list = git("ls-files").split("\n");
  else if (mode === "--range") list = git("diff", "--name-only", "--diff-filter=ACMR", args[1]).split("\n");
  else list = git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n");
  list = list.filter(Boolean).filter((f) => !SKIP.has(f) && !BINARY.test(f));
  return list.map((f) => {
    let content = "";
    try {
      content = mode === "--staged" ? git("show", `:${f}`) : readFileSync(f, "utf8");
    } catch {
      /* deleted / unreadable */
    }
    return [f, content];
  });
}

let problems = 0;
for (const [file, content] of filesAndContents()) {
  content.split("\n").forEach((line, i) => {
    for (const p of [...termRes, ...patterns]) {
      if (p.re.test(line)) {
        problems++;
        // Never print the private term itself - CI logs are public.
        const shown = p.secret ? "(matching text hidden)" : line.trim().slice(0, 120);
        console.error(`  ${file}:${i + 1}  ${p.label}  ${shown}`);
      }
    }
  });
}

if (problems) {
  console.error(`\nprivacy-scan: ${problems} problem(s) found. Move personal details into Home Assistant config, not the code.`);
  process.exit(1);
}
console.log(`privacy-scan: clean (${terms.length} private terms, ${patterns.length} leak patterns checked).`);
