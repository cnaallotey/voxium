import { describe, expect, it } from "vitest";
import { buildGraphFromFiles, checkArchitecture, type Architecture, type FileMap } from "./index.js";

/** A project with every form of import that was seen before the scanner was rewritten, and the ids that led to. */
const FILES: FileMap = {
  "src/ui/page.tsx": `"use client";
import React, { useState } from "react";
import { query } from "@/data/db";
import type { Row } from "../data/types.js";
export default function Page() {
  // import "../data/nothing"
  return <div title="a > b">{useState<Row>(query("it's"))} it's {/* x */}</div>;
}
`,
  "src/ui/lazy.js": `const a = () => import("../core/lazy");\nconst b = require('../data/legacy');\nmodule.exports = { a, b };\n`,
  "src/ui/Card.vue": `<template>\n  <p>{{ x < 1 }}</p>\n</template>\n\n<script setup lang="ts">\nimport { x } from "../core/x";\nimport pg from "pg";\n</script>\n<script>export default { name: "Card" }</script>\n`,
  "src/core/index.ts": `export * from "./x";\nexport { lazy } from "./lazy";\nexport type { Row } from "~/data/types";\nexport * as ui from "../ui/lazy.js";\n`,
  "src/core/x.ts": `import "./lazy";\nimport {\n  a,\n  // not this\n  b,\n} from "../ui/page";\nimport fs from "node:fs";\nimport path from "path";\nimport _ from "lodash/fp";\nimport { S } from "@aws-sdk/client-s3/dist";\nexport const x = /["']/.test(a) ? \`\${b}\` : 1;\n`,
  "src/core/lazy.mjs": `import { go } from '../outside/helper.js'\nimport other from "../outside/other";\nexport const lazy = go / 2;\n`,
  "src/core/x.test.ts": `import { x } from "./x";\nimport { page } from "../ui/page";\nimport { helper } from "../outside/helper";\n`,
  "src/data/db.ts": `import { Client } from "pg";\nimport { x } from "../core/x";\nexport const query = (s: string): Client => new Client(s, x);\n`,
  "src/data/types.ts": `import ui = require("../ui/page");\nexport type Row = import("../core/x").X;\n`,
  "src/data/legacy.cjs": `var helper = require( "../outside/helper" );\nvar pkg = require("react");\nexports.run = function () { return helper };\n`,
  "src/outside/helper.ts": `export { page } from "../ui/page";\nexport { x } from "./deep";\n`,
  "src/outside/deep.ts": `import "../data/db";\nimport "react";\n`,
  "src/outside/other.ts": `export {};\n`,
};

const ARCH: Architecture = {
  version: 1,
  modules: { ui: { paths: ["src/ui/**"] }, core: { paths: ["src/core/**"] }, data: { paths: ["src/data/**"] } },
  layers: ["ui", "core", "data"],
  rules: [
    { id: "LAYER01", type: "layers", description: "d", rationale: "r", severity: "block" },
    { id: "CYCLE01", type: "no_cycles", description: "d", rationale: "r", severity: "block" },
    { id: "DENY01", type: "deny_dependency", from: "ui", to: "data", description: "d", rationale: "r", severity: "block" },
    { id: "EXT01", type: "deny_external", module: "ui", packages: ["pg", "react"], description: "d", rationale: "r", severity: "block" },
    { id: "EXT02", type: "deny_external", module: "core", packages: ["path", "fs", "lodash", "@aws-sdk/client-s3", "react"], description: "d", rationale: "r", severity: "block" },
    { id: "EXT03", type: "deny_external", module: "data", packages: ["pg", "react"], description: "d", rationale: "r", severity: "block" },
    { id: "SIZE01", type: "max_file_lines", max: 8, description: "d", rationale: "r", severity: "warn" },
  ],
  exceptions: [],
};

/** What the scanner before this one led to. Baselines of real projects hold such ids, so none of them may change. */
const BEFORE: Record<string, number | null> = {
  "LAYER01:src/core/index.ts->src/ui/lazy.js": 4,
  "LAYER01:src/core/lazy.mjs->src/outside/helper.ts=>ui": 1,
  "EXT02:src/core/lazy.mjs->src/outside/helper.ts=>react": 1,
  "LAYER01:src/core/x.test.ts->src/ui/page.tsx": 2,
  "LAYER01:src/core/x.ts->src/ui/page.tsx": 6,
  "EXT02:src/core/x.ts->path": 8,
  "EXT02:src/core/x.ts->lodash": 9,
  "EXT02:src/core/x.ts->@aws-sdk/client-s3": 10,
  "EXT03:src/data/db.ts->pg": 1,
  "LAYER01:src/data/db.ts->src/core/x.ts": 2,
  "LAYER01:src/data/legacy.cjs->src/outside/helper.ts=>ui": 1,
  "EXT03:src/data/legacy.cjs->src/outside/helper.ts=>react": 1,
  "EXT03:src/data/legacy.cjs->react": 2,
  "LAYER01:src/data/types.ts->src/ui/page.tsx": 1,
  "LAYER01:src/data/types.ts->src/core/x.ts": 2,
  "EXT01:src/ui/Card.vue->pg": 7,
  "DENY01:src/ui/lazy.js->src/data/legacy.cjs": 2,
  "EXT01:src/ui/page.tsx->react": 2,
  "DENY01:src/ui/page.tsx->src/data/db.ts": 3,
  "DENY01:src/ui/page.tsx->src/data/types.ts": 4,
  "CYCLE01:core+data+ui": 2,
  "SIZE01:src/core/x.ts": null,
  "SIZE01:src/ui/Card.vue": null,
  "SIZE01:src/ui/page.tsx": null,
};

describe("ids in existing baselines", () => {
  const { violations } = checkArchitecture(ARCH, buildGraphFromFiles(FILES));

  it("are all still produced, at the same line", () => {
    expect(Object.fromEntries(violations.map((v) => [v.id, v.line ?? null]))).toMatchObject(BEFORE);
  });

  it("are joined only by what was not seen before", () => {
    // "node:fs" is the package "fs", which import resolution made visible on purpose.
    const REVEALED = ["EXT02:src/core/x.ts->fs"];
    expect(violations.map((v) => v.id).filter((id) => !(id in BEFORE))).toEqual(REVEALED);
  });
});
