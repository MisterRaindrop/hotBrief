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

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch hot items from DailyHotApi for every enabled source.
 *
 * Returns a flat array of normalized items:
 *   { source, title, url, hot, fetched_at, _settings: {top_n, category, weight} }
 */
export async function fetchAll(cfg) {
  const sourceIds = await resolveEnabledSourceIds(cfg);
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
        console.warn(`[fetch] source=${id} failed: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);

  return results;
}

/**
 * Resolve the list of source IDs to fetch.
 *
 * If sources.defaults.enabled is true, attempt discovery via DailyHotApi.
 * Otherwise, use only sources listed in overrides.
 *
 * Sources explicitly disabled in overrides (enabled: false) are excluded.
 */
async function resolveEnabledSourceIds(cfg) {
  const overrideKeys = Object.keys(cfg.sources.overrides);
  const candidate = new Set(overrideKeys);

  if (cfg.sources.defaults.enabled) {
    try {
      const discovered = await discoverSources(cfg);
      for (const id of discovered) candidate.add(id);
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
  const url = `${cfg.dailyhotapi.baseUrl}/`;
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

function numericHot(v) {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') {
    const m = v.match(/[\d.]+/);
    return m ? Math.round(Number(m[0])) : 0;
  }
  return 0;
}
