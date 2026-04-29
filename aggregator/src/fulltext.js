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

const REQUEST_TIMEOUT_MS = 30_000;
const TRUNCATION_NOTICE = '\n\n…（content truncated; see original article）';

// r.jina.ai is foreign-hosted; route through FOREIGN_HTTPS_PROXY when set.
const proxyAgent = process.env.FOREIGN_HTTPS_PROXY
  ? new ProxyAgent({ uri: process.env.FOREIGN_HTTPS_PROXY })
  : null;

/**
 * Fetch a URL's main content as Markdown via the configured reader.
 *
 * Returns a string (possibly truncated to maxChars). Throws on network
 * or HTTP failure; callers decide whether to fall back.
 */
export async function fetchMarkdown(cfg, targetUrl, maxChars) {
  if (!targetUrl) throw new Error('fetchMarkdown: empty url');
  const provider = cfg.fulltext.reader_provider || 'jina';
  const limit = maxChars ?? cfg.fulltext.max_chars ?? 8000;

  switch (provider) {
    case 'jina':
      return truncate(await fetchViaJina(targetUrl), limit);
    default:
      throw new Error(`unsupported reader_provider: ${provider}`);
  }
}

async function fetchViaJina(targetUrl) {
  const url = `https://r.jina.ai/${targetUrl}`;
  const opts = {
    method: 'GET',
    headers: { Accept: 'text/markdown' },
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
  };
  if (proxyAgent) opts.dispatcher = proxyAgent;
  const { statusCode, body } = await request(url, opts);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`jina reader http ${statusCode}`);
  }
  const text = await body.text();
  if (!text || text.length < 32) {
    throw new Error('jina reader returned empty content');
  }
  return text;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - TRUNCATION_NOTICE.length)) + TRUNCATION_NOTICE;
}
