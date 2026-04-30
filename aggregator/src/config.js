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

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const CONFIG_PATH = process.env.CONFIG_PATH || './config.yml';

/**
 * Load and merge runtime configuration.
 *
 * Reads YAML from CONFIG_PATH and overlays secrets from environment.
 * Returns a frozen object so accidental mutation is caught early.
 */
export function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    throw new Error(`failed to read config at ${CONFIG_PATH}: ${err.message}`);
  }

  const cfg = parseYaml(raw) || {};

  // Inject secrets from environment.
  cfg.secrets = {
    serverchanSctKey: requireEnv('SERVERCHAN_SCT_KEY'),
    llmApiKey: requireEnv('LLM_API_KEY'),
    llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
  };

  // DailyHotApi base URL (overridable for local dev or alternate hosts).
  cfg.dailyhotapi = {
    baseUrl: process.env.DAILYHOTAPI_URL || 'http://dailyhotapi:6688',
  };

  cfg.dataDir = process.env.DATA_DIR || './data';

  applyDefaults(cfg);
  return Object.freeze(cfg);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.startsWith('SCT_REPLACE') || v.startsWith('sk-REPLACE')) {
    throw new Error(`missing or placeholder env var: ${name}`);
  }
  return v;
}

function applyDefaults(cfg) {
  cfg.llm = cfg.llm || {};
  cfg.llm.model ??= 'deepseek-chat';
  cfg.llm.digest_max_tokens ??= 600;
  cfg.llm.tldr_max_tokens ??= 200;
  cfg.llm.body_max_tokens ??= 4000;

  cfg.fulltext = cfg.fulltext || {};
  cfg.fulltext.reader_provider ??= 'jina';
  cfg.fulltext.fallback ??= 'link_only';
  cfg.fulltext.max_chars ??= 8000;

  cfg.sources = cfg.sources || {};
  cfg.sources.defaults = {
    enabled: true,
    top_n: 3,
    category: 'misc',
    weight: 1,
    ...(cfg.sources.defaults || {}),
  };
  cfg.sources.overrides = cfg.sources.overrides || {};

  // RSSHub block. Each feed becomes a virtual source that downstream
  // pipeline stages (filter, dedup, group, push) treat the same way as
  // a DailyHotApi source. The fetch stage dispatches by provider.
  cfg.rsshub = cfg.rsshub || {};
  cfg.rsshub.enabled ??= false;
  cfg.rsshub.base_url ??= 'http://rsshub:1200';
  cfg.rsshub.feeds = Array.isArray(cfg.rsshub.feeds) ? cfg.rsshub.feeds : [];

  // Per-source label map. Built from DailyHotApi defaults (in push.js)
  // overlaid with rsshub feed labels here.
  cfg.sourceLabels = cfg.sourceLabels || {};

  if (cfg.rsshub.enabled) {
    for (const feed of cfg.rsshub.feeds) {
      if (!feed?.id) continue;
      // Inject feed metadata so resolveSource() works downstream.
      if (!cfg.sources.overrides[feed.id]) {
        cfg.sources.overrides[feed.id] = {
          enabled: feed.enabled ?? true,
          top_n: feed.top_n,
          category: feed.category,
          weight: feed.weight,
        };
      }
      if (feed.label) cfg.sourceLabels[feed.id] = feed.label;
    }
  }

  // Generic RSS block. Each entry takes a direct RSS/Atom URL — useful for
  // feeds that RSSHub does not (yet) provide a curated route for: Reddit
  // (.rss endpoints), Medium tag feeds, Substack newsletters, official
  // project blogs, etc. Foreign URLs typically need FOREIGN_HTTPS_PROXY set
  // on the aggregator container.
  cfg.rss = cfg.rss || {};
  cfg.rss.enabled ??= false;
  cfg.rss.feeds = Array.isArray(cfg.rss.feeds) ? cfg.rss.feeds : [];

  if (cfg.rss.enabled) {
    for (const feed of cfg.rss.feeds) {
      if (!feed?.id) continue;
      if (!cfg.sources.overrides[feed.id]) {
        cfg.sources.overrides[feed.id] = {
          enabled: feed.enabled ?? true,
          top_n: feed.top_n,
          category: feed.category,
          weight: feed.weight,
        };
      }
      if (feed.label) cfg.sourceLabels[feed.id] = feed.label;
    }
  }

  cfg.categories ??= [
    { id: 'tech', label: '📱 Tech' },
    { id: 'social', label: '💬 Social' },
    { id: 'news', label: '📰 News' },
    { id: 'misc', label: '🗂 Misc' },
  ];

  cfg.keywords = cfg.keywords || {};
  cfg.keywords.blacklist ??= [];
  cfg.keywords.whitelist ??= [];

  cfg.schedule = cfg.schedule || {};
  cfg.schedule.daily_reports ??= ['0 8 * * *', '0 12 * * *', '0 20 * * *'];
  cfg.schedule.fetch_interval_min ??= 30;

  cfg.major_event = {
    enabled: true,
    min_platform_count: 3,
    cooldown_hours: 24,
    apply_weight: true,
    ...(cfg.major_event || {}),
  };

  cfg.digest = {
    group_by_category: true,
    enable_summary: true,
    ...(cfg.digest || {}),
  };

  cfg.foreign_fulltext = {
    enabled: true,
    window_hours: 8,
    body_max_chars: 6000,
    message_max_chars: 28_000,
    cooldown_hours: 24,
    llm_concurrency: 3,
    ...(cfg.foreign_fulltext || {}),
  };

  cfg.bookmark = {
    enabled: false,
    type: 'mailto',
    mailto_address: '',
    subject_prefix: '📚 hotBrief 收藏',
    ...(cfg.bookmark || {}),
  };
}

/**
 * Resolve the effective per-source settings for a given source ID.
 * Applies sources.defaults under sources.overrides[id].
 */
export function resolveSource(cfg, sourceId) {
  const override = cfg.sources.overrides[sourceId] || {};
  return {
    id: sourceId,
    enabled: override.enabled ?? cfg.sources.defaults.enabled,
    top_n: override.top_n ?? cfg.sources.defaults.top_n,
    category: override.category ?? cfg.sources.defaults.category,
    weight: override.weight ?? cfg.sources.defaults.weight,
  };
}
