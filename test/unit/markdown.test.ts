import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain browser module
import { renderMarkdown } from "../../src/web/markdown.js";

test("raw HTML in agent output is displayed, never parsed", () => {
  for (const attack of ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>", '"><svg onload=alert(1)>', "**<b onclick=x>**", "`<i>`", "| <img src=x> | b |\n|---|---|\n| <script> | c |", "- <img src=x>", "> <img src=x>", "# <img src=x>"]) {
    const html = renderMarkdown(attack);
    assert.doesNotMatch(html, /<(img|script|svg|b |i>)/i, attack);
  }
});

test("code block content is escaped and its language label cannot inject", () => {
  const html = renderMarkdown('```"><img>\n<script>x</script>\n```');
  assert.doesNotMatch(html, /<script>|<img>/);
  assert.match(html, /&lt;script&gt;/);
});

test("only http(s) links become anchors", () => {
  assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))"), /<a /);
  assert.doesNotMatch(renderMarkdown("[x](data:text/html,<script>)"), /<a /);
  assert.doesNotMatch(renderMarkdown("[x](http://a.com\" onclick=\"y)"), /onclick="/);
  const ok = renderMarkdown("[x](https://a.com/b?c=1&d=2)");
  assert.match(ok, /href="https:\/\/a\.com\/b\?c=1&amp;d=2"/);
  assert.match(ok, /rel="noopener noreferrer"/);
});

test("common formatting renders", () => {
  assert.match(renderMarkdown("**粗** *斜* `码`"), /<strong>粗<\/strong> <em>斜<\/em> <code>码<\/code>/);
  assert.match(renderMarkdown("# 标题"), /<h3>标题<\/h3>/);
  assert.match(renderMarkdown("- a\n- b"), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(renderMarkdown("1. a\n2. b"), /<ol><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"), /<th>a<\/th>.*<td>2<\/td>/);
  assert.match(renderMarkdown("第一行\n第二行"), /第一行<br \/>第二行/);
});

test("markup that is still arriving does not break or hang", () => {
  for (const partial of ["```py\nprint(", "**粗", "| a | b", "| a |\n|--", "- ", "[链接](http", "`码"]) {
    assert.equal(typeof renderMarkdown(partial), "string", partial);
  }
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
});

test("an escaped pipe stays inside its table cell", () => {
  const html = renderMarkdown("| 指标 | 公式 |\n|---|---|\n| Dice | 2\\|A∩B\\| / (\\|A\\|+\\|B\\|) |");
  assert.match(html, /<td>2\|A∩B\| \/ \(\|A\|\+\|B\|\)<\/td>/);
  assert.equal((html.match(/<td>/g) ?? []).length, 2);
});

test("code spans keep markdown characters literal", () => {
  assert.match(renderMarkdown("`**不是粗体**`"), /<code>\*\*不是粗体\*\*<\/code>/);
});
