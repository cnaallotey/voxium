import { describe, expect, it } from "vitest";
import { scanFile } from "./imports.js";
import { extractVueScript, findImports } from "./index.js";

const modules = (content: string) => {
  const { imports, unparsed } = scanFile("a.vue", content);
  expect(unparsed, content).toBeUndefined();
  return imports.map((i) => `${i.specifier}:${i.line}`);
};

describe("scripts of .vue files", () => {
  it.each([
    "<script>\nimport './a'\n</script>",
    "<SCRIPT>\nimport './a'\n</SCRIPT>",
    "<Script Setup>\nimport './a'\n</sCRIPT >",
    "<script setup>\nimport './a'\n</script\t>",
    "<script\n>import './a'</script>",
    "<script generic='T extends A<B>'\nlang=ts>import './a'</script>",
    "<script x=\">\"\n>import './a'</script>",
    "<script x='</script>'\n>import './a'</script>",
    "<script\n src='./a'></script>",
    "<script\n src=\"./a\"/>",
    "<SCRIPT\n SRC=./a></SCRIPT>",
    "<script\n src = '&#46;&sol;a'></script>",
    "<!-- <script> -->\n<script>import './a'</script>",
    "<!-- <template> -->\n<script>import './a'</script>",
    "<!-->\n<script>import './a'</script><!-- -->",
    "<template>\n</template><script>import './a'</script>",
    "<template><p>{{ a < b }}</p>\n<template #x><br/></template></template><script>import './a'</script>",
    "<template><p>{{ '</template>' }}\n</p></template><script>import './a'</script>",
    "<template><p a='<script>'/>\n</template><script>import './a'</script>",
    "<template lang='pug'>\np </p </template><script>import './a'</script>",
    "<template><!-- </template> -->\n</template><script>import './a'</script>",
    "<style>\na > b { content: '<script>' }</style><script>import './a'</script>",
    "<docs>\n<!-- </docs><script>import './a'</script> -->",
    "<i18n/>\n<script>import './a'</script>",
    "a < b\n<script>import './a'</script>",
    "<script>export default {}</script>\n<script setup lang='ts'>import './a'</script>",
    // What looks like the start of a comment and is none.
    "<!doctype <!-- >\n<script>import './a'</script>\n<!-- -->",
    "<?x <!-- ?>\n<script>import './a'</script>\n<!-- -->",
    "</x <!-- >\n<script>import './a'</script>\n<!-- -->",
    "<template><a/></template <!-- >\n<script>import './a'</script>\n<!-- -->",
    "<script setup>const x = 1</script <!-- >\n<script>import './a'</script>\n<!-- -->",
    "<docs></docs <!-- >\n<script>import './a'</script>\n<!-- -->",
    "{{ '<!--' }}\n<script>import './a'</script>\n<!-- -->",
    "<![CDATA[ <!-- ]]>\n<script>import './a'</script>\n<!-- -->",
    "<template><!x </template><!-- ></template>\n<script>import './a'</script>\n<!-- -->",
    // Ends that some compilers see and others do not.
    "<docs></docs/><!--</docs>\n<script>import './a'</script><!-- -->",
    "<docs><p a='</docs><!--'></p></docs>\n<script>import './a'</script><!-- -->",
    "<docs><!-- </docs><foo> --></docs>\n<script>import './a'</script></foo>",
    "<docs><p a='</docs><b c=\"'></p></docs>\n<script>import './a'</script><x y=\">\"></x></b>",
    "\n<docs><p a='</docs><script>//'></p></docs><script>import './a'</script>",
    "<docs></docs/>\n<script>import './a'</script><docs></docs>",
    "<template><div><template></div></template>\n<script>import './a'</script><template></template></template>",
    "<template></ template><!--</template>-->\n<script>import './a'</script>",
    "<template>{{ '</template>' }}{{ \"<a b='\" }}</template>\n<script>import './a'</script><docs x='></docs><b></a>",
    "<template>{{ '</template><docs>' }}</template>\n<script>import './a'</script><x></docs>",
    "<template>{{ '</template><!--' }}</template>\n<script>import './a'</script><!-- -->",
    "<template><textarea></template><docs></textarea></template>\n<script>import './a'</script></docs>",
    "<template><template>{{ '</template>' }}</template><docs></template>\n<script>import './a'</script></docs>",
    "<template </template><docs>\n<script>import './a'</script></docs></template>",
    "<docs </docs>\n<script>import './a'</script></docs>",
    "<script / >`\n<script>import './a'</script>",
    // Attributes.
    "<script\n src='&#46/a'></script>", "<script\n src='&#0000000000046;/a'></script>",
    `<script ${Array.from({ length: 120 }, (_, i) => `a${i}`).join(" ")}\n src='./a'></script>`,
  ])("are found in %j", (content) => {
    expect(modules(content)).toContain("./a:2");
  });

  it.each([
    "<!-- <script>import './a'</script> -->", "<template><p>import './a'</p></template>", "<style>import './a'</style>", "<p title=\"import './a'\">x</p>", "<scripts>import './a'</scripts>",
  ])("are nothing else, as in %j", (content) => {
    expect(modules(content)).toEqual([]);
  });

  it("are nothing that other blocks only show", () => {
    const docs = "<docs>\n```vue\n<template><p/></template>\n<script>\nimport './x'\n</script>\n```\n</docs>";
    expect(modules(`${docs}\n<script>import './a'</script>`)).toEqual(["./a:9"]);
    expect(modules(`<template><p>{{ a }}</p></template>\n${docs}\n<script>import './a'</script>`)).toEqual(["./a:10"]);
  });

  it("are read in their language", () => {
    expect(modules("<script lang='tsx'>\nx = <T>it's</T>; import './a'</script>")).toEqual(["./a:2"]);
    expect(modules("<script lang='JSX'>\nx = <T>it's</T>; import './a'</script>")).toEqual(["./a:2"]);
    expect(modules("<script lang='ts'>\nx = <any>/'/; import './a'</script>")).toEqual(["./a:2"]);
  });

  it.each([
    ["<script>import './a'", "has a <script> that does not end"], ["<script", "ends inside a tag"], ["<script>'</script>", "ends inside a string"], ["<script>`</script><script>`</script>", "ends inside a template literal"],
    ["<!-- <template> --><script a='>", "ends inside a tag"], ["<script>\n// </script/>\nimport './a'\n</script>", "has a <script> of which it is not certain where it ends"], ["<script>//\x1c/script>\n</script>", "has a <script> of which it is not certain where it ends"],
    ["<script>'</script\u00a0'</script>", "has a <script> of which it is not certain where it ends"], ["<script </script lang=ts>\n/*<script>*/import './a'\n/**/</script>", "has a <script> of which it is not certain where it ends"],
    ["<script src='./a' src='./b'></script>", "has a <script> with a src that cannot be read"], ["<script src='&period/a'></script>", "has a <script> with a src that cannot be read"], ["<script src='&foo;/a'></script>", "has a <script> with a src that cannot be read"],
    ["<template>{{ '</template>' }}{{ '<script>//' }}</template>\n<script>import './a'</script>", "ends inside JSX"],
    [`</x><!-- <script>${"(".repeat(20_000)}</script> -->`, "is nested too deeply"], [`</x><!-- <script lang=ts>${"a<(b=".repeat(40)}</script> -->`, "can be read in too many ways"], [`</x>${"<script>".repeat(50)}${" ".repeat(50_000)}`, "has a <script> that does not end"],
    [`<template>${"<script>".repeat(50)}${" ".repeat(50_000)}</script>`, "can be read in too many ways"], [`<template>{{ '</template>' }}</template><script>${"(".repeat(20_000)}</script>`, "is nested too deeply"],
  ])("are an error when they cannot be read: %j", (content, reason) => {
    expect(scanFile("a.vue", content).unparsed).toBe(reason);
  });

  it("are found behind what looks like one and does not end", () => {
    expect(modules(`<template>{{ '</template>' }}<a b='</script x="'/></template>\n<script>import './a'</script>`)).toContain("./a:2");
  });

  it("may be mentioned elsewhere, also after them", () => {
    for (const text of ["<!-- <script> -->", "<!-- <script>it's</script> -->", "<p a='<script>'/>", "<!-- <script src=a> '</script> -->", "{{ '<script>' }}"]) {
      expect(modules(`<script>import './a'</script>\n<template>${text}</template>`)).toContain("./a:1");
      expect(modules(`<script>import './a'</script>\n<docs>${text}</docs><style>a { b: '${text}' }</style>`)).toContain("./a:1");
    }
  });

  it("can be extracted with the same line numbers", () => {
    const content = "<!-- x -->\n<SCRIPT lang='ts' src='./a'\n>\r\nimport './b'\n</SCRIPT >\n<template>\n<p/></template>\n<script>import './c'</script>\n";
    const code = extractVueScript(content);
    expect(code.split("\n")).toHaveLength(content.split("\n").length);
    expect(findImports(code)).toEqual([{ specifier: "./a", line: 2 }, { specifier: "./b", line: 4 }, { specifier: "./c", line: 8 }]);
    expect(code).not.toContain("<");
  });

  it("are found next to a tag with a very long name", () => {
    expect(modules(`<${"a".repeat(400_000)}>\n<script>import './a'</script>`)).toContain("./a:2");
  });

  it("may have a query in their src", () => {
    expect(modules("<script src='./a?x=1&y=2'></script>")).toEqual(["./a?x=1&y=2:1"]);
  });

  it("stay cheap to find", () => {
    for (const s of ["<script ", "<script></script>", "<template>", "<!--", "<a b=\"", "</template><script></script>", "<template><script></script></template>", "<template><script>", "<!-- <template> --><script>", "<template>{{</template>", "<template></template>", "<a></a>", "<docs></docs/>", "<![CDATA[", "</ template", "<a / / / ", "{{"]) {
      const start = process.cpuUsage();
      extractVueScript(s.repeat(Math.ceil(1_000_000 / s.length)));
      const { user, system } = process.cpuUsage(start);
      expect((user + system) / 1000, s).toBeLessThan(3000);
    }
  });
});

