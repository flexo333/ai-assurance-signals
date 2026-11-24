// AWS Lambda entry (nodejs22.x, ap-southeast-2): runs the source check from an
// Australian AWS IP, to test whether .gov.au sites that block GitHub's US
// runners accept Sydney traffic. Invoked only by the CI infra role (no
// Function URL, so it can't be used as an open fetch proxy).
//
// Event:  { sources: [...] }   (the parsed sources.yaml list, sent by the workflow)
// Result: { generatedAt, location, egressIp, userAgent, results }

import { runCheck, USER_AGENT } from "../source-check.mjs";

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
  const generatedAt = new Date().toISOString();
  const [ip, results] = await Promise.all([egressIp(), runCheck(event.sources, { concurrency: 8 })]);
  return {
    generatedAt,
    location: `AWS Lambda ${process.env.AWS_REGION}${ip ? ` (${ip})` : ""}`,
    egressIp: ip,
    userAgent: USER_AGENT,
    results,
  };
};
