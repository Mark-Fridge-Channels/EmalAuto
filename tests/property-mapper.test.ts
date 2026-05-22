import assert from "node:assert/strict";
import test from "node:test";

import { isLikelyHtmlContent, richTextPropertyToHtml } from "../src/notion/property-mapper.js";

function richText(content: string) {
  return {
    type: "rich_text",
    rich_text: [
      {
        plain_text: content,
        text: { content },
      },
    ],
  };
}

test("richTextPropertyToHtml preserves pasted HTML bodies", () => {
  const html = `<div>Hi Jennifer Coddou,</div>
<div>跟进 supply（第 2 封/共 3 封）。</div>
<div>Best,<br>billy@fcconnect.co</div>
<div class="gmail_quote">
  <blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">
<div>Hi Jennifer Coddou,</div>
  </blockquote>
</div>`;

  assert.equal(isLikelyHtmlContent(html), true);
  assert.equal(richTextPropertyToHtml(richText(html)), html);
});

test("richTextPropertyToHtml still escapes non-HTML rich text", () => {
  assert.equal(isLikelyHtmlContent("2 < 3 and 5 > 4"), false);
  assert.equal(richTextPropertyToHtml(richText("2 < 3 and 5 > 4")), "2 &lt; 3 and 5 &gt; 4");
});
