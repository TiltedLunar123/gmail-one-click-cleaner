/**
 * @jest-environment node
 *
 * 8.20: the changelog generator writes one kind of line ending.
 *
 * render() computes EOL from process.platform for the JSON body and then
 * joined the file's own wrapper lines with a hardcoded CRLF. On Linux or
 * macOS that produced fifteen CRLF lines wrapped around sixteen hundred
 * LF ones: a mixed-ending file in the shipped bundle, and a diff nobody
 * can read. Jude regenerates on Windows, where the two agreed by
 * accident, so nothing ever showed it.
 *
 * The needles are String.raw, because they are the two-character escapes
 * as they appear in the tool's source. The first draft of this suite
 * wrote them as ordinary string literals and so asserted that the tool
 * contained a real carriage return, which is a different claim and a
 * false one.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const TOOL = fs.readFileSync(path.join(ROOT, "tools", "build-changelog.mjs"), "utf-8");
const noComments = TOOL
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^[ \t]*\/\/.*$/gm, " ");

const CRLF = String.raw`"\r\n"`;
const LF = String.raw`"\n"`;

describe("tools/build-changelog.mjs follows the host, all the way down", () => {
  test("render joins on EOL, not on a fixed CRLF", () => {
    const render = noComments.slice(
      noComments.indexOf("function render(entries, total)"),
      noComments.indexOf("function main()")
    );
    expect(render.length).toBeGreaterThan(200);
    expect(render).toContain(".join(EOL)");
    expect(render).not.toContain(`.join(${CRLF})`);
  });

  test("EOL is still the one derived from the platform", () => {
    expect(noComments).toContain(`process.platform === "win32" ? ${CRLF} : ${LF}`);
  });

  test("the shipped file is not mixed today", () => {
    const data = fs.readFileSync(path.join(ROOT, "changelog-data.js"), "utf-8");
    const crlf = (data.match(/\r\n/g) || []).length;
    const bareLf = (data.match(/(^|[^\r])\n/g) || []).length;
    expect(crlf === 0 || bareLf === 0).toBe(true);
  });
});
