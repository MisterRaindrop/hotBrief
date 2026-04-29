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

import 'dotenv/config';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { getDb, insertItems, pruneOld } from './db.js';
import { fetchAll } from './fetch.js';
import { applyKeywords } from './filter.js';
import { clusterByTitle, selectMajorEvents } from './major.js';
import { clusterPushedRecently, markClusterPushed } from './dedup.js';
import { pushDigest, pushFulltext } from './push.js';

let running = false;
let cfg = null;

async function main() {
  cfg = loadConfig();
  getDb(cfg.dataDir);

  console.log(`[hotBrief] starting`);
  console.log(`[hotBrief] dailyhotapi: ${cfg.dailyhotapi.baseUrl}`);
  console.log(`[hotBrief] llm provider/model: ${cfg.llm.provider}/${cfg.llm.model}`);
  console.log(`[hotBrief] data dir: ${cfg.dataDir}`);

  scheduleFetchLoop();
  scheduleDigests();
  schedulePrune();

  // Kick off one fetch immediately so the DB warms up at startup.
  runFetchCycle().catch((e) => console.error(`[hotBrief] startup fetch failed: ${e.message}`));
}

function scheduleFetchLoop() {
  const minutes = Math.max(1, cfg.schedule.fetch_interval_min ?? 30);
  // Cron: every N minutes (limited to 1..59).
  const expr = minutes >= 60 ? `0 */${Math.floor(minutes / 60)} * * *` : `*/${minutes} * * * *`;
  cron.schedule(expr, () => {
    runFetchCycle().catch((e) => console.error(`[hotBrief] fetch cycle failed: ${e.message}`));
  });
  console.log(`[hotBrief] fetch cron: ${expr}`);
}

function scheduleDigests() {
  for (const expr of cfg.schedule.daily_reports || []) {
    cron.schedule(expr, () => {
      console.log(`[hotBrief] digest trigger: ${expr}`);
      pushDigest(cfg).catch((e) => console.error(`[hotBrief] digest push failed: ${e.message}`));
    });
    console.log(`[hotBrief] digest cron: ${expr}`);
  }
}

function schedulePrune() {
  // Prune at 3am local time daily.
  cron.schedule('0 3 * * *', () => {
    pruneOld(72);
    console.log('[hotBrief] pruned items older than 72h');
  });
}

/**
 * One end-to-end fetch cycle:
 *   1. fetch all enabled sources from DailyHotApi
 *   2. apply keyword filter (drop blacklist; tag whitelist)
 *   3. persist to SQLite
 *   4. detect major events and push fulltext if any
 *   5. push fulltext for whitelisted items
 *
 * Concurrent invocations are dropped with a warning.
 */
async function runFetchCycle() {
  if (running) {
    console.warn('[hotBrief] previous fetch cycle still running, skipping');
    return;
  }
  running = true;
  const t0 = Date.now();

  try {
    const items = await fetchAll(cfg);
    const { kept, whitelisted } = applyKeywords(items, cfg.keywords);
    insertItems(kept);
    console.log(`[hotBrief] fetched ${items.length} items, kept ${kept.length}, whitelisted ${whitelisted.length} (${Date.now() - t0}ms)`);

    if (cfg.major_event.enabled && kept.length > 0) {
      await processMajorEvents(kept);
    }

    for (const item of whitelisted) {
      await pushFulltextSafe(item, `whitelist:${item.source}:${item.title}`);
    }
  } finally {
    running = false;
  }
}

async function processMajorEvents(items) {
  const clusters = clusterByTitle(items, cfg.major_event.apply_weight);
  const major = selectMajorEvents(clusters, cfg.major_event.min_platform_count, cfg.major_event.apply_weight);

  for (const cluster of major) {
    if (clusterPushedRecently(cluster.key, cfg.major_event.cooldown_hours)) continue;
    try {
      await pushFulltext(cfg, cluster);
      markClusterPushed(cluster.key);
    } catch (err) {
      console.error(`[hotBrief] major-event push failed for "${cluster.key}": ${err.message}`);
    }
  }
}

async function pushFulltextSafe(item, dedupKey) {
  if (clusterPushedRecently(dedupKey, cfg.major_event.cooldown_hours)) return;
  try {
    await pushFulltext(cfg, item);
    markClusterPushed(dedupKey);
  } catch (err) {
    console.error(`[hotBrief] whitelist push failed: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(`[hotBrief] fatal: ${err.message}`);
  process.exit(1);
});
