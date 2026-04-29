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

/**
 * Apply keyword filters to a flat list of items.
 *
 * - blacklist: substring match → drop
 * - whitelist: substring match → tag for fulltext lane
 *
 * Returns:
 *   { kept: items minus blacklisted,
 *     whitelisted: subset of kept that should also go to fulltext push }
 *
 * Match is case-insensitive substring; both sides are lowercased.
 */
export function applyKeywords(items, keywords) {
  const blacklist = (keywords?.blacklist || []).map((k) => k.toLowerCase());
  const whitelist = (keywords?.whitelist || []).map((k) => k.toLowerCase());

  const kept = [];
  const whitelisted = [];

  for (const item of items) {
    const title = (item.title || '').toLowerCase();
    if (blacklist.some((kw) => kw && title.includes(kw))) continue;
    kept.push(item);
    if (whitelist.some((kw) => kw && title.includes(kw))) whitelisted.push(item);
  }

  return { kept, whitelisted };
}
