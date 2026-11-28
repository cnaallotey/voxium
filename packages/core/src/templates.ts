import { compileGlob, compileGlobs } from "./glob.js";
import { defaultRules, detectBuildOutput, sanitize } from "./infer.js";
import type { Architecture, ModuleDef } from "./types.js";

export const TEMPLATE_NAMES = ["layered", "hexagonal", "feature_sliced", "modular_monolith", "next", "nuxt"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export function isTemplateName(name: unknown): name is TemplateName {
  return typeof name === "string" && (TEMPLATE_NAMES as readonly string[]).includes(name);
}

/** A module a template expects, top to bottom, and the folder names it goes by, at the root or under src/. */
interface Slot {
  name: string;
  folders: string[];
  description: string;
}

const SHARED: Slot = { name: "shared", folders: ["shared", "common", "utils", "lib"], description: "Code every other module may use" };

const LAYERS: Record<Exclude<TemplateName, "modular_monolith">, Slot[]> = {
  layered: [
    { name: "presentation", folders: ["presentation", "ui", "views", "pages", "components", "controllers", "routes"], description: "What users and clients talk to" },
    { name: "application", folders: ["application", "services", "service", "usecases", "use-cases"], description: "Use cases that coordinate the domain" },
    { name: "domain", folders: ["domain", "model", "models", "entities"], description: "Business rules and the model" },
    { name: "infrastructure", folders: ["infrastructure", "infra", "data", "db", "persistence", "repositories"], description: "Storage and other systems" },
    SHARED,
  ],
  hexagonal: [
    { name: "adapters", folders: ["adapters", "infrastructure", "infra"], description: "Adapters that connect ports to the outside world" },
    { name: "application", folders: ["application", "usecases", "use-cases", "services"], description: "Use cases, driven through the ports" },
    { name: "ports", folders: ["ports"], description: "Interfaces the core offers and needs" },
    { name: "domain", folders: ["domain", "core", "model"], description: "The core: business rules that know no adapter" },
    { name: "shared", folders: ["shared", "common"], description: "Code every other module may use" },
  ],
  feature_sliced: [
    { name: "app", folders: ["app"], description: "App setup: providers, routing, global styles" },
    { name: "processes", folders: ["processes"], description: "Flows that span several pages" },
    { name: "pages", folders: ["pages"], description: "Whole pages" },
    { name: "widgets", folders: ["widgets"], description: "Large blocks of a page" },
    { name: "features", folders: ["features"], description: "User interactions that bring value" },
    { name: "entities", folders: ["entities"], description: "Business entities" },
    { name: "shared", folders: ["shared"], description: "Reusable code with no business logic" },
  ],
  next: [
    { name: "app", folders: ["app"], description: "App Router routes, layouts and route handlers" },
    { name: "pages", folders: ["pages"], description: "Pages Router routes and API routes" },
    { name: "components", folders: ["components"], description: "React components" },
    { name: "hooks", folders: ["hooks"], description: "React hooks" },
    { name: "lib", folders: ["lib", "utils", "helpers"], description: "Helpers and clients without React" },
    { name: "types", folders: ["types"], description: "Shared types" },
  ],
  nuxt: [
    { name: "pages", folders: ["pages"], description: "Routes" },
    { name: "layouts", folders: ["layouts"], description: "Layouts" },
    { name: "middleware", folders: ["middleware"], description: "Route middleware" },
    { name: "plugins", folders: ["plugins"], description: "Nuxt plugins" },
    { name: "components", folders: ["components"], description: "Vue components" },
    { name: "composables", folders: ["composables"], description: "Composables" },
    { name: "stores", folders: ["stores", "store"], description: "State stores" },
    { name: "server", folders: ["server"], description: "Server routes and server only code" },
    { name: "utils", folders: ["utils", "shared"], description: "Helpers every other module may use" },
  ],
};

/** Feature-Sliced layers whose slices are used only through their index file. */
const SLICED = ["widgets", "features", "entities"];
/** Folders that hold one folder per module of a modular monolith. */
const MODULE_GROUPS = ["modules", "domains", "contexts"];
/** Nuxt modules whose code reaches the browser, so they must not import server code. */
const NUXT_CLIENT = ["pages", "layouts", "middleware", "plugins", "components", "composables", "stores"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/** The globs of a slot that match a file, at the root and under src/ (and app/, where Nuxt 4 keeps its code). */
function globsFor(folders: string[], files: string[], roots = ["", "src/"]): string[] {
  return folders.flatMap((f) => roots.map((r) => `${r}${f}/**`)).filter((g) => {
    const matches = compileGlob(g);
    return files.some(matches);
  });
}

/** Entry files of each slice of a module, such as src/features/x/index.ts. */
function sliceEntries(paths: string[]): string[] {
  return paths.flatMap((p) => INDEX_FILES.map((f) => `${p.slice(0, -"**".length)}*/${f}`));
}

/**
 * A draft architecture from a template, for the files of a repo. Only modules that match at least one file are in it, and
 * each of their globs matches one. Committed build output is ignored as inference ignores it, and `extra` adds ignored
 * files and aliases, such as those inference found. Pure, and the same for the same files.
 */
export function applyTemplate(name: TemplateName, files: string[], extra: Pick<Architecture, "ignore" | "aliases"> = {}): Architecture {
  if (!isTemplateName(name)) throw new Error(`Unknown template "${String(name).slice(0, 40)}". Templates: ${TEMPLATE_NAMES.join(", ")}.`);
  const ignore = [...new Set([...detectBuildOutput(files), ...(extra.ignore ?? [])])].sort();
  const isIgnored = compileGlobs(ignore);
  const code = files.filter((f) => !isIgnored(f));
  const modules: Record<string, ModuleDef> = {};
  const add = (n: string, paths: string[], description: string) => {
    if (paths.length) modules[n] = { paths, description };
  };

  const slots = name === "modular_monolith" ? [] : LAYERS[name];
  if (name === "modular_monolith") {
    add("app", globsFor(["app", "main", "bootstrap"], code), "Wires the modules together and starts the app");
    // Two folders can give the same name (src/modules/a-b and src/modules/a_b), so a name is never given twice.
    const taken = (n: string) => Object.hasOwn(modules, n) || n === "shared" || n === "app";
    for (const [folder, paths] of moduleFolders(code)) {
      let n = sanitize(folder.split("/").pop()!);
      if (taken(n)) n = sanitize(folder);
      for (let k = 2, base = n; taken(n); k++) n = `${base}_${k}`;
      add(n, paths, `The ${folder.split("/").pop()} module`);
    }
    const inModule = compileGlobs(Object.values(modules).flatMap((m) => m.paths));
    add("shared", globsFor(SHARED.folders, code.filter((f) => !inModule(f))), SHARED.description);
  } else {
    // A file goes to the first module whose globs match it, so a folder a higher slot names is not offered again below.
    for (const s of slots) {
      const taken = Object.values(modules).flatMap((m) => m.paths);
      const roots = name === "nuxt" && s.name !== "server" ? ["", "src/", "app/"] : undefined;
      add(s.name, globsFor(s.folders, code, roots).filter((g) => !taken.includes(g)), `${s.description}.`);
    }
  }

  const layers = Object.keys(modules);
  const rules = defaultRules(layers);
  if (name === "modular_monolith") {
    rules[0] = {
      ...rules[0],
      rationale: `${rules[0].rationale} The modules start in alphabetical order: put each above the modules it may use.`,
    };
    for (const m of layers.filter((m) => m !== "app" && m !== "shared")) {
      rules.push({
        id: `API_${m.toUpperCase()}`,
        type: "public_api",
        module: m,
        entries: INDEX_FILES.flatMap((f) => modules[m].paths.map((p) => `${p.slice(0, -"**".length)}${f}`)),
        severity: "block",
        description: `Other modules use ${m} only through its index file.`,
        rationale: "A module that is only used through its entry point can change inside without breaking the others, and can be split out later.",
      });
    }
  }
  if (name === "feature_sliced") {
    for (const m of SLICED.filter((m) => modules[m])) {
      rules.push({
        id: `API_${m.toUpperCase()}`,
        type: "public_api",
        module: m,
        entries: sliceEntries(modules[m].paths),
        severity: "block",
        description: `Other layers use each slice of ${m} only through its index file.`,
        rationale: "Feature-Sliced Design gives every slice a public API, so its insides can change without touching the layers above.",
      });
    }
  }
  if (name === "nuxt" && modules.server) {
    for (const m of NUXT_CLIENT.filter((m) => modules[m])) {
      rules.push({
        id: `SERVER_${m.toUpperCase()}`,
        type: "deny_dependency",
        from: m,
        to: "server",
        severity: "block",
        description: `${m} must not import server code.`,
        rationale: "Code under server/ runs only on the server. Imported into code that reaches the browser it breaks the build or leaks secrets.",
      });
    }
  }

  return {
    version: 1,
    modules,
    layers,
    rules,
    exceptions: [],
    ...(ignore.length ? { ignore } : {}),
    ...(extra.aliases && Object.keys(extra.aliases).length ? { aliases: extra.aliases } : {}),
  };
}

/** Folders directly in a module group, such as src/modules/billing, with the glob of each, sorted. */
function moduleFolders(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.split("/");
    const at = parts[0] === "src" ? 1 : 0;
    // A folder named with a wildcard would be a glob that takes in its sibling folders as well.
    if (parts.length < at + 3 || !MODULE_GROUPS.includes(parts[at]) || /[*?]/.test(parts[at + 1])) continue;
    const folder = parts.slice(0, at + 2).join("/");
    if (!found.has(folder)) found.set(folder, [`${folder}/**`]);
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}
