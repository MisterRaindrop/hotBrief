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
import { filterUnpushed, markDigestPushed, isForeignSource } from './dedup.js';
import {
  summarizeForDigest,
  summarizeTldr,
  translateTitle,
  translateBody,
} from './summarize.js';
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

/**
 * Build the ServerChan title for a fulltext (重大热点) push. The title is
 * what appears in the WeChat notification banner, so we surface the
 * article headline. When a Chinese translation is available we lead with
 * it (more glanceable for a Chinese-language reader) and append the
 * original headline as a tail. Total length is capped at TITLE_MAX_CHARS
 * to stay within ServerChan's title field and WeChat's preview width.
 */
const TITLE_MAX_CHARS = 96;
function buildFulltextTitle(lead, titleZh) {
  const prefix = '🔥 重大热点';
  const original = String(lead?.title || '').trim();
  const zh = String(titleZh || '').trim();

  let combined;
  if (zh && zh !== original) {
    combined = `${prefix} · ${zh} | ${original}`;
  } else if (original) {
    combined = `${prefix} · ${original}`;
  } else {
    combined = prefix;
  }
  return truncate(combined, TITLE_MAX_CHARS);
}

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Resolve the display label for a source ID. Lookup order:
 *   1. cfg.sourceLabels (user-defined, e.g. RSSHub feed labels)
 *   2. SOURCE_LABELS (built-in for known DailyHotApi IDs)
 *   3. Fallback: "📌 <id>"
 */
export function labelForSource(cfg, sourceId) {
  return cfg?.sourceLabels?.[sourceId]
    || SOURCE_LABELS[sourceId]
    || `📌 ${sourceId}`;
}

/**
 * Format hot/score count into a compact human-readable badge.
 *   1234   → "1.2k"
 *   12345  → "12k"
 *   1234567 → "1.2M"
 */
/**
 * Compose the bookmark payload (recipient, subject, body) for an item.
 * Returns null when bookmarking is disabled.
 *
 * NOTE: WeChat's in-app browser strips the entire query string from
 * mailto: URLs before delegating to the mail app, so we no longer
 * embed subject/body in the URL. The user gets a long-pressable
 * plaintext block instead.
 */
function bookmarkPayload(cfg, item) {
  const bm = cfg?.bookmark;
  if (!bm || bm.enabled === false || bm.type !== 'mailto' || !bm.mailto_address) return null;

  const prefix = bm.subject_prefix || '📚 hotBrief 收藏';
  const subject = `${prefix}：${item.title}`;
  const date = formatTime(new Date()).slice(0, 10);
  const body =
    `${item.title}\n${item.url}\n\n---\n` +
    `来自 hotBrief · ${labelForSource(cfg, item.source)} · ${date}`;
  // Recipient-only mailto: WeChat-safe (no query string to strip).
  const mailtoUrl = `mailto:${bm.mailto_address}`;

  return { recipient: bm.mailto_address, subject, body, mailtoUrl };
}

/**
 * Inline "open mail composer" link used in compact contexts. WeChat
 * strips mailto query strings, so the URL only carries the recipient.
 * Returns null when bookmarking is disabled.
 */
export function bookmarkLink(cfg, item) {
  const p = bookmarkPayload(cfg, item);
  return p ? `[📧 写邮件](${p.mailtoUrl})` : null;
}

/**
 * Long-pressable bookmark block. WeChat's in-app browser strips ALL
 * mailto query parameters, so the link only carries the recipient and
 * the subject/body live in two long-pressable code blocks the user
 * pastes into the mail composer manually.
 *
 * Workflow:
 *   1. Tap "📧 写邮件" → mail composer opens (recipient pre-filled)
 *   2. Switch back to WeChat, long-press the **主题** code block → copy
 *      → switch to mail, paste in the subject field
 *   3. Switch back to WeChat, long-press the **正文** code block → copy
 *      → switch to mail, paste in the body field
 *
 * Returns an array of Markdown lines, or [] when bookmarking is disabled.
 */
export function bookmarkBlock(cfg, item) {
  const p = bookmarkPayload(cfg, item);
  if (!p) return [];

  return [
    `📧 [写邮件给自己](${p.mailtoUrl})  ·  收件人已自动填好`,
    '',
    '**主题**（长按下方代码块 → 全选 → 复制）：',
    '```',
    p.subject,
    '```',
    '',
    '**正文**（长按下方代码块 → 全选 → 复制）：',
    '```',
    p.body,
    '```',
  ];
}

/**
 * encodeURIComponent leaves `+` alone, but mailto parsers are inconsistent
 * about whether `+` means a literal space; force-escape to be safe.
 */
function rfc3986(s) {
  return encodeURIComponent(String(s)).replace(/\+/g, '%2B');
}

