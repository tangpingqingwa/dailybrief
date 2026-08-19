export type ClipErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payment_required"
  | "not_found"
  | "no_transcript"
  | "unsupported_platform"
  | "rate_limited"
  | "upstream_blocked"
  | "internal"
  | "clip_down";

export type ClipCue = {
  text: string;
  start: number;
  duration: number | null;
};

export type ClipTranscript = {
  platform: "tiktok" | "reels" | "shorts";
  videoId: string;
  canonicalUrl: string;
  kind: "video" | "slideshow" | "unknown";
  language: string;
  durationMs: number | null;
  author: { handle: string | null; id: string | null };
  metadata: {
    description: string | null;
    createTime: string | null;
    musicTitle: string | null;
  };
  source: "platform_caption" | "platform_asr" | "on_screen";
  transcript: ClipCue[];
};

export type ClipCreatorVideo = {
  videoId: string;
  title: string | null;
  description: string | null;
  author: { handle: string | null; id: string | null };
  lengthText: string | null;
  hasCaptions: boolean | null;
  url: string;
  createTime: string | null;
};

export type ClipCreatorPage = {
  handle: string;
  platform: "tiktok" | "reels" | "shorts";
  videos: ClipCreatorVideo[];
  nextCursor: string | null;
};

export type ClipOk<T> = {
  ok: true;
  data: T;
  cached: boolean;
  creditsCharged: number;
};

export type ClipErr = {
  ok: false;
  code: ClipErrorCode;
  http: number;
  retryable: boolean;
};

export type ClipResult<T> = ClipOk<T> | ClipErr;

export type GetLatestOpts = {
  handle: string;
  platform?: "tiktok";
};

export type GetTranscriptOpts = {
  url?: string;
  videoId?: string;
  lang?: string;
};

export type ClipClient = {
  getLatest(opts: GetLatestOpts): Promise<ClipResult<ClipCreatorPage>>;
  getTranscript(opts: GetTranscriptOpts): Promise<ClipResult<ClipTranscript>>;
};

