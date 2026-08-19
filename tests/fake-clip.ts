import type {
  ClipClient,
  ClipCreatorPage,
  ClipCreatorVideo,
  ClipCue,
  ClipErrorCode,
  ClipResult,
  ClipTranscript,
  GetLatestOpts,
  GetTranscriptOpts,
} from "../src/clients/clip.js";
import { normalizeCreatorHandle } from "../src/clients/clip.js";

export const ALICE = "alice";
export const BOB = "bob";
export const ALICE_VIDEO_1 = "7123456789012345678";
export const ALICE_VIDEO_2 = "7123456789012345679";
export const ALICE_NO_CAPTION = "7987654321098765432";
export const BOB_VIDEO_1 = "8123456789012345678";

export const ALICE_CUES: ClipCue[] = [
  { text: "Stop fighting TikTok blocks.", start: 0, duration: 2.1 },
  { text: "One credit, one JSON transcript.", start: 2.1, duration: 2.4 },
];

export const BOB_CUES: ClipCue[] = [
  { text: "A second creator posted this morning.", start: 0, duration: 3 },
];

export type FakeClipOptions = {
  latest?: Record<string, ClipCreatorVideo[] | ClipErrorCode>;
  transcripts?: Record<string, ClipTranscript | ClipErrorCode>;
};

export type FakeClip = ClipClient & {
  latestCalls: string[];
  transcriptCalls: string[];
};

export function tiktokUrl(handle: string, videoId: string): string {
  return `https://www.tiktok.com/@${handle}/video/${videoId}`;
}

export function creatorVideo(
  handle: string,
  videoId: string,
  overrides: Partial<ClipCreatorVideo> = {},
): ClipCreatorVideo {
  return {
    videoId,
    title: overrides.title ?? `Video ${videoId}`,
    description: overrides.description ?? `Description for ${videoId}`,
    author: overrides.author ?? { handle, id: `user_${handle}` },
    lengthText: overrides.lengthText ?? "0:08",
    hasCaptions: overrides.hasCaptions ?? true,
    url: overrides.url ?? tiktokUrl(handle, videoId),
    createTime: overrides.createTime ?? "2026-08-18T12:00:00.000Z",
  };
}

export function transcriptFor(
  handle: string,
  videoId: string,
  cues: ClipCue[],
  overrides: Partial<ClipTranscript> = {},
): ClipTranscript {
  return {
    platform: "tiktok",
    videoId,
    canonicalUrl: tiktokUrl(handle, videoId),
    kind: "video",
    language: "en",
    durationMs: 8_400,
    author: { handle, id: `user_${handle}` },
    metadata: {
      description: `Description for ${videoId}`,
      createTime: "2026-08-18T12:00:00.000Z",
      musicTitle: "Original sound",
    },
    source: "platform_caption",
    transcript: cues,
    ...overrides,
  };
}

export function createFakeClip(options: FakeClipOptions = {}): FakeClip {
  const latest: Record<string, ClipCreatorVideo[] | ClipErrorCode> = {
    [ALICE]: [
      creatorVideo(ALICE, ALICE_VIDEO_1, {
        title: "Stop fighting TikTok blocks.",
        description: "Recorded caption fixture.",
        createTime: "2026-08-18T11:00:00.000Z",
      }),
      creatorVideo(ALICE, ALICE_NO_CAPTION, {
        title: "No captions today",
        description: "A public video with no caption track at all.",
        hasCaptions: false,
        createTime: "2026-08-18T10:00:00.000Z",
      }),
    ],
    [BOB]: [
      creatorVideo(BOB, BOB_VIDEO_1, {
        title: "Morning clip",
        createTime: "2026-08-18T13:00:00.000Z",
      }),
    ],
    ...options.latest,
  };

  const transcripts: Record<string, ClipTranscript | ClipErrorCode> = {
    [ALICE_VIDEO_1]: transcriptFor(ALICE, ALICE_VIDEO_1, ALICE_CUES, {
      metadata: {
        description: "Recorded caption fixture.",
        createTime: "2026-08-18T11:00:00.000Z",
        musicTitle: "Original sound",
      },
    }),
    [ALICE_NO_CAPTION]: "no_transcript",
    [BOB_VIDEO_1]: transcriptFor(BOB, BOB_VIDEO_1, BOB_CUES),
    ...options.transcripts,
  };

  const latestCalls: string[] = [];
  const transcriptCalls: string[] = [];

  return {
    latestCalls,
    transcriptCalls,
    async getLatest(opts: GetLatestOpts): Promise<ClipResult<ClipCreatorPage>> {
      const handle = normalizeCreatorHandle(opts.handle);
      if (handle === null) {
        return fail("invalid_request", 400, false);
      }
      latestCalls.push(handle);
      const entry = latest[handle];
      if (entry === undefined) {
        return fail("not_found", 404, false);
      }
      if (typeof entry === "string") {
        return fail(entry, httpFor(entry), isRetryable(entry));
      }
      return {
        ok: true,
        data: {
          handle,
          platform: "tiktok",
          videos: entry,
          nextCursor: null,
        },
        cached: false,
        creditsCharged: 0,
      };
    },
    async getTranscript(
      opts: GetTranscriptOpts,
    ): Promise<ClipResult<ClipTranscript>> {
      const videoId = opts.videoId ?? "";
      if (videoId === "") {
        return fail("invalid_request", 400, false);
      }
      transcriptCalls.push(videoId);
      const entry = transcripts[videoId];
      if (entry === undefined) {
        return fail("not_found", 404, false);
      }
      if (typeof entry === "string") {
        return fail(entry, httpFor(entry), isRetryable(entry));
      }
      return {
        ok: true,
        data: entry,
        cached: false,
        creditsCharged: 1,
      };
    },
  };
}

function fail(
  code: ClipErrorCode,
  http: number,
  retryable: boolean,
): ClipResult<never> {
  return { ok: false, code, http, retryable };
}

function httpFor(code: ClipErrorCode): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "unauthorized":
      return 401;
    case "payment_required":
      return 402;
    case "not_found":
      return 404;
    case "no_transcript":
    case "unsupported_platform":
      return 422;
    case "rate_limited":
      return 429;
    case "clip_down":
    case "upstream_blocked":
      return 503;
    default:
      return 500;
  }
}

function isRetryable(code: ClipErrorCode): boolean {
  return (
    code === "rate_limited" ||
    code === "upstream_blocked" ||
    code === "internal" ||
    code === "clip_down"
  );
}
