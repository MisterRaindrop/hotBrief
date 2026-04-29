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
import { resolveSource } from './config.js';
import { fetchAllRss } from './rss.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch hot items from every enabled provider (DailyHotApi + RSSHub).
 *
 * Returns a flat array of normalized items:
 *   { source, title, url, hot, fetched_at, _settings: {top_n, category, weight} }
 */
export async function fetchAll(cfg) {
  const [dailyhot, rsshub, rss] = await Promise.all([
    fetchAllDailyHot(cfg),
    fetchAllRsshub(cfg),
    fetchAllRss(cfg),
  ]);
  return [...dailyhot, ...rsshub, ...rss];
}

async function fetchAllDailyHot(cfg) {
  const sourceIds = await resolveEnabledDailyHotIds(cfg);
  const results = [];
  const now = Date.now();

  // Fetch in parallel with a small concurrency cap to avoid hammering upstream.
  const CONCURRENCY = 8;
  const queue = [...sourceIds];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      try {
        const items = await fetchOne(cfg, id, now);
        results.push(...items);
      } catch (err) {
        console.warn(`[fetch] dailyhot source=${id} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);

  return results;
}

/**
 * Resolve the list of DailyHotApi source IDs to fetch.
 *
 * If sources.defaults.enabled is true, attempt discovery via DailyHotApi.
 * Otherwise, use only sources listed in overrides.
 *
 * RSSHub feed IDs (registered in cfg.rsshub.feeds) are excluded — those are
 * handled by fetchAllRsshub. Sources explicitly disabled in overrides are
 * also excluded.
 */
async function resolveEnabledDailyHotIds(cfg) {
  const rsshubIds = new Set((cfg.rsshub?.feeds || []).map((f) => f.id).filter(Boolean));
  const rssIds = new Set((cfg.rss?.feeds || []).map((f) => f.id).filter(Boolean));
  const isVirtual = (id) => rsshubIds.has(id) || rssIds.has(id);

  const overrideKeys = Object.keys(cfg.sources.overrides).filter((id) => !isVirtual(id));
  const candidate = new Set(overrideKeys);

  if (cfg.sources.defaults.enabled) {
    try {
      const discovered = await discoverSources(cfg);
      for (const id of discovered) {
        if (!isVirtual(id)) candidate.add(id);
      }
    } catch (err) {
      console.warn(`[fetch] source discovery failed, falling back to overrides only: ${err.message}`);
    }
  }

  const enabled = [];
  for (const id of candidate) {
    const s = resolveSource(cfg, id);
    if (s.enabled) enabled.push(id);
  }
  return enabled;
}

async function discoverSources(cfg) {
  const url = `${cfg.dailyhotapi.baseUrl}/all`;
  const { statusCode, body } = await request(url, { method: 'GET', headersTimeout: REQUEST_TIMEOUT_MS });
  if (statusCode !== 200) throw new Error(`discovery http ${statusCode}`);
  const json = await body.json();

  // DailyHotApi root response shape varies between versions. Be lenient:
  // try common keys, else return empty.
  if (Array.isArray(json?.routes)) return json.routes.map((r) => r.path?.replace(/^\//, '')).filter(Boolean);
  if (Array.isArray(json?.sources)) return json.sources.map((s) => s.id || s.name).filter(Boolean);
  if (Array.isArray(json)) return json.map((s) => s.id || s.name || s).filter(Boolean);
  return [];
}

async function fetchOne(cfg, sourceId, fetchedAt) {
  const url = `${cfg.dailyhotapi.baseUrl}/${sourceId}`;
  const { statusCode, body } = await request(url, { method: 'GET', headersTimeout: REQUEST_TIMEOUT_MS });
  if (statusCode !== 200) throw new Error(`http ${statusCode} for ${sourceId}`);
  const json = await body.json();

  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const settings = resolveSource(cfg, sourceId);
  const limit = Math.max(1, settings.top_n);

  return list.slice(0, limit).map((entry) => ({
    source: sourceId,
    title: String(entry.title ?? entry.name ?? '').trim(),
    url: String(entry.url ?? entry.mobileUrl ?? entry.link ?? '').trim(),
    hot: numericHot(entry.hot ?? entry.score ?? entry.value ?? 0),
    fetched_at: fetchedAt,
    _settings: settings,
  })).filter((it) => it.title && it.url);
}

/**
 * Fetch RSSHub feeds defined in cfg.rsshub.feeds. Each feed becomes a
 * "source" whose ID is feed.id.
 *
 * Hot/score is approximated by item position (top item = highest hot)
 * since RSSHub returns ranked feeds without numeric scores.
 */
async function fetchAllRsshub(cfg) {
  if (!cfg.rsshub?.enabled || !cfg.rsshub.feeds?.length) return [];

  const baseUrl = cfg.rsshub.base_url.replace(/\/+$/, '');
  const results = [];
  const now = Date.now();

  const enabledFeeds = cfg.rsshub.feeds.filter((f) => f?.id && (f.enabled !== false));
  const CONCURRENCY = 4;
  const queue = [...enabledFeeds];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const feed = queue.shift();
      try {
        const items = await fetchOneRsshubFeed(cfg, baseUrl, feed, now);
        results.push(...items);
      } catch (err) {
        console.warn(`[fetch] rsshub feed=${feed.id} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);

  return results;
}

async function fetchOneRsshubFeed(cfg, baseUrl, feed, fetchedAt) {
  const path = feed.path.startsWith('/') ? feed.path : `/${feed.path}`;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${baseUrl}${path}${sep}format=json&limit=50`;

  const { statusCode, body } = await request(url, {
    method: 'GET',
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  if (statusCode !== 200) throw new Error(`http ${statusCode}`);
  const json = await body.json();

  const items = Array.isArray(json?.items) ? json.items : [];
  const settings = resolveSource(cfg, feed.id);
  const limit = Math.max(1, settings.top_n);
  const total = items.length;

  return items.slice(0, limit).map((entry, i) => ({
    source: feed.id,
    title: String(entry.title ?? '').trim(),
    url: String(entry.url ?? entry.external_url ?? entry.id ?? '').trim(),
    hot: Math.max(1, total - i),
    fetched_at: fetchedAt,
    _settings: settings,
  })).filter((it) => it.title && it.url);
}

function numericHot(v) {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') {
    const m = v.match(/[\d.]+/);
    return m ? Math.round(Number(m[0])) : 0;
  }
  return 0;
}
