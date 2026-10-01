// Generates data/report.json for the large-data-converter scenario: a pretty-printed incident
// export of about 4.4 MB (some 95K lines), far more than fits in the model's context, so the
// agent has to look at its structure in parts and let its script read the file. Deterministic.

import fs from "node:fs";
import path from "node:path";

export const REPORT_ITEMS = 1200;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS =
  "service latency queue worker retry timeout cache disk memory node cluster deploy rollback config certificate token gateway upstream database index replica backup alert threshold metric dashboard pager customer region network packet loss spike throughput batch job schedule".split(
    " ",
  );
const TEAMS = ["platform", "payments", "search", "identity", "storage", "edge", "data", "mobile"];
const PEOPLE = ["A. Moreau", "B. Okafor", "C. Lindqvist", "D. Tanaka", "E. Novak", "F. Haddad", "G. Silva", "H. Kowalski", "I. Mensah", "J. Rossi"];

export function generateReportJson(repo: string, seed = 4711): void {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const sentence = (n: number) => {
    const w = Array.from({ length: n }, () => pick(WORDS));
    return `${w[0][0].toUpperCase()}${w.join(" ").slice(1)}.`;
  };
  const day = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset * 3_600_000).toISOString();
  const items = Array.from({ length: REPORT_ITEMS }, (_, i) => {
    const opened = Math.floor(r() * 6000);
    const timeline = Array.from({ length: 6 + Math.floor(r() * 10) }, (_, k) => ({ at: day(opened + k * 2), by: pick(PEOPLE), note: sentence(10 + Math.floor(r() * 14)) }));
    return {
      id: `INC-${10000 + i}`,
      title: sentence(4 + Math.floor(r() * 5)).replace(/\.$/, ""),
      severity: pick(["sev1", "sev2", "sev3", "sev4"]),
      status: pick(["open", "mitigated", "resolved", "resolved", "closed"]),
      owner: { name: pick(PEOPLE), team: pick(TEAMS) },
      opened: day(opened),
      closed: r() < 0.7 ? day(opened + 4 + Math.floor(r() * 90)) : null,
      tags: Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(WORDS)),
      impact: { customers: Math.floor(r() * 5000), regions: Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(["eu-west", "eu-north", "us-east", "us-west", "ap-south"])) },
      summary: Array.from({ length: 3 }, () => sentence(18 + Math.floor(r() * 20))).join(" "),
      timeline,
    };
  });
  const doc = { export: { source: "incident-tracker", generated: "2026-09-30T02:00:00Z", schema: 3, item_count: items.length }, items };
  const file = path.join(repo, "data", "report.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}