export type ClipClientConfig = {
  base?: string;
  key?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export const DEFAULT_CLIPAPI_BASE = "https://api.clipapi.dev";
export const CLIP_TIMEOUT_MS = 8_000;

const RETRYABLE_HTTP = new Set([502, 503]);
const KNOWN_CODES = new Set<ClipErrorCode>([
  "invalid_request",
  "unauthorized",
  "payment_required",
  "not_found",
  "no_transcript",
  "unsupported_platform",
  "rate_limited",
  "upstream_blocked",
  "internal",
  "clip_down",
]);

export function normalizeCreatorHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@+/, "").toLowerCase();
  if (normalized === "" || !/^[a-z0-9._]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function createClipClient(config: ClipClientConfig = {}): ClipClient {
  const base = stripSlash(
    config.base ?? process.env.CLIPAPI_BASE ?? DEFAULT_CLIPAPI_BASE,
  );
  const key = config.key ?? process.env.CLIPAPI_KEY ?? "";
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? CLIP_TIMEOUT_MS;
  // Live ClipAPI only with a key or an explicit test override (base/fetch).
  const allowNetwork =
    Boolean(config.fetch) || config.base !== undefined || key !== "";

  return {
    getLatest(opts) {
      const handle = normalizeCreatorHandle(opts.handle);
      if (handle === null) {
        return Promise.resolve(fail("invalid_request", 400, false));
      }
      if (!allowNetwork) {
        return Promise.resolve(fail("clip_down", 503, true));
      }
      return withRetry(() =>
        requestJson(fetchImpl, {
          url: `${base}/v1/creators/${encodeURIComponent(handle)}/latest`,
          key,
          timeoutMs,
          parse: parseCreatorPage,
        }),
      );
    },
    getTranscript(opts) {
      if (
        (opts.url === undefined || opts.url === "") &&
        (opts.videoId === undefined || opts.videoId === "")
      ) {
        return Promise.resolve(fail("invalid_request", 400, false));
      }
      if (!allowNetwork) {
        return Promise.resolve(fail("clip_down", 503, true));
      }
      const query = new URLSearchParams();
      if (opts.url !== undefined && opts.url !== "") {
        query.set("url", opts.url);
      }
      if (opts.videoId !== undefined && opts.videoId !== "") {
        query.set("video_id", opts.videoId);
      }
      if (opts.lang !== undefined && opts.lang !== "") {
        query.set("lang", opts.lang);
      }
      return withRetry(() =>
        requestJson(fetchImpl, {
          url: `${base}/v1/transcript?${query}`,
          key,
          timeoutMs,
          parse: parseTranscript,
        }),
      );
    },
  };
}

export function joinCues(cues: readonly ClipCue[]): string {
  return cues
    .map((cue) => cue.text.trim())
    .filter((text) => text.length > 0)
    .join(" ");
}

async function withRetry<T>(
  once: () => Promise<ClipResult<T>>,
): Promise<ClipResult<T>> {
  let last: ClipResult<T> = fail("clip_down", 503, true);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await once();
    if (last.ok) {
      return last;
    }
    if (!last.retryable && !RETRYABLE_HTTP.has(last.http)) {
      return last;
    }
  }
  return last;
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  args: {
    url: string;
    key: string;
    timeoutMs: number;
    parse: (value: unknown) => T | null;
  },
): Promise<ClipResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (args.key !== "") {
    headers.authorization = `Bearer ${args.key}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(args.url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch {
    return fail("clip_down", 503, true);
  }

  let body: unknown = null;
  const raw = await response.text();
  if (raw !== "") {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return fail(
        response.status >= 500 ? "clip_down" : "internal",
        response.status || 503,
        response.status >= 500,
      );
    }
  }

  return parseClipEnvelope(response.status, body, args.parse);
}

export function parseClipEnvelope<T>(
  http: number,
  body: unknown,
  parse: (value: unknown) => T | null,
): ClipResult<T> {
  if (http === 200) {
    const rec = record(body);
    const data = parse(rec?.data);
    if (data === null) {
      return fail("internal", 502, true);
    }
    const meta = record(rec?.meta);
    return {
      ok: true,
      data,
      cached: Boolean(meta?.cached),
      creditsCharged:
        typeof meta?.creditsCharged === "number" ? meta.creditsCharged : 0,
    };
  }

  const err = record(record(body)?.error);
  const code = knownCode(err?.code, http);
  return fail(code, http || 503, isRetryable(code, http));
}

function parseCreatorPage(value: unknown): ClipCreatorPage | null {
  const data = record(value);
  if (data === null || !Array.isArray(data.videos)) {
    return null;
  }
  const videos: ClipCreatorVideo[] = [];
  for (const item of data.videos) {
    const video = parseCreatorVideo(item);
    if (video === null) {
      return null;
    }
    videos.push(video);
  }
  const platform = data.platform;
  return {
    handle: typeof data.handle === "string" ? data.handle : "",
    platform:
      platform === "reels" || platform === "shorts" || platform === "tiktok"
        ? platform
        : "tiktok",
    videos,
    nextCursor: stringOrNull(data.nextCursor),
  };
}

function parseCreatorVideo(value: unknown): ClipCreatorVideo | null {
  const data = record(value);
  if (data === null) {
    return null;
  }
  if (typeof data.videoId !== "string" || data.videoId === "") {
    return null;
  }
  if (typeof data.url !== "string" || data.url === "") {
    return null;
  }
  const author = record(data.author);
  return {
    videoId: data.videoId,
    title: stringOrNull(data.title),
    description: stringOrNull(data.description),
    author: {
      handle: stringOrNull(author?.handle),
      id: stringOrNull(author?.id),
    },
    lengthText: stringOrNull(data.lengthText),
    hasCaptions: typeof data.hasCaptions === "boolean" ? data.hasCaptions : null,
    url: data.url,
    createTime: stringOrNull(data.createTime),
  };
}

function parseTranscript(value: unknown): ClipTranscript | null {
  const data = record(value);
  if (data === null) {
    return null;
  }
  if (typeof data.videoId !== "string" || data.videoId === "") {
    return null;
  }
  if (!Array.isArray(data.transcript)) {
    return null;
  }

  const cues: ClipCue[] = [];
  for (const item of data.transcript) {
    const cue = record(item);
    if (cue === null || typeof cue.text !== "string" || typeof cue.start !== "number") {
      return null;
    }
    cues.push({
      text: cue.text,
      start: cue.start,
      duration: typeof cue.duration === "number" ? cue.duration : null,
    });
  }

  const author = record(data.author);
  const metadata = record(data.metadata);
  const kind = data.kind;
  const source = data.source;
  const platform = data.platform;

  return {
    platform:
      platform === "reels" || platform === "shorts" || platform === "tiktok"
        ? platform
        : "tiktok",
    videoId: data.videoId,
    canonicalUrl: typeof data.canonicalUrl === "string" ? data.canonicalUrl : "",
    kind:
      kind === "slideshow" || kind === "video" || kind === "unknown"
        ? kind
        : "unknown",
    language: typeof data.language === "string" ? data.language : "en",
    durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
    author: {
      handle: stringOrNull(author?.handle),
      id: stringOrNull(author?.id),
    },
    metadata: {
      description: stringOrNull(metadata?.description),
      createTime: stringOrNull(metadata?.createTime),
      musicTitle: stringOrNull(metadata?.musicTitle),
    },
    source:
      source === "platform_caption" ||
      source === "platform_asr" ||
      source === "on_screen"
        ? source
        : "platform_caption",
    transcript: cues,
  };
}

function fail(code: ClipErrorCode, http: number, retryable: boolean): ClipErr {
  return { ok: false, code, http, retryable };
}

function knownCode(value: unknown, http: number): ClipErrorCode {
  if (typeof value === "string" && KNOWN_CODES.has(value as ClipErrorCode)) {
    return value as ClipErrorCode;
  }
  return http >= 500 ? "clip_down" : "internal";
}

function isRetryable(code: ClipErrorCode, http: number): boolean {
  return (
    code === "rate_limited" ||
    code === "upstream_blocked" ||
    code === "internal" ||
    code === "clip_down" ||
    RETRYABLE_HTTP.has(http)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stripSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
