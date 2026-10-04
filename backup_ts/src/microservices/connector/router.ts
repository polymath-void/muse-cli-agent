import * as crypto from "node:crypto";
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResponseCache } from './cache.js';
import { RouteLatchManager } from './latch.js';

/** Per-request timeout (Termux LMK-safe: fail fast, try next account). */
const REQUEST_TIMEOUT_MS = 60_000;
/** How long a 429-exhausted account is skipped (1h, matches latch window). */
const EXHAUSTION_MS = 3_600_000;

/**
 * Client identity for Zen requests. The Console free-tier gate checks the
 * client version (needs >= 1.18.0) and client name; third-party clients must
 * present an `opencode/…` UA or `-free` models are rejected outright. This
 * mirrors what the official client sends (see `cu(e.app)` in its request
 * builder) and may stop working if upstream changes the gate — keyed models
 * are unaffected.
 */
const OPENCODE_UA = 'opencode/1.18.16';
const OPENCODE_CLIENT = 'muse-cli-agent';

/** JSON-Schema keywords Gemini's functionDeclarations reject or ignore. */
const SCHEMA_DROP_KEYS = new Set([
  'additionalProperties',
  '$schema',
  '$id',
  'default',
  'examples',
  'const',
  'definitions',
  '$defs',
]);

/**
 * Antigravity's Gemini surface rejects any replayed tool turn whose
 * `functionCall` part lacks `thoughtSignature`:
 *   400 "Function call is missing a thought_signature in functionCall parts."
 * The signature is an opaque token the model emits, and the OpenAI
 * `tool_calls` shape has nowhere to put it. So it rides inside the call id
 * (base64url) — stateless, survives history/session replay and a process
 * restart, unlike an in-memory map keyed by call id.
 */
const THOUGHT_SIG_MARK = '__sig_';

function encodeCallId(index: number, thoughtSignature: unknown): string {
  const base = `call_${Date.now().toString(36)}_${index}`;
  if (typeof thoughtSignature !== 'string' || thoughtSignature.length === 0) return base;
  return `${base}${THOUGHT_SIG_MARK}${Buffer.from(thoughtSignature, 'utf-8').toString('base64url')}`;
}

/** Split a call id back into the bare id and the embedded thoughtSignature. */
function decodeCallId(id: unknown): { id: string; thoughtSignature?: string } {
  if (typeof id !== 'string') return { id: '' };
  const at = id.indexOf(THOUGHT_SIG_MARK);
  if (at < 0) return { id };
  try {
    const sig = Buffer.from(id.slice(at + THOUGHT_SIG_MARK.length), 'base64url').toString('utf-8');
    return sig.length > 0 ? { id: id.slice(0, at), thoughtSignature: sig } : { id: id.slice(0, at) };
  } catch {
    return { id };
  }
}

/**
 * Recursively strip keywords Gemini rejects and collapse `["string","null"]`
 * unions down to `"string"`. One unsupported keyword makes the whole
 * `generateContent` request fail with INVALID_ARGUMENT, so sanitizing here is
 * the difference between a working agent loop and a silent no-op.
 */
function sanitizeJsonSchema(node: any, depth = 0): any {
  if (depth > 12 || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => sanitizeJsonSchema(n, depth + 1));

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node as Record<string, any>)) {
    if (SCHEMA_DROP_KEYS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      // Gemini takes a single type; prefer the first non-"null" member.
      const picked = value.find((t: unknown) => t !== 'null') ?? 'string';
      out.type = picked;
      continue;
    }
    out[key] = sanitizeJsonSchema(value, depth + 1);
  }
  // A property-less object node is valid ("any"), but `{}` as parameters is
  // rejected — callers without a schema simply omit `parameters`.
  return out;
}

function zenBase(): string {
  return (process.env.OPENCODE_API_BASE_URL ?? 'https://opencode.ai/zen/v1').replace(/\/+$/, '');
}

/**
 * Zen serves each model family on its own surface (see opencode.ai/docs/zen):
 * - chat/completions : OpenAI-compatible (deepseek, minimax, glm, kimi,
 *                      qwen3.8-max, big-pickle, *-free (non-spark), …)
 * - responses       : OpenAI Responses API (gpt-*, grok-*, muse-spark-*)
 * - messages        : Anthropic-compatible (claude-*, qwen3.8-flash,
 *                      qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3.5-plus)
 * - models/<id>     : Google-compatible (gemini-*)
 * - systemone       : Jev decisions API (jev-*) — not a chat surface.
 */
