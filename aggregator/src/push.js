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

// Display label and emoji for each known DailyHotApi source.
// Unknown source IDs fall back to the raw ID with a generic icon.
const SOURCE_LABELS = {
  '36kr':            '🚀 36氪',
  '51cto':           '💻 51CTO',
  '52pojie':         '🛡 吾爱破解',
  acfun:             '🌈 AcFun',
  baidu:             '🔍 百度',
  bilibili:          '📺 哔哩哔哩',
  coolapk:           '📱 酷安',
  csdn:              '🖥 CSDN',
  dgtle:             '🎮 数字尾巴',
  'douban-group':    '🎭 豆瓣小组',
  'douban-movie':    '🎬 豆瓣电影',
  douyin:            '🎵 抖音',
  earthquake:        '🌍 地震速报',
  gameres:           '🕹 游资网',
  geekpark:          '💡 极客公园',
  genshin:           '⛩ 原神',
  github:            '🐙 GitHub Trending',
  guokr:             '🐳 果壳',
  hackernews:        '🟠 Hacker News',
  hellogithub:       '⭐️ HelloGitHub',
  history:           '📜 历史上的今天',
  honkai:            '🚄 崩坏：星穹铁道',
  hostloc:           '🌐 全球主机交流',
  hupu:              '🏀 虎扑',
  huxiu:             '🦁 虎嗅',
  ifanr:             '🍎 爱范儿',
  ithome:            '💻 IT之家',
  'ithome-xijiayi':  '🎁 IT之家·喜加一',
  jianshu:           '📓 简书',
  juejin:            '💎 掘金',
  kuaishou:          '🎥 快手',
  linuxdo:           '🐧 Linux.do',
  lol:               '🎮 英雄联盟',
  miyoushe:          '🌸 米游社',
  'netease-news':    '🟥 网易新闻',
  newsmth:           '🎓 水木社区',
  ngabbs:            '🎲 NGA',
  nodeseek:          '🌳 NodeSeek',
  nytimes:           '🗞 纽约时报',
  producthunt:       '🚀 Product Hunt',
  'qq-news':         '🐧 腾讯新闻',
  sina:              '🌐 新浪',
  'sina-news':       '🌐 新浪新闻',
  smzdm:             '💰 什么值得买',
  sspai:             '📦 少数派',
  starrail:          '🌌 崩坏：星穹铁道',
  thepaper:          '📰 澎湃新闻',
  tieba:             '🎫 百度贴吧',
  toutiao:           '📰 今日头条',
  v2ex:              '💎 V2EX',
  weatheralarm:      '⛈ 气象预警',
  weibo:             '🔥 微博',
  weread:            '📚 微信读书',
  yystv:             '🎮 游研社',
  zhihu:             '❓ 知乎',
  'zhihu-daily':     '📅 知乎日报',
};

function labelForSource(sourceId) {
  return SOURCE_LABELS[sourceId] || `📌 ${sourceId}`;
}

/**
 * Format hot/score count into a compact human-readable badge.
 *   1234   → "1.2k"
 *   12345  → "12k"
 *   1234567 → "1.2M"
 */
