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

import levenshtein from 'fast-levenshtein';

const SIMILARITY_THRESHOLD = 0.55;

/**
 * Greedy near-duplicate clustering by normalized title similarity.
 *
 * For each item, attach to the first existing cluster whose representative
 * title is within `SIMILARITY_THRESHOLD` (normalized Levenshtein distance);
 * otherwise start a new cluster. O(n * c) where c = cluster count.
 *
 * Returns: [{ key, members: [items], platforms: Set<string>, weightedCount }]
 */
export function clusterByTitle(items, applyWeight = true) {
  const clusters = [];

  for (const item of items) {
    const norm = normalize(item.title);
    if (!norm) continue;

    let attached = false;
    for (const cl of clusters) {
      if (similar(norm, cl.normTitle)) {
        cl.members.push(item);
        cl.platforms.add(item.source);
        cl.weightedCount += weightOf(item, applyWeight);
        attached = true;
        break;
      }
    }
    if (!attached) {
      clusters.push({
        key: norm.slice(0, 60),
        normTitle: norm,
        members: [item],
        platforms: new Set([item.source]),
        weightedCount: weightOf(item, applyWeight),
      });
    }
  }

  return clusters;
}

/**
 * Filter clusters whose distinct-platform count meets `minPlatformCount`.
 * When `applyWeight`, the weighted count is compared instead of raw size.
 */
export function selectMajorEvents(clusters, minPlatformCount, applyWeight = true) {
  return clusters.filter((cl) => {
    const score = applyWeight ? cl.weightedCount : cl.platforms.size;
    return score >= minPlatformCount;
  });
}

function weightOf(item, applyWeight) {
  if (!applyWeight) return 1;
  return Number(item._settings?.weight) || 1;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim();
}

function similar(a, b) {
  if (!a || !b) return false;
  const dist = levenshtein.get(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return false;
  const ratio = 1 - dist / maxLen;
  return ratio >= SIMILARITY_THRESHOLD;
}