describe("templates of .vue files", () => {
  const scan = (content: string) => scanFile("a.vue", content);
  const both = (content: string) => {
    const { imports, opaque, unparsed } = scan(content);
    return { imports: imports.map((i) => `${i.specifier}:${i.line}`), opaque: opaque.map((o) => `${o.kind}:${o.line}`), unparsed };
  };

  it("are compiled into the module of the component, so what their expressions load is found", () => {
    const template = "<template><button @click=\"import('../ui/secret')\">x</button>\n<div>{{ import('../ui/other') }}</div></template>";
    expect(both(template)).toEqual({ imports: ["../ui/secret:1", "../ui/other:2"], opaque: [], unparsed: undefined });
    expect(both(`<script setup>\nimport './a'\n</script>\n${template}`).imports).toEqual(["./a:2", "../ui/secret:4", "../ui/other:5"]);
    expect(both(`${template}\n<script setup lang="ts">\nimport './a'\n</script>`).imports).toEqual(["../ui/secret:1", "../ui/other:2", "./a:4"]);
  });

  it.each<[string, string[], string[]]>([
    // Names that the scripts give to what loads, used in the template.
    ["<script setup>\nimport { createRequire } from 'node:module'\nconst r = createRequire(import.meta.url)\n</script>\n<template>\n<p>{{ r('./x') }}</p></template>", ["node:module:2", "./x:6"], []],
    ["<script setup>\nimport { createRequire } from 'node:module'\n</script>\n<template>\n<p :a=\"createRequire('/b/')('./y')\"/></template>", ["node:module:2"], ["require_value:5"]],
    ["<script setup>\nconst load = (n) => n\n</script>\n<template><p :a=\"load('./x')\"/></template>", [], []],
    // As Vue reads them: character references, every kind of directive, and dynamic arguments.
    ["<template><p @click=\"imp&#111;rt(&quot;./x&quot;)\"/></template>", ["./x:1"], []],
    ["<template><p @click=\"import&lpar;'./x'&rpar;\"/></template>", ["./x:1"], []],
    ["<template><p @click=\"import(&copy;'./x')\"/></template>", [], ["import:1"]],
    ["<template><p v-for=\"(a, i) in import('./x')\"/></template>", ["./x:1"], []],
    ["<template><p v-for=\"{ a = import('./x') } of b\"/></template>", ["./x:1"], []],
    ["<template><C #default=\"{ a = import('./x') }\"/></template>", ["./x:1"], []],
    ["<template><C v-slot:x=\"{ a = require('./x') }\"/></template>", ["./x:1"], []],
    ["<template><C @[import(`x`)]=\"f\"/></template>", ["x:1"], []],
    ["<template><C v-bind=\"import('./x')\" .p=\"import('./y')\" v-custom:arg=\"import('./z')\"/></template>", ["./x:1", "./y:1", "./z:1"], []],
    ["<template><C @click=\"a = 1; import('./x')\" @keyup=\"async () => { await import('./y') }\" @x=\"function () { import('./z') }\"/></template>", ["./x:1", "./y:1", "./z:1"], []],
    ["<template><C :a=\"import(x)\"/>{{ require.valueOf()('./x') }}</template>", [], ["import:1", "require_value:1"]],
    ["<template><template v-if=\"a\"><p>{{ import.meta.glob('./*.ts') }}</p></template></template>", [], []],
    // Expressions that cannot be read do not hide the others, and are opaque when they mention a loader.
    ["<template><p>{{ a = }}</p>\n<p>{{ import('./x') }}</p></template>", ["./x:2"], []],
    ["<template><p>{{ import( }}</p>\n<p>{{ import('./x') }}</p></template>", ["./x:2"], ["import:1"]],
    // A template in another language is not read.
    ["<template lang=\"pug\">\np(@click=\"import('./x')\")</template>", [], ["import:2"]],
    // A template in another file, which is compiled in its place.
    ["<script setup>\nimport './a'\n</script>\n<template src=\"./t.html\"></template>", ["./a:2"], ["import:4"]], ["<template\nsrc=\"./t.html\"/>", [], ["import:2"]],
    // v-bind() in a style, which Vue compiles into the script, also as earlier versions read it.
    ["<template><p/></template>\n<style>\n.a { color: v-bind(\"import('./x')\"); b: v-bind(import('./y')) }\n</style>", ["./x:3", "./y:3"], []],
    ["<style lang=\"scss\">\n// v-bind(import('./x'))\n/* v-bind(import('./y')) */ .a { b: v-b/* */ind(import('./z')) }</style>", ["./x:2", "./y:3", "./z:3"], []],
    ["<style>.a { b: v-bind(\"require.valueOf()\") } .b { c: v-bind(( }</style>", [], ["require_value:1"]],
    // Vue takes what is in v-pre for text, up to where it can end.
    ["<template><p v-pre :a=\"import('./a')\">{{ import('./b') }}<b>{{ import('./c') }}</b></p>\n{{ import('./d') }}</template>", ["./d:2"], []],
    ["<template><p v-pre><p></p>{{ import('./a') }}</p></template>", ["./a:1"], []],
    // Vue knows v-pre only in lower case. V-PRE and v-Pre are an attribute and a directive, and what is in them is compiled.
    ["<template><div V-PRE>{{ import('./a') }}</div>\n<div v-Pre :b=\"import('./b')\">{{ import('./c') }}</div></template>", ["./a:1", "./b:2", "./c:2"], []],
    // What may be a template, where the blocks of a component are not certain.
    ["{{ x }}\n<template><p :a=\"import('./x')\"/></template>", ["./x:2"], []],
  ])("are read in %j", (content, imports, opaque) => {
    expect(both(content)).toEqual({ imports, opaque, unparsed: undefined });
  });

  it.each([
    "<template><p title=\"import('./x')\">import('./y') {{ a < b }} and {{ a<b }}</p><!-- {{ import('./z') }} --></template>",
    "<template><C v-for=\"(item, i) of items\" :key=\"item.id\" @click=\"count++; emit('x', $event)\" #default=\"{ row = {} }\" v-model=\"x\" v-if=\"a\" v-else-if=\"b\" @y=\"onY\" @z=\"a.b[c]\" :class=\"{ a: b }\" :x=\"`${a}`\" v-pre/></template>",
    "<template><p :a=\"x as any\" @b=\"(e: Event) => f(e)\">{{ (x as A).y }}</p></template><script setup lang=\"ts\">const x = 1</script>",
    "<template><p>{{ msg | capitalize }}</p><p :a=\"'&copy; 2024'\" /></template>",
  ])("pass what honest templates have: %j", (content) => {
    expect(both(content)).toEqual({ imports: [], opaque: [], unparsed: undefined });
  });

  it("have a limit, with the rest of the component", () => {
    const big = `<template>${"<p :a=\"f<T>(x)\">{{ x }}</p>\n".repeat(60_000)}</template>`;
    expect(big.length).toBeGreaterThan(1_100_000);
    const start = process.cpuUsage();
    expect(scan(big).unparsed).toBe("is too large to be read");
    expect(scan(`<script lang="ts">${"f<T>(x);".repeat(135_000)}</script>`.repeat(4)).unparsed).toBe("is too large to be read");
    const { user, system } = process.cpuUsage(start);
    expect((user + system) / 1000).toBeLessThan(100);
  });

  const cpu = (f: () => unknown) => {
    const start = process.cpuUsage();
    f();
    const { user, system } = process.cpuUsage(start);
    return (user + system) / 1000;
  };

  it("are too many to tell when many of their expressions cannot be read, as what is left could load something", () => {
    const content = `<template>${"<p>{{ a = }}</p><p :b=\"c\"/>\n".repeat(20_000)}<p>{{ import('./x') }}</p></template>`;
    let result: ReturnType<typeof both> | undefined;
    expect(cpu(() => (result = both(content)))).toBeLessThan(3000);
    expect(result!.unparsed).toBe("can be read in too many ways");
    // A few are found, wherever they are.
    const few = `<template>${"<p>{{ a }}</p>\n".repeat(40_000)}`.split("\n");
    for (const i of [3, 17_000, 39_000]) few[i] = "<p>{{ a = }}</p>";
    expect(both(`${few.join("\n")}<p>{{ import('./x') }}</p></template>`)).toEqual({ imports: ["./x:40001"], opaque: [], unparsed: undefined });
  });

  it.each<[string, string]>([
    ["white space in v-for", `<template><div v-for="a${" \t".repeat(450_000)}b"></div></template>`], ["white space after in", `<template><div v-for="a in b${" ".repeat(900_000)}c"></div></template>`],
    ["brackets in the name of an attribute", `<template><div :${"[".repeat(900_000)}="a"></div></template>`], ["many expressions", `<template>${"{{a}}".repeat(180_000)}</template>`],
    ["many expressions and one that cannot be read", `<template>${"{{a}}".repeat(90_000)}{{ ( }}${"{{a}}".repeat(90_000)}</template>`],
    ["many that cannot be read", `<template>${`${"{{a}}".repeat(1400)}{{ ( }}`.repeat(128)}</template>`], ["many tags without expressions", `<template>{{ a }}${"<a>".repeat(300_000)}</template>`],
    ["v-pre without an end", `<template>${"<a v-pre>".repeat(100_000)}</template>`], ["v-bind() that does not end in a style", `<style>${"v-bind('".repeat(100_000)}</style>`],
    ["comments and v-bind() in a style", `<style>${"/**/v-bind(a)".repeat(70_000)}</style>`],
  ])("stay affordable for %s", (_, content) => {
    expect(content.length).toBeLessThan(1_100_000);
    // About 2 seconds of CPU on a busy machine. Three times that leaves room for a slower one, and something that grows with
    // the square of the size would take minutes.
    expect(cpu(() => scan(content))).toBeLessThan(7500);
  });
});