export function formatHot(n) {
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
  // Foreign-language sources (RSSHub, direct RSS) flow through the dedicated
  // per-source full-text channel (fullpush.js), so they are excluded here.
  // The digest now contains only DailyHotApi items.
  const localOnly = all.filter((it) => !isForeignSource(it));
  const { kept } = applyKeywords(localOnly, cfg.keywords);
  const fresh = filterUnpushed(kept);
  if (fresh.length === 0) {
    console.log('[push] digest: no fresh items, skipping');
    return;
  }

  const grouped = groupByCategoryAndSource(cfg, fresh);
  const sourceCount = countSources(grouped);

  // Pre-compute LLM-derived fields in parallel batches so 100+ item
  // digests don't serialize behind LLM latency.
  // - _translated: zh translation of foreign-language headlines (RSSHub items)
  // - _summary:    short Chinese teaser, when enable_summary is true
  if (cfg.digest.translate_foreign_titles !== false) {
    await populateTranslations(cfg, grouped, 5);
  }
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
      sections.push(`### ${labelForSource(cfg, sourceId)}`, '');
      for (let i = 0; i < sourceItems.length; i++) {
        const item = sourceItems[i];
        const hotBadge = formatHot(item.hot);
        const hotSuffix = hotBadge ? `  · 🔥 ${hotBadge}` : '';

        // Original title is the primary linked text.
        sections.push(`${i + 1}. [${item.title}](${item.url})${hotSuffix}`);

        // For foreign-language items, the Chinese translation appears on
        // its own paragraph below the title. Inline subtitle attempts get
        // collapsed by some Markdown renderers (notably WeChat); a blank
        // line ensures a real visual break.
        if (item._translated) {
          sections.push('', `   ${item._translated}`);
        }

        // Summary, if enabled, sits below as an indented blockquote.
        if (item._summary) {
          sections.push('', `   > ${item._summary.replace(/\n+/g, '\n   > ')}`);
        }

        sections.push('');
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
 * Render and push a single fulltext card for a major event or a whitelisted
 * item. When the lead item comes from a foreign-language feed (RSSHub or
 * direct RSS), title and body are translated to Simplified Chinese before
 * render; otherwise the original Chinese content is used as-is.
 *
 * `target` may be either a Cluster object (from major.js) or a single item.
 */
export async function pushFulltext(cfg, target) {
  const lead = pickLeadItem(target);
  const platforms = collectPlatforms(target);
  const foreign = isForeignSource(lead);

  let body = null;
  let tldr = null;
  let titleZh = null;
  let bodyZh = null;

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
    // TLDR works best on the original-language body — Chinese LLMs
    // produce more grounded summaries from the source text.
    tldr = await summarizeTldr(cfg, lead, body);
  }

  if (foreign) {
    try {
      titleZh = await translateTitle(cfg, lead);
    } catch (err) {
      console.warn(`[push] title translation failed: ${err.message}`);
    }
    if (body) {
      try {
        bodyZh = await translateBody(cfg, lead, body);
      } catch (err) {
        console.warn(`[push] body translation failed: ${err.message}`);
      }
    }
  }

  // Server酱 title becomes the WeChat notification preview, so make it
  // informative: show the article headline (and translation, when foreign)
  // rather than just a generic "重大热点 · 时间" line.
  const title = buildFulltextTitle(lead, titleZh);

  const sections = [`## ${lead.title}`];
  if (titleZh) sections.push('', `_${titleZh}_`);
  sections.push('');

  sections.push(
    platforms.length > 1
      ? `**多平台共振**：${platforms.join(' · ')}`
      : `**来源**：${labelForSource(cfg, lead.source)}`,
  );
  sections.push('');
  const bm = bookmarkBlock(cfg, lead);
  if (bm.length > 0) sections.push(...bm, '');

  if (tldr) sections.push(`**TLDR**：${tldr}`, '');
  sections.push('---', '');

  // Prefer the translated body for foreign sources; fall back to the
  // original body if translation failed; fall back to a stub if even
  // the reader failed.
  const renderBody = bodyZh || body;
  if (renderBody) {
    sections.push(renderBody);
  } else {
    sections.push('_（fulltext unavailable; see original article）_');
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
 * Translate foreign-language headlines into Simplified Chinese with a
 * fixed concurrency limit. Stores the translation on `item._translated`.
 *
 * Selection: items whose source ID starts with `rsshub-` AND whose title
 * has fewer than 4 CJK characters (a crude "looks foreign" heuristic).
 */
async function populateTranslations(cfg, grouped, concurrency = 5) {
  const queue = [];
  for (const sourceMap of grouped.values()) {
    for (const list of sourceMap.values()) {
      for (const item of list) {
        if (shouldTranslate(item)) queue.push(item);
      }
    }
  }
  if (queue.length === 0) return;

  const t0 = Date.now();
  const total = queue.length;

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        item._translated = await translateTitle(cfg, item);
      } catch (err) {
        console.warn(`[push] translation failed for "${item.title}": ${err.message}`);
        item._translated = null;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[push] translated ${total} foreign titles in ${Date.now() - t0}ms`);
}

function shouldTranslate(item) {
  const src = String(item.source);
  if (!src.startsWith('rsshub-') && !src.startsWith('rss-')) return false;
  const cjk = (item.title.match(/[一-鿿]/g) || []).length;
  return cjk < 4;
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

export function formatTime(d) {
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

// CLI entry: node src/push.js --digest | --fulltext --url=<url> | --foreign-fulltext
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();

  if (argv.includes('--digest')) {
    pushDigest(cfg).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else if (argv.includes('--foreign-fulltext')) {
    // Lazy-import to avoid circular module load during digest-only runs.
    import('./fullpush.js').then(({ pushForeignFulltext }) =>
      pushForeignFulltext(cfg).catch((e) => {
        console.error(e);
        process.exit(1);
      }),
    );
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
    console.error('usage: node src/push.js --digest | --fulltext --url=<url> | --foreign-fulltext');
    process.exit(2);
  }
}