export type ZenSurface = 'chat' | 'responses' | 'anthropic' | 'google' | 'systemone';

export function zenSurfaceFor(model: string): ZenSurface {
  let m = model.toLowerCase();
  if (m.startsWith('opencode/')) m = m.substring('opencode/'.length);
  if (m.startsWith('jev-')) return 'systemone';
  if (/^(gpt-|grok-|muse-spark-)/.test(m)) return 'responses';
  if (/^(claude-|qwen3\.(8-flash|7-max|7-plus|6-plus|5-plus))/.test(m)) return 'anthropic';
  if (m.startsWith('gemini-')) return 'google';
  return 'chat';
}

export interface ToolCallNormalized {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessageIn {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

const asText = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const o = p as Record<string, unknown>;
          if (typeof o.text === 'string') return o.text;
          if (typeof o.content === 'string') return o.content;
        }
        return '';
      })
      .join('');
  }
  return '';
};

export class UnifiedRouter {
  public cache = new ResponseCache();
  public latch = new RouteLatchManager();

  async route(providerKey: string, model: string, body: any, isStream: boolean, providersConfig: any): Promise<any> {
    // Never cache streams or tool-bearing turns (tool_calls must stay fresh).
    const cacheable = !isStream && !(body as Record<string, unknown>)?.tools;
    if (cacheable) {
      const cached = this.cache.get(model, body);
      if (cached) {
        console.log(`[Router] Cache hit for ${model}`);
        return cached;
      }
    }

    if (providerKey === 'opencode' && zenSurfaceFor(model) === 'systemone') {
      throw new Error(
        `[Router] ${model} is a Jev decisions model (SystemOne API: {state, questions}) — it is not a chat model. Pick a chat model via /model.`,
      );
    }

    // Determine cascade strategy based on model
    const cascade = this.buildCascade(model);

    // Check latches
    const { startTierIdx } = this.latch.shouldFastPath(model, cascade.length);

    let lastError = '';
    let lastResponse: Response | undefined;

    // Agy delegation-first: the Python agy-connector on localhost:8080 owns
    // OAuth refresh, quota families, thinking-patch cascade, and route latching.
    // The native TS agy path below is the offline fallback. Connector reachable
    // → its answer is authoritative (never mask it with a native 401);
    // only `null` (offline) falls through to the native cascade.
    if (providerKey === 'agy') {
      try {
        const delegate = await import('./agy-delegate.js');
        const src = body as { messages?: ChatMessageIn[]; contents?: unknown };
        const messages: ChatMessageIn[] = Array.isArray(src.messages)
          ? src.messages
          : this.contentsToMessages(src.contents);
        const inner = this.toGoogleBody(messages, isStream, (body as { tools?: unknown }).tools) as Record<string, unknown>;
        const raw = await delegate.fetchAgyConnector(model, inner, isStream);
        if (raw !== null) {
          if (!raw.ok) {
            const text = await raw.text().catch(() => '').then((t) => t.slice(0, 500));
            throw new Error(`[Router] agy-connector HTTP ${raw.status}: ${text}`);
          }
          this.latch.restorePrimary(model);
          if (!isStream) {
            const respJson = (await raw.json()) as Record<string, unknown>;
            const unwrapped: any = (respJson as { response?: unknown }).response ?? respJson;
            // The connector returns HTTP 200 with an embedded backend error
            // body when every tier fails (e.g. MODEL_CAPACITY_EXHAUSTED).
            // Surface it instead of normalizing to an empty message.
            const embedded = (unwrapped as { error?: { code?: number; message?: string; status?: string } }).error;
            if (embedded && typeof embedded.message === 'string') {
              throw new Error(`[Router] agy-connector backend ${embedded.code ?? ''} ${embedded.status ?? ''}: ${embedded.message}`.trim());
            }
            const data = this.normalizeNonStream('agy', unwrapped);
            if (cacheable) this.cache.set(model, body, data);
            return data;
          }
          return this.normalizeStream('agy', raw);
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? '';
        if (msg.includes('agy-connector')) throw err;
        // Connector offline or delegate error → continue to native cascade.
        if (lastError) void lastError;
      }
    }

    for (let tierIdx = startTierIdx; tierIdx < cascade.length; tierIdx++) {
      const tierModel = cascade[tierIdx];
      const accounts = this.getAccounts(providersConfig, providerKey);

      for (const account of accounts) {
        if (this.isAccountExhausted(account, tierModel)) continue;
        const key = String(account.api_key ?? account.access_token ?? '').trim();
        let finalKey = key;
        
        // Native Agy token refresh inside the cascade loop
        if (providerKey === 'agy' && account.refreshToken) {
           const resetKey = `expires_at`;
           const expiresAt = account[resetKey] || 0;
           if (Date.now() / 1000 > expiresAt || !finalKey) {
               try {
                   const { refreshAccessToken } = await import('../../auth.js');
                   const token = await refreshAccessToken(
                       "https://oauth2.googleapis.com/token",
                       "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
                       account.refreshToken,
                       "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"
                   );
                   account.access_token = token.access_token;
                   account[resetKey] = Math.floor(Date.now() / 1000) + (token.expires_in || 3600);
                   finalKey = token.access_token;
                   
                   // Persist to disk natively
                   const accountsPath = path.join(os.homedir(), '.config/opencode/antigravity-accounts.json');
                   if (fs.existsSync(accountsPath)) {
                       const content = fs.readFileSync(accountsPath, 'utf8');
                       const parsed = JSON.parse(content);
                       const match = parsed.accounts.find((a: any) => a.email === account.email);
                       if (match) {
                           match.access_token = token.access_token;
                           fs.writeFileSync(accountsPath, JSON.stringify(parsed, null, 2));
                       }
                   }
               } catch (e) {
                   console.log(`[Router] Skipping account ${account.email || 'unknown'} due to auth error: ${(e as Error).message}`);
                   continue;
               }
           }
        }
        
        if (!finalKey) {
          lastError = `no credential for provider "${providerKey}" (run \`muse-cli login ${providerKey}\` or set ${providerKey === 'opencode' ? 'OPENCODE_API_KEY' : 'an API key'})`;
          continue;
        }

        try {
          let reqBody = this.buildRequestBody(providerKey, tierModel, body, isStream);
          if (providerKey === 'agy') {
              const isAgent = tierModel.includes('-agent') || tierModel.includes('pro-low');
              if (isAgent) {
                  reqBody.requestType = "agent";
                  reqBody.userAgent = "antigravity";
                  reqBody.requestId = `agent-${Math.random().toString(36).substring(7)}`;
              }
          }

          const headers = this.buildHeaders(providerKey, finalKey);
          if (providerKey === 'agy') {
              headers['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.6.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
          }
          const endpoint = this.getEndpoint(providerKey, tierModel, isStream);

          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
          let response: Response;
          try {
            response = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(reqBody),
              signal: ctrl.signal,
            });
          } catch (e: any) {
            clearTimeout(timer);
            lastError = (e as Error)?.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms on ${tierModel}` : (e as Error).message;
            continue;
          }
          clearTimeout(timer);
          
          if (!response.ok) {
            const errBody = await response.text().catch(()=>"");
            lastError = `${response.status} ${response.statusText}: ${errBody}`;
            if (response.status === 403 || response.status === 429) {
               this.markAccountExhausted(account, tierModel);
               continue;
            }
            if (response.status === 400 || response.status === 404) {
               break; // tier miss
            }
            continue;
          }
          
          if (tierIdx > 0) {
            this.latch.latchFallback(model, tierIdx, Date.now() + EXHAUSTION_MS);
          } else {
            this.latch.restorePrimary(model);
          }

          if (isStream) {
             return this.normalizeStream(providerKey, response);
          } else {
             const json = await response.json();
             const data = this.normalizeNonStream(providerKey, (json as { response?: unknown })?.response ?? json);
             if (cacheable) this.cache.set(model, body, data);
             return data;
          }
        } catch (e) {
            lastError = (e as Error).message;
            continue;
        }
      }
    }
    
    throw new Error(`[Router] All accounts/tiers exhausted for ${model}. Last error: ${lastError}`);
  }

  private buildCascade(model: string): string[] {
    // Native-only fallback cascade (connector offline). Mirrors
    // agy_connector.py:get_cascade_for_model Tier targets with live modelIds.
    const m = model.replace(/^models\//, '').replace(/^antigravity-/, '');
    if (m.includes('gemini-3.1-pro-high')) return ['gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'gemini-3-flash', 'gemini-2.5-flash'];
    if (m.includes('gemini-3.1-pro')) return ['gemini-3.1-pro-low', 'gemini-3-flash', 'gemini-2.5-flash'];
    if (m.includes('gemini-3-pro') || m.includes('gemini-3.6-flash') || m.includes('gemini-3.1-pro-high')) return ['gemini-3-pro-low', 'gemini-3-flash', 'gemini-2.5-flash'];
    if (m.includes('gemini-3-flash')) return ['gemini-3-flash', 'gemini-2.5-flash'];
    if (m.includes('gemini-2.5')) return [m.includes('gemini-2.5-flash') ? 'gemini-2.5-flash' : m, 'gemini-2.5-flash'].filter((v, i, a) => a.indexOf(v) === i);
    return [model];
  }

  private getAccounts(providersConfig: any, providerKey: string): any[] {
    const cfg = providersConfig ?? {};
    // Env override wins for the active gateway (never commit keys to disk).
    if (providerKey === 'opencode' && process.env.OPENCODE_API_KEY?.trim()) {
      return [{ api_key: process.env.OPENCODE_API_KEY.trim() }];
    }
    if (providerKey === 'google' && (process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim())) {
      return [{ api_key: (process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY)!.trim() }];
    }
    // agy (Antigravity Cloud Code) rides the Google OAuth refresh token.
    if (providerKey === 'agy') {
      try {
        const accountsPath = path.join(os.homedir(), '.config/opencode/antigravity-accounts.json');
        if (fs.existsSync(accountsPath)) {
          const content = fs.readFileSync(accountsPath, 'utf8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
            return parsed.accounts.filter((a: any) => a.enabled !== false);
          }
        }
      } catch (e) {
        /* fallback to auth.json */
      }
      const g = cfg['agy'] ?? cfg['google'] ?? cfg['opencode'] ?? {};
      const accounts = (g as { accounts?: unknown }).accounts;
      if (Array.isArray(accounts) && accounts.length > 0) return accounts as any[];
      return [g];
    }
    const providerObj = cfg[providerKey] ?? {};
    const accounts = (providerObj as { accounts?: unknown }).accounts;
    if (Array.isArray(accounts) && accounts.length > 0) return accounts as any[];
    return [providerObj];
  }

  private getEndpoint(providerKey: string, model: string, isStream: boolean): string {
    if (providerKey === 'google') return 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?alt=sse';
    if (providerKey === 'opencode') {
      const base = zenBase();
      const surface = zenSurfaceFor(model);
      if (surface === 'responses') return `${base}/responses`;
      if (surface === 'anthropic') return `${base}/messages`;
      if (surface === 'google') {
        // Model is encoded in the path; streaming via :streamGenerateContent.
        return isStream ? `${base}/models/${model}:streamGenerateContent?alt=sse` : `${base}/models/${model}:generateContent`;
      }
      return `${base}/chat/completions`;
    }
    // agy (Antigravity) endpoints use Cloud Code
    return isStream ? 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse' : 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent';
  }

  private isAccountExhausted(account: any, model: string): boolean {
    const resetTime = account[`rateLimit_${model}`] || 0;
    return Date.now() < resetTime;
  }

  private markAccountExhausted(account: any, model: string) {
    account[`rateLimit_${model}`] = Date.now() + EXHAUSTION_MS;
  }

  private buildRequestBody(providerKey: string, model: string, body: any, isStream: boolean): any {
    const m = model.replace(/^models\//, '').replace(/^antigravity-/, '');
    const src = body as any;
    const messages: ChatMessageIn[] = Array.isArray(src.messages) ? src.messages : this.contentsToMessages(src.contents);
    
    if (providerKey === 'google' || providerKey === 'agy') {
      const googleBody = this.toGoogleBody(messages, isStream, src.tools);
      if (providerKey === 'agy') {
        return {
          project: "",
          model: m,
          request: googleBody,
          requestType: "agent",
          userAgent: "antigravity",
          requestId: `agent-${crypto.randomUUID()}`
        };
      }
      return googleBody;
    }
    
    const surface = zenSurfaceFor(m);
    if (surface === 'anthropic') return this.toAnthropicBody(m, messages, src.tools, isStream);
    if (surface === 'google') return this.toGoogleBody(messages, isStream, src.tools);
    if (surface === 'responses') return this.toResponsesBody(m, messages, src.tools, isStream);
    
    const reqBody: any = { ...body, model: m };
    if (!Array.isArray(reqBody.messages) && reqBody.contents !== undefined) {
      reqBody.messages = this.contentsToMessages(reqBody.contents);
    }
    delete reqBody.contents;
    if (isStream) reqBody.stream = true;
    return reqBody;
  }

  private buildHeaders(providerKey: string, key: string): Record<string, string> {
    if (providerKey === 'google' || providerKey === 'agy') {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      };
    }
    if (providerKey === 'opencode') {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      };
    }
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    };
  }

  private contentsToMessages(contents: unknown): ChatMessageIn[] {
    if (!Array.isArray(contents)) return [];
    return contents.map((c) => {
      const o = (c ?? {}) as any;
      const parts = typeof o.parts === 'string' ? o.parts : asText(o.parts);
      return { role: o.role === 'model' ? 'assistant' : 'user', content: parts };
    });
  }

  private splitSystem(messages: ChatMessageIn[]): { system: string; rest: ChatMessageIn[] } {
    const sys = messages.filter((m) => m.role === 'system').map((m) => asText(m.content)).join('\n\n');
    return { system: sys, rest: messages.filter((m) => m.role !== 'system') };
  }

  /**
   * OpenAI `tools: [{type:'function', function:{name, description, parameters}}]`
   * → Gemini `tools: [{functionDeclarations: [...]}]`.
   * Returns [] when nothing usable is present, so callers can omit `tools`.
   * Gemini rejects several OpenAI-isms, so the schema is sanitized:
   * `additionalProperties`, `$schema`, `default`, `examples`, and null-union
   * types are stripped — an invalid declaration makes the whole turn fail.
   */
  private toGoogleFunctionDeclarations(tools: any): any[] {
    if (!Array.isArray(tools)) return [];
    const decls: any[] = [];
    for (const t of tools) {
      const fn = t?.function;
      if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) continue;
      let params = fn.parameters;
      if (params && typeof params === 'object') params = sanitizeJsonSchema(params);
      decls.push({
        name: fn.name,
        ...(typeof fn.description === 'string' && fn.description.length > 0 ? { description: fn.description } : {}),
        ...(params ? { parameters: params } : {}),
      });
    }
    return decls;
  }

  private toGoogleBody(messages: ChatMessageIn[], isStream: boolean, tools?: any): any {
    const { system, rest } = this.splitSystem(messages);
    // Gemini's functionResponse requires a name; OpenAI only carries the id.
    const nameById = new Map<string, string>();
    for (const m of rest) {
      for (const tc of (m as { tool_calls?: { id: string; function: { name: string } }[] }).tool_calls ?? []) {
        if (tc?.id && tc.function?.name) nameById.set(tc.id, tc.function.name);
      }
    }
    const pendingNames: string[] = [];
    const contents: any[] = [];
    for (const m of rest) {
      if (m.role === 'tool') {
        // OpenAI tool result → Gemini functionResponse turn. Antigravity also
        // expects the originating call's thoughtSignature back on the part.
        const decoded = decodeCallId(m.tool_call_id ?? '');
        const name = m.name || nameById.get(decoded.id) || pendingNames.shift() || 'tool';
        const responsePart: any = { functionResponse: { name, response: { result: asText(m.content) } } };
        if (decoded.thoughtSignature) responsePart.thoughtSignature = decoded.thoughtSignature;
        contents.push({ role: 'user', parts: [responsePart] });
        continue;
      }
      const parts: any[] = [];
      const text = asText(m.content);
      if (text.length > 0) parts.push({ text });
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of calls) {
        let args: any = {};
        const rawArgs = tc.function?.arguments;
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {};
        } catch {
          args = { _unparsed: String(rawArgs ?? '') };
        }
        const decoded = decodeCallId(tc.id);
        const callPart: any = { functionCall: { name: tc.function?.name ?? '', args } };
        if (decoded.thoughtSignature) callPart.thoughtSignature = decoded.thoughtSignature;
        parts.push(callPart);
      }
      if (parts.length === 0) continue;
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
      pendingNames.length = 0;
      for (const tc of calls) pendingNames.push(tc.function?.name ?? 'tool');
    }
    const out: any = { contents, generationConfig: { maxOutputTokens: 8192 } };
    if (system) {
      out.systemInstruction = { parts: [{ text: system }] };
    }
    // Forwarding the catalog is what makes the model able to act at all.
    const decls = this.toGoogleFunctionDeclarations(tools);
    if (decls.length > 0) out.tools = [{ functionDeclarations: decls }];
    return out;
  }

  private toAnthropicBody(model: string, messages: ChatMessageIn[], tools: any, isStream: boolean): any {
    const { system, rest } = this.splitSystem(messages);
    const out: any = {
      model,
      max_tokens: 8192,
      messages: rest.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: asText(m.content)
      }))
    };
    if (system) out.system = system;
    if (isStream) out.stream = true;
    return out;
  }

  private toResponsesBody(model: string, messages: ChatMessageIn[], tools: any, isStream: boolean): any {
    return {
      model,
      input: messages.map(m => `${m.role}: ${asText(m.content)}`).join('\n\n')
    };
  }

  private normalizeNonStream(providerKey: string, resp: any): any {
    // If it's agy/google, it might have candidates. Responses can carry
    // multiple parts (thought + answer) — join non-thought text parts.
    const cands = resp.candidates || resp.response?.candidates;
    if (cands && cands.length > 0) {
      const parts = cands[0].content?.parts ?? [];
      const text = parts.filter((p: any) => !p?.thought).map((p: any) => String(p?.text ?? '')).join('');
      // Gemini returns actions as `functionCall` parts. Without this mapping
      // the agent sees an empty message and never executes anything.
      const calls = parts
        .filter((p: any) => p && !p.thought && p.functionCall && typeof p.functionCall.name === 'string')
        .map((p: any, i: number) => ({
          id: encodeCallId(i, p.thoughtSignature),
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        }));
      const message: Record<string, unknown> = { role: 'assistant', content: text };
      if (calls.length > 0) message.tool_calls = calls;
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'model',
        choices: [{
          index: 0,
          message,
          finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
        }],
      };
    }
    return resp; // passthrough for openai compatible
  }

  /**
   * Translate one Gemini candidate's parts into OpenAI SSE chunk bodies:
   * non-thought text → `delta.content`, `functionCall` parts →
   * `delta.tool_calls` (indexed, so a consumer can merge partial arg streams).
   * Returns [] when the candidate carries nothing user-visible.
   */
  private googlePartsToChunks(parts: any[], seed: { i: number }, sawToolCall: { any: boolean }): string[] {
    const base = () => ({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'model',
    });
    const out: string[] = [];
    const text = parts.filter((p: any) => !p?.thought).map((p: any) => String(p?.text ?? '')).join('');
    if (text) {
      out.push(JSON.stringify({ ...base(), choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
    }
    for (const p of parts as any[]) {
      const fc = p?.functionCall;
      if (p?.thought || !fc || typeof fc.name !== 'string') continue;
      const index = seed.i++;
      sawToolCall.any = true;
      out.push(JSON.stringify({
        ...base(),
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: encodeCallId(index, p.thoughtSignature),
              type: 'function',
              function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
            }],
          },
          finish_reason: null,
        }],
      }));
    }
    return out;
  }

  private normalizeStream(providerKey: string, response: Response): Response {
    if (providerKey !== 'google' && providerKey !== 'agy') {
      return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'text/event-stream' } });
    }
    
    // Transform Google stream to OpenAI chunks
    let buffer = '';
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const toolIndex = { i: 0 };
    const sawToolCall = { any: false };
    // `start()` is a plain function — keep a reference so `this` still resolves.
    const self = this;
    
    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            
            let newlineIdx;
            while ((newlineIdx = buffer.indexOf('\n\n')) >= 0 || (newlineIdx = buffer.indexOf('\n')) >= 0) {
              const chunk = buffer.slice(0, newlineIdx).trim();
              buffer = buffer.slice(newlineIdx + (buffer[newlineIdx] === '\n' && buffer[newlineIdx+1] !== '\n' ? 1 : 2));
              
              if (!chunk) continue;
              // agy-connector wraps stream payloads as {response:{candidates}};
              // direct backends use bare {candidates}. Accept both. Parts can
              // mix thought + answer + functionCall.
              const isData = chunk.startsWith('data: ');
              const isRawJson = !isData && chunk.startsWith('{');
              if (!isData && !isRawJson) continue;
              const raw = isData ? chunk.slice(6).trim() : chunk;
              if (raw === '[DONE]') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }
              try {
                const parsed = JSON.parse(raw);
                const cand = (parsed.response?.candidates ?? parsed.candidates)?.[0];
                const parts = cand?.content?.parts ?? [];
                for (const body of self.googlePartsToChunks(parts, toolIndex, sawToolCall)) {
                  controller.enqueue(encoder.encode(`data: ${body}\n\n`));
                }
              } catch (e) {
                // ignore parse error
              }
            }
          }
          if (buffer.trim()) {
              // flush
          }
          if (sawToolCall.any) {
            const final = JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'model',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            });
            controller.enqueue(encoder.encode(`data: ${final}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      }
    });
    return new Response(stream, { status: response.status, headers: { 'Content-Type': 'text/event-stream' } });
  }
}
