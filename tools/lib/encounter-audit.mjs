#!/usr/bin/env node
/**
 * encounter-audit.mjs — deterministic half of reader clarity.
 *
 * Reads reader-contract.json, verifies the declared copy sources exist, then
 * inspects rendered HTML/Markdown/JSON rather than guessing from source names.
 * Explicit deny terms and missing source roots BLOCK. Density, opaque tokens,
 * acronyms, and unavailable rendered output WARN for human/agent review.
 * Dependency-free and safe to run in CI.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENCOUNTER_AUDIT_VERSION = 2;
const CONTRACT_NAME = 'reader-contract.json';
const MANUAL_REVIEW_VERSION = 1;
const PLAINNESS = new Set(['lay', 'practitioner', 'specialist']);
const SCANNABLE = new Set(['.html', '.htm', '.md', '.mdx', '.txt', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.astro', '.svelte-kit', '.next', '.wrangler']);
const COMMON_ACRONYMS = new Set(['API', 'CSS', 'FAQ', 'HTML', 'HTTP', 'HTTPS', 'ID', 'PDF', 'RSS', 'UI', 'URL', 'UX']);
const ROMAN_NUMERAL = /^(?=[IVXLCDM]+$)M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

const read = (p) => fs.readFile(p, 'utf8').then((s) => s, () => null);
const exists = (p) => fs.access(p).then(() => true, () => false);

function finding(severity, code, surface, file, message, remediation) {
  return { severity, code, surface, file, message, ...(remediation ? { remediation } : {}) };
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanSegment(text) {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

export function htmlSegments(raw) {
  if (!raw) return [];
  const attrs = [];
  for (const m of raw.matchAll(/\b(?:aria-label|title|placeholder|alt)\s*=\s*(["'])(.*?)\1/gis)) {
    const value = cleanSegment(m[2]);
    if (value) attrs.push(value);
  }
  const body = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|code|pre|kbd|samp)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(?:p|div|li|section|article|header|footer|nav|main|h[1-6]|button|a|label|option|summary|td|th)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return [...body.split(/\n+/).map(cleanSegment).filter(Boolean), ...attrs];
}

export function markdownSegments(raw) {
  if (!raw) return [];
  return raw
    .replace(/^---\n[\s\S]*?\n---\n/, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/\n\s*\n|\n(?=#{1,6}\s|[-*]\s|\d+\.\s)/)
    .map((s) => cleanSegment(s.replace(/^#{1,6}\s+|^[-*]\s+|^\d+\.\s+/gm, '')))
    .filter(Boolean);
}

export function jsonSegments(raw, includeKeys = []) {
  if (!raw) return [];
  let value;
  try { value = JSON.parse(raw); } catch { return []; }
  const out = [];
  const collect = (v) => {
    if (typeof v === 'string') {
      // JSON copy often preserves reader-visible structure with newlines (social
      // captions, notifications, generated summaries). Keep those encounter
      // boundaries instead of collapsing a scannable list into one dense block.
      out.push(...v.split(/\r?\n+/).map(cleanSegment).filter(Boolean));
    } else if (Array.isArray(v)) {
      for (const item of v) collect(item);
    } else if (v && typeof v === 'object') {
      for (const item of Object.values(v)) collect(item);
    }
  };
  const keys = new Set(includeKeys.map((key) => String(key).toLowerCase()));
  if (keys.size === 0) collect(value);
  else {
    const seek = (v) => {
      if (Array.isArray(v)) {
        for (const item of v) seek(item);
      } else if (v && typeof v === 'object') {
        for (const [key, item] of Object.entries(v)) {
          if (keys.has(key.toLowerCase())) collect(item);
          else seek(item);
        }
      }
    };
    seek(value);
  }
  return out;
}

function segmentsFor(file, raw, includeJsonKeys = []) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return htmlSegments(raw);
  if (ext === '.md' || ext === '.mdx') return markdownSegments(raw);
  if (ext === '.json') return jsonSegments(raw, includeJsonKeys);
  return raw.split(/\n+/).map(cleanSegment).filter(Boolean);
}

async function walkFiles(root, acc = []) {
  let stat;
  try { stat = await fs.stat(root); } catch { return acc; }
  if (stat.isFile()) {
    if (SCANNABLE.has(path.extname(root).toLowerCase())) acc.push(root);
    return acc;
  }
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(full, acc);
    else if (SCANNABLE.has(path.extname(entry.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

async function walkSourceFiles(root, acc = []) {
  let stat;
  try { stat = await fs.stat(root); } catch { return acc; }
  if (stat.isFile()) {
    acc.push(root);
    return acc;
  }
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walkSourceFiles(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

function safeRepoPath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) return null;
  const full = path.resolve(root, relativePath);
  const rel = path.relative(root, full);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return full;
}

export async function digestSourceRoots(root, sourceRoots = []) {
  const files = [];
  for (const sourceRoot of sourceRoots) await walkSourceFiles(path.resolve(root, sourceRoot), files);
  const unique = [...new Set(files)].sort();
  const hash = createHash('sha256');
  for (const file of unique) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const contents = await fs.readFile(file);
    hash.update(relative);
    hash.update('\0');
    hash.update(String(contents.length));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return { sourceDigest: `sha256:${hash.digest('hex')}`, sourceFiles: unique.length };
}

function validateAudience(value, label, findings) {
  if (!value || typeof value !== 'object') {
    findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label} must be an object`));
    return;
  }
  for (const key of ['reader', 'job']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.${key} must be a non-empty string`));
    }
  }
  if (!PLAINNESS.has(value.plainness)) {
    findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.plainness must be lay, practitioner, or specialist`));
  }
  for (const key of ['assumedKnowledge', 'precisionLocks']) {
    if (!Array.isArray(value[key])) {
      findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.${key} must be an array`));
    } else if (value[key].some((item) => typeof item !== 'string')) {
      findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.${key} entries must be strings`));
    }
  }
}

export function validateContract(contract) {
  const findings = [];
  if (!contract || typeof contract !== 'object') return [finding('BLOCK', 'invalid-contract', 'contract', CONTRACT_NAME, 'contract must be a JSON object')];
  if (contract.version !== 1) findings.push(finding('BLOCK', 'invalid-contract', 'contract', CONTRACT_NAME, 'version must be 1'));
  if (typeof contract.project !== 'string' || !contract.project.trim()) findings.push(finding('BLOCK', 'invalid-contract', 'contract', CONTRACT_NAME, 'project must be a non-empty string'));
  validateAudience(contract.defaults, 'defaults', findings);
  if (!Array.isArray(contract.surfaces) || contract.surfaces.length === 0) {
    findings.push(finding('BLOCK', 'invalid-contract', 'contract', CONTRACT_NAME, 'surfaces must contain at least one surface'));
    return findings;
  }
  contract.surfaces.forEach((surface, index) => {
    const label = surface && surface.name ? surface.name : `surfaces[${index}]`;
    if (!surface || typeof surface !== 'object') {
      findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label} must be an object`));
      return;
    }
    if (typeof surface.name !== 'string' || !surface.name.trim()) findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.name must be a non-empty string`));
    for (const key of ['renderedRoots', 'sourceRoots', 'allowTerms', 'denyTerms']) {
      if (!Array.isArray(surface[key])) findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.${key} must be an array`));
    }
    for (const key of ['excludeRoots', 'includeJsonKeys']) {
      if (surface[key] !== undefined && !Array.isArray(surface[key])) findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.${key} must be an array when present`));
    }
    if (surface.manualReview !== undefined) {
      if (!surface.manualReview || typeof surface.manualReview !== 'object' || Array.isArray(surface.manualReview)) {
        findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.manualReview must be an object when present`));
      } else if (!safeRepoPath('/', surface.manualReview.evidencePath)) {
        findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.manualReview.evidencePath must be a non-empty repository-relative path`));
      }
    }
    if (Array.isArray(surface.sourceRoots) && surface.sourceRoots.length === 0) {
      findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.sourceRoots must name at least one copy source`));
    }
    for (const key of ['renderedRoots', 'sourceRoots', 'allowTerms', 'excludeRoots', 'includeJsonKeys']) {
      if (Array.isArray(surface[key]) && surface[key].some((item) => typeof item !== 'string' || !item.trim())) {
        findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.${key} entries must be non-empty strings`));
      }
    }
    if (surface.maxWordsPerText !== undefined && (!Number.isInteger(surface.maxWordsPerText) || surface.maxWordsPerText < 1)) {
      findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.maxWordsPerText must be a positive integer`));
    }
    const merged = { ...contract.defaults, ...surface };
    validateAudience(merged, label, findings);
    for (const term of surface.denyTerms || []) {
      if (!term || typeof term.term !== 'string' || !term.term.trim() || typeof term.reason !== 'string' || !term.reason.trim()) {
        findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.denyTerms entries need non-empty term and reason`));
      } else if (term.replacement !== undefined && typeof term.replacement !== 'string') {
        findings.push(finding('BLOCK', 'invalid-contract', label, CONTRACT_NAME, `${label}.denyTerms replacement must be a string when present`));
      }
    }
  });
  return findings;
}

async function verifyManualReview({ root, surface, findings }) {
  const name = surface.name || 'unnamed surface';
  const evidencePath = surface.manualReview?.evidencePath;
  if (!evidencePath) {
    findings.push(finding('WARN', 'manual-encounter-required', name, CONTRACT_NAME, 'no rendered root or current manual-review receipt is declared; this surface needs a browser or artifact walk', 'Walk the real encounter, declare manualReview.evidencePath, then record the reviewed source snapshot.'));
    return false;
  }
  const full = safeRepoPath(root, evidencePath);
  if (!full) return false;
  const raw = await read(full);
  if (raw == null) {
    findings.push(finding('WARN', 'manual-review-missing', name, evidencePath, 'manual-review evidence is missing', `Review the live encounter, then run encounter-audit.mjs --record-manual=${JSON.stringify(name)}.`));
    return false;
  }
  let evidence;
  try { evidence = JSON.parse(raw); }
  catch (error) {
    findings.push(finding('WARN', 'manual-review-invalid', name, evidencePath, `manual-review evidence is not valid JSON: ${error.message}`));
    return false;
  }
  const invalid = [];
  if (evidence.version !== MANUAL_REVIEW_VERSION) invalid.push(`version must be ${MANUAL_REVIEW_VERSION}`);
  if (evidence.surface !== name) invalid.push(`surface must be ${JSON.stringify(name)}`);
  if (typeof evidence.reviewedAt !== 'string' || Number.isNaN(Date.parse(evidence.reviewedAt))) invalid.push('reviewedAt must be an ISO date-time');
  if (typeof evidence.reviewedBy !== 'string' || !evidence.reviewedBy.trim()) invalid.push('reviewedBy must be a non-empty string');
  if (typeof evidence.method !== 'string' || !evidence.method.trim()) invalid.push('method must be a non-empty string');
  if (typeof evidence.sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(evidence.sourceDigest)) invalid.push('sourceDigest must be a sha256 digest');
  if (!Number.isInteger(evidence.sourceFiles) || evidence.sourceFiles < 1) invalid.push('sourceFiles must be a positive integer');
  if (evidence.scope !== undefined && (!Array.isArray(evidence.scope) || evidence.scope.some((item) => typeof item !== 'string' || !item.trim()))) invalid.push('scope entries must be non-empty strings');
  if (invalid.length) {
    findings.push(finding('WARN', 'manual-review-invalid', name, evidencePath, invalid.join('; '), 'Record the manual review again after completing the encounter walk.'));
    return false;
  }
  const current = await digestSourceRoots(root, surface.sourceRoots || []);
  if (evidence.sourceDigest !== current.sourceDigest || evidence.sourceFiles !== current.sourceFiles) {
    findings.push(finding('WARN', 'manual-review-stale', name, evidencePath, `the reviewed source snapshot changed (${evidence.sourceFiles} → ${current.sourceFiles} file(s))`, 'Walk the changed encounter and record a new manual-review receipt.'));
    return false;
  }
  return true;
}

export async function recordManualReview({ targetDir, contractPath = CONTRACT_NAME, surfaceName, reviewedBy, method, scope = [], reviewedAt } = {}) {
  const root = path.resolve(targetDir || '.');
  const raw = await read(path.resolve(root, contractPath));
  if (raw == null) throw new Error(`${contractPath} is missing`);
  const contract = JSON.parse(raw);
  const contractFindings = validateContract(contract);
  if (contractFindings.some((item) => item.severity === 'BLOCK')) throw new Error(`reader contract is invalid: ${contractFindings.map((item) => item.message).join('; ')}`);
  const surface = (contract.surfaces || []).find((item) => item?.name === surfaceName);
  if (!surface) throw new Error(`surface not found: ${surfaceName}`);
  if ((surface.renderedRoots || []).length > 0) throw new Error(`surface ${JSON.stringify(surfaceName)} has renderedRoots; audit the rendered output instead of recording a manual receipt`);
  if (!reviewedBy || !String(reviewedBy).trim()) throw new Error('--reviewed-by is required');
  if (!method || !String(method).trim()) throw new Error('--method is required');
  const evidencePath = surface.manualReview?.evidencePath;
  const full = safeRepoPath(root, evidencePath);
  if (!full) throw new Error(`surface ${JSON.stringify(surfaceName)} needs a safe manualReview.evidencePath`);
  for (const sourceRoot of surface.sourceRoots || []) {
    if (!(await exists(path.resolve(root, sourceRoot)))) throw new Error(`declared copy source does not exist: ${sourceRoot}`);
  }
  const digest = await digestSourceRoots(root, surface.sourceRoots || []);
  if (digest.sourceFiles < 1) throw new Error(`surface ${JSON.stringify(surfaceName)} has no source files to fingerprint`);
  const evidence = {
    version: MANUAL_REVIEW_VERSION,
    surface: surfaceName,
    reviewedAt: reviewedAt || new Date().toISOString(),
    reviewedBy: String(reviewedBy).trim(),
    method: String(method).trim(),
    sourceDigest: digest.sourceDigest,
    sourceFiles: digest.sourceFiles,
    ...(scope.length ? { scope } : {}),
  };
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { evidencePath, evidence };
}

function termPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(term) ? '\\b' : '';
  const right = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, 'i');
}

function words(text) {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

function opaqueTokens(text) {
  const out = new Set();
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/\b[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/\bADR-\d{3,}\b/g)) out.add(m[0]);
  return [...out];
}

function undefinedAcronyms(text) {
  const found = new Set();
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b/g)) {
    const acronym = m[0];
    if (COMMON_ACRONYMS.has(acronym)) continue;
    if (ROMAN_NUMERAL.test(acronym)) continue;
    const around = text.slice(Math.max(0, m.index - 90), m.index + acronym.length + 90);
    if (new RegExp(`(?:\\([^)]*\\b${acronym}\\b[^)]*\\)|\\b${acronym}\\b\\s*\\([^)]{3,}\\))`).test(around)) continue;
    found.add(acronym);
  }
  return [...found];
}

function isAllCapsLabel(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 2 && letters === letters.toUpperCase() && words(text) <= 10;
}

export async function auditReaderContract({ targetDir, contractPath = CONTRACT_NAME, surfaceName } = {}) {
  const startedAt = Date.now();
  const root = path.resolve(targetDir || '.');
  const fullContractPath = path.resolve(root, contractPath);
  const contractRaw = await read(fullContractPath);
  if (contractRaw == null) {
    return {
      status: 'WARN',
      findings: [finding('WARN', 'missing-contract', 'contract', path.relative(root, fullContractPath), 'reader-contract.json is missing', 'Add the reader, job, assumed knowledge, precision locks, rendered roots, and copy sources.')],
      metadata: { reviewer: 'encounter-audit-reviewer', targetSummary: 'no reader contract', durationMs: Date.now() - startedAt, filesScanned: 0 },
    };
  }

  let contract;
  try { contract = JSON.parse(contractRaw); }
  catch (error) {
    return {
      status: 'BLOCKED',
      findings: [finding('BLOCK', 'invalid-json', 'contract', path.relative(root, fullContractPath), `reader contract is not valid JSON: ${error.message}`)],
      metadata: { reviewer: 'encounter-audit-reviewer', targetSummary: 'invalid reader contract', durationMs: Date.now() - startedAt, filesScanned: 0 },
    };
  }

  const findings = validateContract(contract);
  let filesScanned = 0;
  let manualReviewsVerified = 0;
  const seenFiles = new Set();
  const surfaces = (contract.surfaces || []).filter((surface) => !surfaceName || surface?.name === surfaceName);
  if (surfaceName && surfaces.length === 0) {
    findings.push(finding('BLOCK', 'unknown-surface', surfaceName, CONTRACT_NAME, `reader contract has no surface named ${JSON.stringify(surfaceName)}`));
  }

  for (const rawSurface of surfaces) {
    if (!rawSurface || typeof rawSurface !== 'object') continue;
    const surface = { ...contract.defaults, ...rawSurface };
    const name = surface.name || 'unnamed surface';
    const allow = new Set([...(surface.allowTerms || []), ...(surface.precisionLocks || [])].map((s) => String(s).toLowerCase()));

    for (const sourceRoot of surface.sourceRoots || []) {
      const full = path.resolve(root, sourceRoot);
      if (!(await exists(full))) {
        findings.push(finding('BLOCK', 'missing-copy-source', name, sourceRoot, `declared copy source does not exist: ${sourceRoot}`, 'Correct the source map or restore the owning source before approving copy.'));
      }
    }

    if (!surface.renderedRoots || surface.renderedRoots.length === 0) {
      if (await verifyManualReview({ root, surface, findings })) manualReviewsVerified += 1;
      continue;
    }

    let surfaceFiles = [];
    for (const renderedRoot of surface.renderedRoots) {
      const full = path.resolve(root, renderedRoot);
      if (!(await exists(full))) {
        findings.push(finding('WARN', 'render-missing', name, renderedRoot, `rendered root is unavailable: ${renderedRoot}`, 'Build or regenerate the surface before calling the encounter audit complete.'));
        continue;
      }
      surfaceFiles.push(...await walkFiles(full));
    }
    const excluded = (surface.excludeRoots || []).map((rootPath) => path.resolve(root, rootPath));
    if (excluded.length) {
      surfaceFiles = surfaceFiles.filter((file) => !excluded.some((excludedRoot) => file === excludedRoot || file.startsWith(`${excludedRoot}${path.sep}`)));
    }
    surfaceFiles = [...new Set(surfaceFiles)].sort();
    if (surfaceFiles.length === 0) {
      findings.push(finding('WARN', 'render-empty', name, CONTRACT_NAME, 'rendered roots contain no scannable HTML, Markdown, text, or JSON'));
      continue;
    }

    for (const file of surfaceFiles) {
      if (seenFiles.has(`${name}:${file}`)) continue;
      seenFiles.add(`${name}:${file}`);
      filesScanned += 1;
      const raw = await read(file);
      if (raw == null) continue;
      const rel = path.relative(root, file);
      const segments = segmentsFor(file, raw, surface.includeJsonKeys || []);
      const text = segments.join(' ');

      for (const denied of surface.denyTerms || []) {
        if (!denied || !denied.term || !termPattern(denied.term).test(text)) continue;
        findings.push(finding('BLOCK', 'denied-term', name, rel, `“${denied.term}” reaches the rendered encounter: ${denied.reason}`, denied.replacement ? `Replace it with “${denied.replacement}” at the owning source.` : 'Rewrite it at the owning source.'));
      }

      const threshold = Number.isInteger(surface.maxWordsPerText)
        ? surface.maxWordsPerText
        : surface.plainness === 'lay' ? 45 : surface.plainness === 'practitioner' ? 70 : 110;
      const dense = segments.filter((segment) => words(segment) > threshold).slice(0, 4);
      if (dense.length) {
        findings.push(finding('WARN', 'dense-copy', name, rel, `${dense.length} text block(s) exceed the ${threshold}-word review threshold`, 'Check whether each block can lead with its conclusion or split into one idea at a time.'));
      }

      if (surface.plainness !== 'specialist') {
        const opaque = opaqueTokens(text).filter((term) => !allow.has(term.toLowerCase())).slice(0, 8);
        if (opaque.length) findings.push(finding('WARN', 'opaque-token', name, rel, `internal-looking tokens reach the reader: ${opaque.join(', ')}`, 'Translate them, define them nearby, or add an intentional precision lock.'));
      }

      if (surface.plainness === 'lay') {
        const acronyms = [...new Set(segments
          .filter((segment) => !isAllCapsLabel(segment))
          .flatMap((segment) => undefinedAcronyms(segment)))]
          .filter((term) => !allow.has(term.toLowerCase()))
          .slice(0, 8);
        if (acronyms.length) findings.push(finding('WARN', 'undefined-acronym', name, rel, `possible undefined acronyms: ${acronyms.join(', ')}`, 'Define each on first use or add an intentional allowed term.'));
      }
    }
  }

  const status = findings.some((f) => f.severity === 'BLOCK') ? 'BLOCKED'
    : findings.some((f) => f.severity === 'WARN') ? 'WARN' : 'PASS';
  return {
    status,
    findings,
    metadata: {
      reviewer: 'encounter-audit-reviewer',
      targetSummary: `${contract.project || 'project'} — ${filesScanned} rendered file(s), ${findings.length} finding(s)`,
      durationMs: Date.now() - startedAt,
      filesScanned,
      surfaces: surfaces.length,
      manualReviewsVerified,
    },
  };
}

function printResult(result) {
  console.log(`encounter audit: ${result.status}`);
  console.log(result.metadata.targetSummary);
  for (const f of result.findings) {
    console.log(`${f.severity} ${f.code} [${f.surface}] ${f.file}: ${f.message}`);
    if (f.remediation) console.log(`  fix: ${f.remediation}`);
  }
}

async function selfTest() {
  const os = await import('node:os');
  const { mkdtemp, mkdir, writeFile } = fs;
  const root = await mkdtemp(path.join(os.tmpdir(), 'bp-encounter-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'src', 'page.md'), '# source\n');
  const base = {
    version: 1,
    project: 'test',
    defaults: { reader: 'a visitor', job: 'understand the page', assumedKnowledge: [], plainness: 'lay', precisionLocks: [] },
    surfaces: [{ name: 'page', renderedRoots: ['dist'], sourceRoots: ['src'], excludeRoots: ['dist/internal'], includeJsonKeys: ['caption'], allowTerms: [], denyTerms: [{ term: 'substrate', reason: 'internal vocabulary', replacement: 'saved data' }] }],
  };
  await writeFile(path.join(root, CONTRACT_NAME), `${JSON.stringify(base, null, 2)}\n`);
  await mkdir(path.join(root, 'dist', 'internal'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'internal', 'notes.html'), '<p>The substrate is internal.</p>');
  await writeFile(path.join(root, 'dist', 'payload.json'), JSON.stringify({ caption: 'Your saved data is ready.', internalNote: 'substrate' }));
  await writeFile(path.join(root, 'dist', 'index.html'), '<main><p>The substrate is ready.</p></main>');
  const blocked = await auditReaderContract({ targetDir: root });
  if (blocked.status !== 'BLOCKED' || !blocked.findings.some((f) => f.code === 'denied-term')) throw new Error('deny term did not block');
  await writeFile(path.join(root, 'dist', 'index.html'), '<main><nav aria-label="Chapter IV"><a>RSS</a></nav><p>Your saved data is ready.</p></main>');
  const captionLine = Array.from({ length: 30 }, (_, index) => `word${index + 1}`).join(' ');
  await writeFile(path.join(root, 'dist', 'multiline.json'), JSON.stringify({ caption: `${captionLine}\n${captionLine}` }));
  const passed = await auditReaderContract({ targetDir: root });
  if (passed.status !== 'PASS') throw new Error(`clean fixture did not pass: ${JSON.stringify(passed.findings)}`);
  const manual = {
    ...base,
    surfaces: [{ ...base.surfaces[0], renderedRoots: [], manualReview: { evidencePath: 'reader-audits/page.json' } }],
  };
  await writeFile(path.join(root, CONTRACT_NAME), `${JSON.stringify(manual, null, 2)}\n`);
  const missingReceipt = await auditReaderContract({ targetDir: root });
  if (missingReceipt.status !== 'WARN' || !missingReceipt.findings.some((item) => item.code === 'manual-review-missing')) throw new Error('missing manual-review receipt did not warn');
  await recordManualReview({ targetDir: root, surfaceName: 'page', reviewedBy: 'self-test', method: 'fixture walk', scope: ['fixture'], reviewedAt: '2026-01-01T00:00:00.000Z' });
  const currentReceipt = await auditReaderContract({ targetDir: root });
  if (currentReceipt.status !== 'PASS' || currentReceipt.metadata.manualReviewsVerified !== 1) throw new Error(`current manual-review receipt did not pass: ${JSON.stringify(currentReceipt.findings)}`);
  await writeFile(path.join(root, 'src', 'page.md'), '# changed source\n');
  const staleReceipt = await auditReaderContract({ targetDir: root });
  if (staleReceipt.status !== 'WARN' || !staleReceipt.findings.some((item) => item.code === 'manual-review-stale')) throw new Error('stale manual-review receipt did not warn');
  console.log('encounter-audit self-test: PASS (contract, rendered audit, manual receipt, stale-source invalidation)');
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  if (process.argv.includes('--selftest') || process.argv.includes('--self-test')) {
    await selfTest();
  } else {
    const value = (name, fallback) => {
      const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
      return arg ? arg.slice(name.length + 3) : fallback;
    };
    const targetDir = value('root', '.');
    const contractPath = value('contract', CONTRACT_NAME);
    const recordSurface = value('record-manual', null);
    if (recordSurface) {
      const scope = value('scope', '').split('|').map((item) => item.trim()).filter(Boolean);
      const receipt = await recordManualReview({
        targetDir,
        contractPath,
        surfaceName: recordSurface,
        reviewedBy: value('reviewed-by', ''),
        method: value('method', ''),
        scope,
      });
      console.log(`manual review recorded: ${receipt.evidencePath}`);
      console.log(`${receipt.evidence.sourceDigest} (${receipt.evidence.sourceFiles} source file(s))`);
    } else {
      const result = await auditReaderContract({ targetDir, contractPath, surfaceName: value('surface', null) });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else printResult(result);
      if (result.status === 'BLOCKED') process.exitCode = 2;
      else if (result.status === 'WARN' && process.argv.includes('--strict')) process.exitCode = 1;
    }
  }
}