function formatHot(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v < 1000) return String(v);
  if (v < 10_000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (v < 1_000_000) return Math.round(v / 1000) + 'k';
  return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/**
 * Render and push a daily digest covering items collected since the
 * previous digest window (or last 8h, whichever is shorter).
 *
 * Layout: category → source → items. Items from the same source
 * stay together; sources within a category are ordered by total
 * activity (item count, then max hotness).
 */
export async function pushDigest(cfg) {
  const all = recentItems(8 * 60);
  const { kept } = applyKeywords(all, cfg.keywords);
  const fresh = filterUnpushed(kept);
  if (fresh.length === 0) {
    console.log('[push] digest: no fresh items, skipping');
    return;
  }

  const grouped = groupByCategoryAndSource(cfg, fresh);
  const sourceCount = countSources(grouped);

  // Pre-compute summaries in parallel batches so 100+ item digests don't
  // serialize behind LLM latency. Items keep their summary on `_summary`.
  if (cfg.digest.enable_summary) {
    await populateSummaries(cfg, grouped, 5);
  }

  const sections = [
    `> 📰 **hotBrief** · ${formatTime(new Date())}`,
    `> 共 **${fresh.length}** 条 · 来自 **${sourceCount}** 个来源`,
    '',
  ];

  let firstCategory = true;
  for (const cat of cfg.categories) {
    const sourceMap = grouped.get(cat.id);
    if (!sourceMap || sourceMap.size === 0) continue;
    if (!firstCategory) sections.push('---', '');
    firstCategory = false;

    const catTotal = totalItems(sourceMap);
    sections.push(`## ${cat.label}  ·  ${catTotal} 条`, '');

    for (const [sourceId, sourceItems] of sourceMap) {
      sections.push(`### ${labelForSource(sourceId)}`, '');
      for (let i = 0; i < sourceItems.length; i++) {
        const item = sourceItems[i];
        const hotBadge = formatHot(item.hot);
        const hotSuffix = hotBadge ? `  · 🔥 ${hotBadge}` : '';
        sections.push(`${i + 1}. [${item.title}](${item.url})${hotSuffix}`);
        if (item._summary) {
          sections.push('', `   > ${item._summary.replace(/\n+/g, '\n   > ')}`, '');
        }
      }
      sections.push('');
    }
  }

  const title = `📰 hotBrief 日报 · ${formatTime(new Date())}`;
  const body = sections.join('\n');
  const safe = enforceLimit(body);

  await sendToServerChan(cfg, title, safe);
  markDigestPushed(fresh);
  console.log(`[push] digest: sent ${fresh.length} items from ${sourceCount} sources`);
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

/**
 * Group items first by category (per cfg.categories order) and then by
 * source within each category. Returns a Map<categoryId, Map<sourceId, items[]>>.
 *
 * Within each (category, source) bucket, items are sorted by hot desc and
 * truncated to that source's top_n. Sources within a category are ordered
 * by item count desc, then by max hot desc.
 */
function groupByCategoryAndSource(cfg, items) {
  const out = new Map();
  for (const cat of cfg.categories) out.set(cat.id, new Map());

  for (const item of items) {
    const settings = item._settings || resolveSource(cfg, item.source);
    const catId = settings.category || 'misc';
    if (!out.has(catId)) out.set(catId, new Map());
    const bySource = out.get(catId);
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push({ ...item, _settings: settings });
  }

  for (const [catId, bySource] of out) {
    for (const [sid, list] of bySource) {
      list.sort((a, b) => (b.hot || 0) - (a.hot || 0));
      const cap = list[0]?._settings?.top_n ?? 3;
      bySource.set(sid, list.slice(0, cap));
    }
    // Order sources within the category: most items first, then highest peak hot.
    const ordered = Array.from(bySource.entries()).sort((a, b) => {
      const aCount = a[1].length;
      const bCount = b[1].length;
      if (bCount !== aCount) return bCount - aCount;
      const aPeak = a[1][0]?.hot || 0;
      const bPeak = b[1][0]?.hot || 0;
      return bPeak - aPeak;
    });
    out.set(catId, new Map(ordered));
  }
  return out;
}

/**
 * Run summarizeForDigest for every item in `grouped` with a fixed
 * concurrency limit. Stores the result on `item._summary`.
 */
async function populateSummaries(cfg, grouped, concurrency = 5) {
  const queue = [];
  for (const sourceMap of grouped.values()) {
    for (const list of sourceMap.values()) queue.push(...list);
  }

  const t0 = Date.now();
  let completed = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        item._summary = await summarizeForDigest(cfg, item);
      } catch (err) {
        console.warn(`[push] summary failed for "${item.title}": ${err.message}`);
        item._summary = null;
      }
      completed++;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[push] summarized ${completed} items in ${Date.now() - t0}ms`);
}

function totalItems(sourceMap) {
  let n = 0;
  for (const list of sourceMap.values()) n += list.length;
  return n;
}

function countSources(grouped) {
  let n = 0;
  for (const sourceMap of grouped.values()) n += sourceMap.size;
  return n;
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
