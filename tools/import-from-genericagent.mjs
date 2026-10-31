// Regenerate the browser-side helpers vendored from GenericAgent.
//
// Usage:
//   node tools/import-from-genericagent.mjs [path/to/GenericAgent/simphtml.py]
//
// The two functions live as raw Python string literals (`js_optHTML` and
// `js_findMainList`) and are plain browser JavaScript. Keeping them as raw
// text files (instead of JS template literals) means no escaping is needed and
// the upstream code can be re-imported verbatim when GenericAgent changes.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSource =
  process.env.GENERICAGENT_SIMPHTML ||
  path.resolve(process.cwd(), "../agents_explore/GenericAgent/simphtml.py");
const source = process.argv[2] || defaultSource;
const text = await fs.readFile(source, "utf8");

function extract(name) {
  const marker = `${name} = r'''`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found in ${source}`);
  const bodyStart = start + marker.length;
  const end = text.indexOf("'''", bodyStart);
  if (end < 0) throw new Error(`unterminated ${name} literal in ${source}`);
  let body = text.slice(bodyStart, end).trim();
  // The upstream literal ends with a stray `optHTML()` invocation (GenericAgent
  // then calls it a second time from get_main_block). Drop it: we invoke the
  // function ourselves, once per scan.
  if (name === "js_optHTML") body = body.replace(/\noptHTML\(\)\s*$/, "");
  return `${body}\n`;
}

const optHtml = extract("js_optHTML");
const findMainList = extract("js_findMainList");

if (!/function optHTML\s*\(/.test(optHtml)) throw new Error("unexpected js_optHTML payload");
if (!/function findMainList\s*\(/.test(findMainList)) throw new Error("unexpected js_findMainList payload");

await fs.writeFile(path.join(here, "..", "lib", "page", "opt_html.js"), optHtml);
await fs.writeFile(path.join(here, "..", "lib", "page", "find_main_list.js"), findMainList);

console.log(`imported optHTML (${optHtml.length} chars) and findMainList (${findMainList.length} chars) from ${source}`);
