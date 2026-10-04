import { expect, test } from "vitest";
import { extractSegments, shellCommands, splitFences } from "../src/segments.ts";
import { assistantEntry, userEntry } from "./harness.ts";

const reply = `Here's the fix. Run this:

\`\`\`bash
$ npm install zod
npm run build && \\
  npm test
\`\`\`

The config lives in \`src/config/loader.ts\` and docs are at https://zod.dev/api.

| flag | meaning |
|---|---|
| -v | verbose |

- first step
- second step

\`\`\`ts
export const x = 1;
\`\`\`

\`\`\`
feat: add config validation

Validate the config with zod at startup.
\`\`\`

This paragraph explains why the change is safe and does not affect existing users at all.`;

test("splitFences and shellCommands", () => {
  const parts = splitFences(reply);
  expect(parts.filter((p) => p.code).map((p) => (p as { lang: string }).lang)).toEqual(["bash", "ts", ""]);
  expect(shellCommands("$ npm install zod\nnpm run build && \\\n  npm test\n# comment")).toEqual(["npm install zod", "npm run build && \\\n  npm test"]);
});

test("extractSegments finds every kind of piece", () => {
  const entries = [
    userEntry("add config validation"),
    assistantEntry(reply),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "git status" } }] } },
  ];
  const segments = extractSegments(entries);
  const kinds = (k: string) => segments.filter((s) => s.kind === k).map((s) => s.text);
  expect(kinds("user")).toEqual(["add config validation"]);
  expect(kinds("assistant")).toHaveLength(1);
  expect(kinds("command")).toEqual(["npm install zod", "npm run build && \\\n  npm test", "git status"]);
  expect(kinds("code")).toEqual(["$ npm install zod\nnpm run build && \\\n  npm test", "export const x = 1;"]);
  expect(kinds("commit")).toEqual(["feat: add config validation\n\nValidate the config with zod at startup."]);
  expect(kinds("table")).toHaveLength(1);
  expect(kinds("list")).toEqual(["- first step\n- second step"]);
  expect(kinds("url")).toEqual(["https://zod.dev/api"]);
  expect(kinds("path")).toEqual(["src/config/loader.ts"]);
  expect(kinds("paragraph")).toContain("This paragraph explains why the change is safe and does not affect existing users at all.");
  expect(segments.every((s, i) => s.order === i)).toBe(true);
});

test("only the last maxTurns user turns are covered", () => {
  const entries = Array.from({ length: 5 }, (_, i) => [userEntry(`request ${i}`), assistantEntry(`reply number ${i} with enough words to be a paragraph of text`)]).flat();
  const segments = extractSegments(entries, 2);
  expect(segments.filter((s) => s.kind === "user").map((s) => s.text)).toEqual(["request 3", "request 4"]);
  expect(Math.max(...segments.map((s) => s.turn))).toBe(1);
});
