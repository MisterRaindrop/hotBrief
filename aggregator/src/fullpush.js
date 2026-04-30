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

import { recentItems } from './db.js';
import { applyKeywords } from './filter.js';
import {
  filterFullTextUnpushed,
  markFullTextPushed,
  isForeignSource,
} from './dedup.js';
import { translateTitle, translateBody } from './summarize.js';
import { fetchMarkdown } from './fulltext.js';
import {
  sendToServerChan,
  labelForSource,
  formatHot,
  formatTime,
  bookmarkLink,
  bookmarkBlock,
} from './push.js';

const SCT_DESP_LIMIT = 32_000;

/**
 * Per-source full-text push for foreign feeds (RSSHub + direct RSS).
 *
 * For each enabled foreign feed in the recent window:
 *   1. Filter through keywords + dedup.
 *   2. Group items by source ID.
 *   3. For each item, fetch the article body via the configured reader
 *      and translate title + body into Simplified Chinese.
 *   4. Render each item as a Markdown card with a mailto bookmark link.
 *   5. Pack rendered cards into ServerChan-sized pages and push each
 *      page as its own message titled "<source-label> · N/M".
 */
export async function pushForeignFulltext(cfg) {
  if (cfg.foreign_fulltext?.enabled === false) {
    console.log('[fullpush] disabled by config');
    return;
  }

  const windowMin = (cfg.foreign_fulltext?.window_hours ?? 8) * 60;
  const all = recentItems(windowMin);
  const foreign = all.filter(isForeignSource);
  const { kept } = applyKeywords(foreign, cfg.keywords);
  const cooldown = cfg.foreign_fulltext?.cooldown_hours ?? 24;
  const fresh = filterFullTextUnpushed(kept, cooldown);
  if (fresh.length === 0) {
    console.log('[fullpush] no fresh foreign items, skipping');
    return;
  }

  const bySource = groupBySource(fresh);
  const concurrency = Math.max(1, cfg.foreign_fulltext?.llm_concurrency ?? 3);
  const messageCap = Math.min(
    SCT_DESP_LIMIT,
    cfg.foreign_fulltext?.message_max_chars ?? 28_000,
  );

  const t0 = Date.now();
  let totalArticles = 0;
  let totalMessages = 0;

  for (const [sourceId, items] of bySource) {
    const enriched = await enrichInParallel(cfg, items, concurrency);
    const cards = enriched.map((item) => renderCard(cfg, item));
    const pages = paginateCards(cards, messageCap, sourceLabel(cfg, sourceId), enriched.length);

    for (let i = 0; i < pages.length; i++) {
      const title = `${sourceLabel(cfg, sourceId)} · ${i + 1}/${pages.length}`;
      try {
        await sendToServerChan(cfg, title, pages[i]);
        totalMessages++;
      } catch (err) {
        console.error(`[fullpush] send failed for ${sourceId} page ${i + 1}: ${err.message}`);
      }
    }

    markFullTextPushed(enriched);
    totalArticles += enriched.length;
  }

  console.log(
    `[fullpush] sent ${totalArticles} articles across ${totalMessages} messages ` +
      `from ${bySource.size} sources in ${Date.now() - t0}ms`,
  );
}

/**
 * For each item, fetch body via the reader and translate title + body
 * concurrently (bounded by `concurrency`). Mutates items with
 * `_body` (translated body or fallback original) and `_titleZh`.
 */
async function enrichInParallel(cfg, items, concurrency) {
  const queue = [...items];
  const fallback = cfg.fulltext?.fallback ?? 'link_only';

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();

      let rawBody = null;
      try {
        rawBody = await fetchMarkdown(cfg, item.url, cfg.foreign_fulltext?.body_max_chars ?? 6000);
      } catch (err) {
        console.warn(`[fullpush] reader failed for ${item.url}: ${err.message}`);
      }

      // Translate body if we got one. On translation failure we keep the
      // original body so the article is still readable (English).
      if (rawBody) {
        try {
          const translated = await translateBody(cfg, item, rawBody);
          item._body = translated || rawBody;
          item._bodyTranslated = Boolean(translated);
        } catch (err) {
          console.warn(`[fullpush] body translation failed for ${item.url}: ${err.message}`);
          item._body = rawBody;
          item._bodyTranslated = false;
        }
      } else {
        item._body = null;
        item._bodyTranslated = false;
      }

      // Always translate title; cheap and useful even when body is missing.
      try {
        item._titleZh = await translateTitle(cfg, item);
      } catch (err) {
        console.warn(`[fullpush] title translation failed for ${item.url}: ${err.message}`);
        item._titleZh = null;
      }

      item._fallback = fallback;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return items;
}

