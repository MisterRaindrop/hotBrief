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

import { recordPush, wasPushedRecently } from './db.js';

const DEDUP_WINDOW_HOURS = 24;

// Channel namespaces. Each push channel has its own cooldown so the same
// item can appear in both a digest and a fulltext push (it usually won't,
// since digest excludes foreign sources, but we keep them isolated).
const KIND_DIGEST = 'digest';
const KIND_FULLTEXT = 'fulltext';
const KIND_CLUSTER = 'cluster';

// ───────────── Digest channel (DailyHotApi items) ─────────────

/**
 * Items not yet pushed via the digest channel within the dedup window.
 */
export function filterUnpushed(items, windowHours = DEDUP_WINDOW_HOURS) {
  return items.filter((it) => !wasPushedRecently(digestKey(it), windowHours));
}

export function markDigestPushed(items) {
  for (const it of items) recordPush(digestKey(it), KIND_DIGEST);
}

// ───────────── Fulltext channel (RSSHub + RSS items) ─────────────

export function filterFullTextUnpushed(items, windowHours = DEDUP_WINDOW_HOURS) {
  return items.filter((it) => !wasPushedRecently(fulltextKey(it), windowHours));
}

export function markFullTextPushed(items) {
  for (const it of items) recordPush(fulltextKey(it), KIND_FULLTEXT);
}

// ───────────── Cluster channel (cross-source major events) ─────────────

export function markClusterPushed(clusterKey) {
  recordPush(`${KIND_CLUSTER}:${clusterKey}`, KIND_CLUSTER);
}

export function clusterPushedRecently(clusterKey, hours) {
  return wasPushedRecently(`${KIND_CLUSTER}:${clusterKey}`, hours);
}

// ───────────── Key construction ─────────────

/**
 * Stable per-item key for the digest channel.
 */
export function digestKey(item) {
  return `${KIND_DIGEST}:item:${item.source}:${normalize(item.title)}`;
}

/**
 * Stable per-item key for the fulltext channel.
 */
export function fulltextKey(item) {
  return `${KIND_FULLTEXT}:item:${item.source}:${normalize(item.title)}`;
}

// ───────────── Source classification ─────────────

/**
 * True when an item comes from a foreign-language feed (RSSHub or direct
 * RSS). Used by both push lanes to decide whether to translate.
 */
export function isForeignSource(item) {
  const src = String(item?.source || '');
  return src.startsWith('rsshub-') || src.startsWith('rss-');
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim();
}
