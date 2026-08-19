export const SESSION_COOKIE = "db_session";

export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (header === undefined || header === "") {
    return null;
  }
  for (const part of header.split(";")) {
    const cut = part.indexOf("=");
    if (cut === -1) {
      continue;
    }
    if (part.slice(0, cut).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(cut + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function serializeSessionCookie(
  token: string,
  options: { maxAgeSec: number; secure: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSec}`,
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearSessionCookie(options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
