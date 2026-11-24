/**
 * Live check against a real GitHub repo, skipped by default.
 * Run with: VOXIUM_LIVE=vuejs/vue-hackernews-2.0 npx vitest run src/lib/live.test.ts
 * Optional VOXIUM_GITHUB_TOKEN raises rate limits and allows private repos.
 */
import { describe, expect, it } from "vitest";
import { checkPullRequest, prepareSetup, wantFile } from "./analysis";
import { fetchTarball } from "./github";
import { readTarGz } from "./tar";

const target = process.env.VOXIUM_LIVE;

describe.runIf(Boolean(target))("live GitHub repo", () => {
  it("downloads the real tarball, plans a setup and passes its own baseline", async () => {
    const t0 = Date.now();
    const stream = await fetchTarball(process.env.VOXIUM_GITHUB_TOKEN ?? "", target!, "HEAD");
    const files = await readTarGz(stream, { want: wantFile });
    const plan = prepareSetup(files);
    const rules = {
      "voxium/architecture.json": plan.setupFiles["voxium/architecture.json"],
      "voxium/baseline.json": plan.setupFiles["voxium/baseline.json"],
    };
    const res = checkPullRequest({ headFiles: files, treePaths: Object.keys(files), base: rules, mergeBase: rules, head: rules });
    console.log(
      JSON.stringify(
        {
          repo: target,
          ms: Date.now() - t0,
          filesKept: Object.keys(files).length,
          layers: plan.summary.layers,
          confidence: Number(plan.summary.confidence.toFixed(2)),
          baseline: plan.baselineCount,
          check: res.state,
        },
        null,
        2,
      ),
    );
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(res.state).toBe("success");
  }, 120_000);
});
