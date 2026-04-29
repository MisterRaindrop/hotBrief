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

import OpenAI from 'openai';
import { fetchMarkdown } from './fulltext.js';

let cachedClient = null;

function client(cfg) {
  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey: cfg.secrets.llmApiKey,
      baseURL: cfg.secrets.llmBaseUrl,
    });
  }
  return cachedClient;
}

/**
 * Generate a short Chinese teaser for a digest item, based on the
 * headline only.
 *
 * Digest summaries intentionally do not fetch article bodies: a daily
 * digest may contain 100+ items and per-item body fetches would be slow,
 * costly, and fragile (many readers are foreign-hosted). For deep,
 * body-grounded summaries see summarizeTldr() (used in the fulltext lane).
 */
export async function summarizeForDigest(cfg, item) {
  const tokens = cfg.llm.digest_max_tokens ?? 600;
  return await callLlm(cfg, buildTitleOnlyPrompt(item), tokens);
}

/**
 * Generate a short TLDR (~100 chars Chinese) for a major-event cluster.
 */
export async function summarizeTldr(cfg, item, body) {
  const tokens = cfg.llm.tldr_max_tokens ?? 200;
  const prompt = [
    {
      role: 'system',
      content: 'You write concise Chinese news TLDRs. Output only the TLDR text in Chinese, no labels, no markdown.',
    },
    {
      role: 'user',
      content:
        `Source: ${item.source}\nTitle: ${item.title}\nURL: ${item.url}\n\n` +
        `Article body:\n${body || '(body unavailable)'}\n\n` +
        `Write a TLDR in Chinese, 80-120 characters, covering the single most important fact.`,
    },
  ];
  return await callLlm(cfg, prompt, tokens);
}

function buildBodyPrompt(item, body) {
  return [
    {
      role: 'system',
      content:
        'You write Chinese news summaries for a personal aggregator. ' +
        'Output ONLY the summary in Chinese (Simplified Chinese), no preface, no markdown headers.',
    },
    {
      role: 'user',
      content:
        `Source: ${item.source}\nTitle: ${item.title}\nURL: ${item.url}\n\n` +
        `Article body (markdown):\n${body}\n\n` +
        `Task: write a Chinese summary of 300-500 characters. Include key facts, ` +
        `numbers, stakeholders, and the angle most relevant to a tech-savvy reader. ` +
        `Do NOT speculate beyond the article.`,
    },
  ];
}

function buildTitleOnlyPrompt(item) {
  return [
    {
      role: 'system',
      content:
        'You write concise Chinese news teasers based only on a headline. ' +
        'Output ONLY plain Chinese text, 80-150 characters, no markdown, no preface.',
    },
    {
      role: 'user',
      content:
        `Source: ${item.source}\nTitle: ${item.title}\n\n` +
        `Task: rewrite the headline as a richer 80-150 character Chinese teaser ` +
        `that previews what the article likely covers. Indicate uncertainty if ` +
        `the headline is ambiguous; do not invent specific facts or numbers.`,
    },
  ];
}

async function callLlm(cfg, messages, maxTokens) {
  try {
    const resp = await client(cfg).chat.completions.create({
      model: cfg.llm.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    });
    const text = resp.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.warn(`[summarize] llm call failed: ${err.message}`);
    return null;
  }
}