/**
 * Render a single article into the per-item Markdown card.
 *
 *   ## <original title>
 *   <chinese translation>
 *
 *   > 🔥 <hot> · 📧 [收藏](mailto:...)
 *
 *   <body — translated when available, otherwise original or fallback note>
 *
 *   🔗 [原文](<url>)
 */
export function renderCard(cfg, item) {
  const lines = [];

  lines.push(`## ${item.title}`);
  if (item._titleZh) {
    lines.push('', `_${item._titleZh}_`);
  }
  lines.push('');

  const hot = formatHot(item.hot);
  const metaParts = [];
  if (hot) metaParts.push(`🔥 ${hot}`);
  const inlineLink = bookmarkLink(cfg, item);
  if (inlineLink) metaParts.push(inlineLink);
  if (metaParts.length > 0) lines.push(`> ${metaParts.join(' · ')}`, '');

  if (item._body) {
    lines.push(item._body);
  } else if (item._fallback === 'skip') {
    // Still emit a stub so the section is non-empty; caller already chose
    // not to skip the entire push.
    lines.push('_（正文获取失败，跳过）_');
  } else {
    lines.push('_（正文获取失败，仅保留原文链接）_');
  }
  lines.push('');

  lines.push(`🔗 [原文](${item.url})`);

  // Append the copyable bookmark block at the very end of the card so
  // QQ-Mail users (whose mail client drops mailto query params) can
  // long-press to copy subject/body.
  const block = bookmarkBlock(cfg, item);
  if (block.length > 0) {
    lines.push('', ...block);
  }

  return lines.join('\n');
}

/**
 * Pack rendered article cards into pages no larger than `cap` characters.
 * A header/footer is prepended/appended to each page; the same per-page
 * boilerplate is counted toward the cap so we never overshoot.
 */
function paginateCards(cards, cap, sourceLabel, articleCount) {
  // Separator between cards within a page.
  const SEP = '\n\n---\n\n';
  // Reserve some space for header/footer per page; recomputed per page.
  const HEADER_RESERVE = 256;

  // Single-card sanity: if any card alone exceeds cap, hard-truncate it
  // (with a notice). Avoids an infinite loop in the pack step.
  const safeCards = cards.map((c) => (c.length <= cap - HEADER_RESERVE
    ? c
    : c.slice(0, cap - HEADER_RESERVE - 64) + '\n\n…（content truncated to fit message limit）'));

  const pages = [];
  let currentBody = '';
  for (const card of safeCards) {
    const sep = currentBody ? SEP : '';
    if (currentBody.length + sep.length + card.length > cap - HEADER_RESERVE) {
      pages.push(currentBody);
      currentBody = card;
    } else {
      currentBody += sep + card;
    }
  }
  if (currentBody) pages.push(currentBody);

  const total = pages.length;
  return pages.map((body, i) => {
    const header = `**📅 ${formatTime(new Date())}**  ·  **来自 ${sourceLabel}**  ·  **共 ${articleCount} 篇 · 第 ${i + 1}/${total} 页**\n\n---\n\n`;
    return header + body;
  });
}

function groupBySource(items) {
  const out = new Map();
  for (const it of items) {
    if (!out.has(it.source)) out.set(it.source, []);
    out.get(it.source).push(it);
  }
  // Sort each group by hot desc so the most prominent article leads.
  for (const list of out.values()) list.sort((a, b) => (b.hot || 0) - (a.hot || 0));
  return out;
}

function sourceLabel(cfg, sourceId) {
  return labelForSource(cfg, sourceId);
}
