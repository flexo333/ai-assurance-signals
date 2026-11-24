// AWS Lambda entry (nodejs22.x, ap-southeast-2). All outbound fetching runs
// here, from an Australian AWS IP (reaches more AU sources than GitHub's US
// runners). Invoked only by the CI infra role — no Function URL, so it can't
// be used as an open fetch proxy.
//
//   { action: "source-check", sources }               → source-check report
//   { action: "collect", sources, knownIds, sinceDays, maxItems } → raw collected items

import { runCheck, USER_AGENT } from "../source-check.mjs";
import { runCollect } from "../collect.mjs";

async function egressIp() {
  try {
    const r = await fetch("https://checkip.amazonaws.com/", { signal: AbortSignal.timeout(5000) });
    return (await r.text()).trim();
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  if (!Array.isArray(event?.sources)) throw new Error("event.sources must be an array");
  const action = event.action || "source-check";
  const generatedAt = new Date().toISOString();
  const ip = await egressIp();
  const location = `AWS Lambda ${process.env.AWS_REGION}${ip ? ` (${ip})` : ""}`;

  if (action === "source-check") {
    const results = await runCheck(event.sources, { concurrency: 8 });
    return { generatedAt, location, egressIp: ip, userAgent: USER_AGENT, results };
  }
  if (action === "collect") {
    const out = await runCollect({ sources: event.sources, knownIds: event.knownIds, sinceDays: event.sinceDays, maxItems: event.maxItems });
    return { generatedAt, location, egressIp: ip, userAgent: USER_AGENT, ...out };
  }
  throw new Error(`unknown action: ${action}`);
};
