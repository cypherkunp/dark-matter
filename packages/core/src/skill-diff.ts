import type { SkillFile } from "./skill-hash";

const CONTEXT = 3;
/** Above this many line pairs a file is reported as changed without a line diff. */
const MAX_CELLS = 4_000_000;

type Op = { type: " " | "-" | "+"; line: string };

/** A line diff by longest common subsequence (one flat table; fine at Skill sizes). */
const diffLines = (a: string[], b: string[]): Op[] => {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if (i < n && (j === m || at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ type: "-", line: a[i] ?? "" });
      i++;
    } else {
      ops.push({ type: "+", line: b[j] ?? "" });
      j++;
    }
  }
  return ops;
};

/** Unified hunks with three lines of context. */
const hunks = (ops: Op[]): string[] => {
  const out: string[] = [];
  let index = 0;
  while (index < ops.length) {
    const firstChange = ops.findIndex((op, at) => at >= index && op.type !== " ");
    if (firstChange === -1) break;
    const start = Math.max(index, firstChange - CONTEXT);
    let end = firstChange;
    let quiet = 0;
    for (let at = firstChange; at < ops.length; at++) {
      if (ops[at]?.type === " ") {
        quiet++;
        if (quiet > CONTEXT * 2) break;
      } else {
        quiet = 0;
        end = at;
      }
    }
    const stop = Math.min(ops.length, end + CONTEXT + 1);
    const before = ops.slice(0, start);
    const oldStart = before.filter((op) => op.type !== "+").length + 1;
    const newStart = before.filter((op) => op.type !== "-").length + 1;
    const body = ops.slice(start, stop);
    const oldCount = body.filter((op) => op.type !== "+").length;
    const newCount = body.filter((op) => op.type !== "-").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of body) out.push(`${op.type}${op.line}`);
    index = stop;
  }
  return out;
};

const isText = (content: Buffer) => !content.includes(0);
const lines = (content: Buffer) => {
  const text = content.toString("utf8").replaceAll("\r\n", "\n");
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
};

/** A unified diff from Skill `a` to Skill `b`, file by file; empty when they match. */
export const diffSkillFiles = (a: readonly SkillFile[], b: readonly SkillFile[], labels = { a: "a", b: "b" }) => {
  const left = new Map(a.map((file) => [file.path, file.content]));
  const right = new Map(b.map((file) => [file.path, file.content]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const out: string[] = [];
  for (const path of paths) {
    const before = left.get(path);
    const after = right.get(path);
    if (before && after && before.equals(after)) continue;
    out.push(
      `--- ${before ? `${labels.a}/${path}` : "/dev/null"}`,
      `+++ ${after ? `${labels.b}/${path}` : "/dev/null"}`,
    );
    const binary = (before && !isText(before)) || (after && !isText(after));
    const oldLines = before ? lines(before) : [];
    const newLines = after ? lines(after) : [];
    if (binary) out.push("Binary files differ");
    else if (oldLines.length * newLines.length > MAX_CELLS) out.push("Files differ (too large to show)");
    else out.push(...hunks(diffLines(oldLines, newLines)));
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
};
