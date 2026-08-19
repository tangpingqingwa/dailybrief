import { firstWords } from "../../summary/fake.js";

export const EMPTY_BODY_LINE = "Nothing new yesterday";
export const DELAYED_HEADLINE =
  "Some sources were delayed (ClipAPI unavailable). No scrape fallback.";
export const CLIPAPI_LINK = "https://api.clipapi.dev";
export const READ_SOURCE_LABEL = "Read source";

export type DailyItemBlock = {
  sourceLabel: string;
  title: string;
  summary: string;
  url: string;
};

export type DailyTemplateInput = {
  weekday: string;
  items: DailyItemBlock[];
  delayedLabels: string[];
  trial: boolean;
  unsubUrl: string;
  manageUrl: string;
  clipApiUrl?: string;
};

export type RenderedDailyEmail = {
  subject: string;
  text: string;
  html: string;
};

export function dailySubject(input: Pick<DailyTemplateInput, "weekday" | "items">): string {
  if (input.items.length === 0) {
    return `DailyBrief — ${input.weekday}`;
  }
  return `DailyBrief — ${input.items.length} new from your sources`;
}

export function renderDailyEmail(input: DailyTemplateInput): RenderedDailyEmail {
  const clipApiUrl = input.clipApiUrl ?? CLIPAPI_LINK;
  const subject = dailySubject(input);
  const items = input.items.map((item) => ({
    ...item,
    summary: firstWords(item.summary),
  }));

  const textParts: string[] = [subject, ""];
  if (items.length === 0) {
    textParts.push(EMPTY_BODY_LINE, "");
  } else {
    for (const item of items) {
      textParts.push(
        item.sourceLabel,
        item.title,
        item.summary,
        `${READ_SOURCE_LABEL}: ${item.url}`,
        "",
      );
    }
  }
  if (input.delayedLabels.length > 0) {
    textParts.push(DELAYED_HEADLINE);
    for (const label of input.delayedLabels) {
      textParts.push(`- ${label}: source delayed`);
    }
    textParts.push("");
  }
  textParts.push(
    `Unsubscribe: ${input.unsubUrl}`,
    `Manage sources: ${input.manageUrl}`,
    `Powered by the same APIs we sell — ClipAPI ${clipApiUrl}`,
  );
  if (input.trial) {
    textParts.push("trial");
  }

  const blocks: string[] = [];
  if (items.length === 0) {
    blocks.push(`<p>${escapeHtml(EMPTY_BODY_LINE)}</p>`);
  } else {
    for (const item of items) {
      blocks.push(`<section>
  <p>${escapeHtml(item.sourceLabel)}</p>
  <h2>${escapeHtml(item.title)}</h2>
  <p>${escapeHtml(item.summary)}</p>
  <p><a href="${escapeHtml(item.url)}">${READ_SOURCE_LABEL}</a></p>
</section>`);
    }
  }
  if (input.delayedLabels.length > 0) {
    const lis = input.delayedLabels
      .map((label) => `<li>${escapeHtml(label)}: source delayed</li>`)
      .join("");
    blocks.push(`<p>${escapeHtml(DELAYED_HEADLINE)}</p><ul>${lis}</ul>`);
  }

  const trialLine = input.trial ? "<p>trial</p>" : "";
  const html = `<!doctype html>
<html>
<body>
<h1>DailyBrief</h1>
${blocks.join("\n")}
<footer>
${trialLine}
<p><a href="${escapeHtml(input.unsubUrl)}">Unsubscribe</a></p>
<p><a href="${escapeHtml(input.manageUrl)}">Manage sources</a></p>
<p>Powered by the same APIs we sell — <a href="${escapeHtml(clipApiUrl)}">ClipAPI</a></p>
</footer>
</body>
</html>
`;

  return { subject, text: textParts.join("\n"), html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
