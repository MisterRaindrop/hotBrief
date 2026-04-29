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

/**
 * Filter out items that were pushed (in any channel) within the dedup window.
 * Returns the items still eligible for pushing.
 *
 * `whitelisted` items bypass dedup — caller passes them through unchanged.
 */
export function filterUnpushed(items, windowHours = DEDUP_WINDOW_HOURS) {
  return items.filter((it) => !wasPushedRecently(itemKey(it), windowHours));
}

/**
 * Mark a batch of items as pushed for the digest channel.
 */
export function markDigestPushed(items) {
  for (const it of items) recordPush(itemKey(it), 'digest');
}

/**
 * Mark a major-event cluster as pushed (cluster-level cooldown).
 */
export function markClusterPushed(clusterKey) {
  recordPush(`cluster:${clusterKey}`, 'cluster');
}

export function clusterPushedRecently(clusterKey, hours) {
  return wasPushedRecently(`cluster:${clusterKey}`, hours);
}

/**
 * Stable per-item key for dedup. Uses normalized title + source.
 */
export function itemKey(item) {
  return `item:${item.source}:${normalize(item.title)}`;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim();
}
