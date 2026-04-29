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
 * Generate a 300-500 character Chinese summary for a news item.
 *
 * Prefers fetching the article body via the reader for better fidelity;
 * falls back to title-only summarization on reader failure.
 *
 * Returns a Chinese-language string, or null on hard LLM failure.
 */
export async function summarizeForDigest(cfg, item) {
  const tokens = cfg.llm.digest_max_tokens ?? 600;

  let body = null;
  try {
    body = await fetchMarkdown(cfg, item.url, 6000);
  } catch (err) {
    console.warn(`[summarize] reader failed for ${item.url}: ${err.message}`);
  }

  const prompt = body
    ? buildBodyPrompt(item, body)
    : buildTitleOnlyPrompt(item);

  return await callLlm(cfg, prompt, tokens);
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
        'You write extremely concise Chinese news teasers when only a headline is available. ' +
        'Output ONLY plain Chinese text, 50-100 characters, no markdown.',
    },
    {
      role: 'user',
      content:
        `Source: ${item.source}\nTitle: ${item.title}\n\n` +
        `Task: paraphrase the headline into a 50-100 character Chinese teaser. ` +
        `Indicate uncertainty if the headline is ambiguous; do not invent details.`,
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
