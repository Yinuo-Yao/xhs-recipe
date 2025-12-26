import test from "node:test";
import assert from "node:assert/strict";
import { extractFirstHttpsUrl } from "./urlSanitizer.js";

test("extractFirstHttpsUrl returns null when no https:// exists", () => {
  assert.equal(extractFirstHttpsUrl("no url here"), null);
  assert.equal(extractFirstHttpsUrl("http://example.com only"), null);
  assert.equal(extractFirstHttpsUrl("HTTPS://example.com uppercase"), null);
});

test("extractFirstHttpsUrl extracts first https:// URL and trims trailing junk", () => {
  assert.equal(
    extractFirstHttpsUrl("看看这个 https://xhslink.com/abc 复制打开小红书"),
    "https://xhslink.com/abc"
  );
  assert.equal(extractFirstHttpsUrl("https://xhslink.com/abc"), "https://xhslink.com/abc");
  assert.equal(extractFirstHttpsUrl("https://xhslink.com/abc。\n后面"), "https://xhslink.com/abc");
  assert.equal(extractFirstHttpsUrl("prefix\nhttps://xhslink.com/abc\nsuffix"), "https://xhslink.com/abc");
  assert.equal(extractFirstHttpsUrl("“https://xhslink.com/abc”"), "https://xhslink.com/abc");
  assert.equal(extractFirstHttpsUrl('复制: "https://xhslink.com/abc", ok'), "https://xhslink.com/abc");
  assert.equal(
    extractFirstHttpsUrl("text https://xhslink.com/abc?x=1&y=2 复制"),
    "https://xhslink.com/abc?x=1&y=2"
  );
  assert.equal(
    extractFirstHttpsUrl("text https://xhslink.com/abc?x=1&y=2。"),
    "https://xhslink.com/abc?x=1&y=2"
  );
  assert.equal(extractFirstHttpsUrl("http://a https://b https://c"), "https://b");
  assert.equal(extractFirstHttpsUrl("https://xhslink.com/abc)"), "https://xhslink.com/abc");
  assert.equal(extractFirstHttpsUrl("https://xhslink.com/abc#frag"), "https://xhslink.com/abc#frag");
});

