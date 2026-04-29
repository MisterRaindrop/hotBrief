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

import { request, ProxyAgent } from 'undici';
import Parser from 'rss-parser';
import { resolveSource } from './config.js';

const REQUEST_TIMEOUT_MS = 30_000;
// Use a real-looking User-Agent — Reddit and a few CDNs return 403 to
// generic Node.js or libcurl agents.
const USER_AGENT = 'Mozilla/5.0 (compatible; hotBrief/1.0; +https://github.com/MisterRaindrop/hotBrief)';

const proxyAgent = process.env.FOREIGN_HTTPS_PROXY
  ? new ProxyAgent({ uri: process.env.FOREIGN_HTTPS_PROXY })
  : null;

const parser = new Parser({
  timeout: REQUEST_TIMEOUT_MS,
});

/**
 * Fetch every direct RSS feed configured in cfg.rss.feeds.
 * Each feed becomes a virtual source, indexed by feed.id.
 */
export async function fetchAllRss(cfg) {
  if (!cfg.rss?.enabled || !cfg.rss.feeds?.length) return [];

  const enabledFeeds = cfg.rss.feeds.filter((f) => f?.id && f?.url && (f.enabled !== false));
  if (enabledFeeds.length === 0) return [];

  const results = [];
  const now = Date.now();
  const CONCURRENCY = 4;
  const queue = [...enabledFeeds];

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const feed = queue.shift();
      try {
        const items = await fetchOneRssFeed(cfg, feed, now);
        results.push(...items);
      } catch (err) {
        console.warn(`[fetch] rss feed=${feed.id} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);

  return results;
}

async function fetchOneRssFeed(cfg, feed, fetchedAt) {
  const opts = {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
    maxRedirections: 5,
  };
  if (proxyAgent) opts.dispatcher = proxyAgent;

  const { statusCode, body } = await request(feed.url, opts);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`http ${statusCode}`);
  }
  const xml = await body.text();
  const parsed = await parser.parseString(xml);

  const items = parsed.items || [];
  const settings = resolveSource(cfg, feed.id);
  const limit = Math.max(1, settings.top_n);
  const total = items.length;

  return items.slice(0, limit).map((entry, i) => ({
    source: feed.id,
    title: String(entry.title ?? '').trim(),
    url: String(entry.link ?? entry.guid ?? '').trim(),
    hot: Math.max(1, total - i),
    fetched_at: fetchedAt,
    _settings: settings,
  })).filter((it) => it.title && it.url);
}
