/*
 * Copyright 2026 hotBrief contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { request } from 'undici';
import { loadConfig, resolveSource } from './config.js';
import { recentItems } from './db.js';
import { applyKeywords } from './filter.js';
import { filterUnpushed, markDigestPushed } from './dedup.js';
import { summarizeForDigest, summarizeTldr } from './summarize.js';
import { fetchMarkdown } from './fulltext.js';
import 'dotenv/config';

const SCT_ENDPOINT = (key) => `https://sctapi.ftqq.com/${key}.send`;
const SCT_DESP_LIMIT = 32_000;

/**
 * Render and push a daily digest covering items collected since the
 * previous digest window (or last 8h, whichever is shorter).
 */
export async function pushDigest(cfg) {
  const all = recentItems(8 * 60);
  const { kept } = applyKeywords(all, cfg.keywords);
  const fresh = filterUnpushed(kept);
  if (fresh.length === 0) {
    console.log('[push] digest: no fresh items, skipping');
    return;
  }

  const grouped = groupByCategory(cfg, fresh);
  const sections = [];

  for (const cat of cfg.categories) {
    const items = grouped.get(cat.id);
    if (!items || items.length === 0) continue;
    sections.push(`## ${cat.label}`);
    for (const item of items) {
      const summary = cfg.digest.enable_summary
        ? await summarizeForDigest(cfg, item)
        : null;
      sections.push(renderDigestItem(item, summary));
    }
    sections.push('');
  }

  const title = `📰 hotBrief 日报 · ${formatTime(new Date())}`;
  const body = sections.join('\n');
  const safe = enforceLimit(body);

  await sendToServerChan(cfg, title, safe);
  markDigestPushed(fresh);
  console.log(`[push] digest: sent ${fresh.length} items`);
}

/**
 * Render and push a single fulltext card for a major event or a whitelisted item.
 *
 * `cluster` may be either a Cluster object (from major.js) or a single item.
 */
export async function pushFulltext(cfg, target) {
  const lead = pickLeadItem(target);
  const platforms = collectPlatforms(target);

  let body = null;
  let tldr = null;

  try {
    body = await fetchMarkdown(cfg, lead.url, cfg.fulltext.max_chars);
  } catch (err) {
    console.warn(`[push] reader failed for ${lead.url}: ${err.message}`);
    if (cfg.fulltext.fallback === 'skip') {
      console.log('[push] fulltext: skip (per fallback policy)');
      return;
    }
  }

  if (body) {
    tldr = await summarizeTldr(cfg, lead, body);
  }

  const title = `🔥 hotBrief 重大热点 · ${formatTime(new Date())}`;
  const sections = [
    `## ${lead.title}`,
    '',
    platforms.length > 1 ? `**多平台共振**：${platforms.join(' · ')}` : `**来源**：${lead.source}`,
    '',
  ];
  if (tldr) sections.push(`**TLDR**：${tldr}`, '');
  sections.push('---', '');
  if (body) {
    sections.push(body);
  } else {
    sections.push('（fulltext unavailable; see original article）');
  }
  sections.push('', `🔗 完整原文：${lead.url}`);

  const safe = enforceLimit(sections.join('\n'));
  await sendToServerChan(cfg, title, safe);
  console.log(`[push] fulltext: sent "${lead.title}"`);
}

function renderDigestItem(item, summary) {
  const head = `### ${item.title} [${item.source}]`;
  const tail = `🔗 [原文](${item.url})`;
  return summary ? `${head}\n${summary}\n${tail}\n` : `${head}\n${tail}\n`;
}

function groupByCategory(cfg, items) {
  const out = new Map();
  for (const cat of cfg.categories) out.set(cat.id, []);

  for (const item of items) {
    const settings = item._settings || resolveSource(cfg, item.source);
    const catId = settings.category || 'misc';
    if (!out.has(catId)) out.set(catId, []);
    out.get(catId).push({ ...item, _settings: settings });
  }

  // Sort within each category by hot desc, then truncate to per-source top_n.
  for (const [catId, list] of out) {
    list.sort((a, b) => (b.hot || 0) - (a.hot || 0));
    out.set(catId, capPerSource(list));
  }
  return out;
}

function capPerSource(list) {
  const seen = new Map();
  const result = [];
  for (const it of list) {
    const cap = it._settings?.top_n ?? 3;
    const n = seen.get(it.source) || 0;
    if (n >= cap) continue;
    seen.set(it.source, n + 1);
    result.push(it);
  }
  return result;
}

function pickLeadItem(target) {
  if (target?.members && Array.isArray(target.members)) {
    return [...target.members].sort((a, b) => (b.hot || 0) - (a.hot || 0))[0];
  }
  return target;
}

function collectPlatforms(target) {
  if (target?.platforms instanceof Set) return Array.from(target.platforms);
  if (target?.members) return Array.from(new Set(target.members.map((m) => m.source)));
  return [target?.source].filter(Boolean);
}

function formatTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function enforceLimit(text) {
  if (text.length <= SCT_DESP_LIMIT) return text;
  return text.slice(0, SCT_DESP_LIMIT - 64) + '\n\n…（truncated by hotBrief to fit ServerChan limit）';
}

/**
 * Send a Markdown message via ServerChan with simple exponential-backoff retry.
 */
export async function sendToServerChan(cfg, title, desp) {
  const key = cfg.secrets.serverchanSctKey;
  const url = SCT_ENDPOINT(key);
  const form = new URLSearchParams();
  form.set('title', title);
  form.set('desp', desp);

  const maxAttempts = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { statusCode, body } = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const json = await body.json().catch(() => ({}));
      if (statusCode === 200 && (json.code === 0 || json.errno === 0)) return json;
      throw new Error(`serverchan error: code=${json.code ?? json.errno} msg=${json.message ?? json.errmsg}`);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const backoff = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  console.error(`[push] serverchan failed after ${maxAttempts} attempts: ${lastErr?.message}`);
  throw lastErr;
}

// CLI entry: node src/push.js --digest | --fulltext --url=<url>
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();

  if (argv.includes('--digest')) {
    pushDigest(cfg).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else if (argv.includes('--fulltext')) {
    const urlArg = argv.find((a) => a.startsWith('--url='));
    if (!urlArg) {
      console.error('usage: node src/push.js --fulltext --url=<url>');
      process.exit(2);
    }
    const url = urlArg.slice('--url='.length);
    pushFulltext(cfg, { source: 'manual', title: 'manual fulltext test', url, hot: 0 }).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else {
    console.error('usage: node src/push.js --digest | --fulltext --url=<url>');
    process.exit(2);
  }
}
