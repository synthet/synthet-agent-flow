import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "plugin", "skills");
const skills = readdirSync(ROOT).map((name) => {
  const text = readFileSync(path.join(ROOT, name, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  return { name, text, description: /^description: (.+)$/m.exec(text)?.[1] ?? "" };
});

describe("plugin skills at user level", () => {
  it.each(skills.map((s) => [s.name, s] as const))("%s only triggers in tracked projects", (_name, skill) => {
    expect(skill.description).toContain(".agent-flow");
  });

  it.each(skills.map((s) => [s.name, s] as const))("%s never pushes with -u", (_name, skill) => {
    expect(skill.text).not.toMatch(/git push\s+(-u|--set-upstream)/);
  });

  it.each(skills.map((s) => [s.name, s] as const))("%s does not assume hooks are installed", (_name, skill) => {
    for (const line of skill.text.split("\n").filter((l) => /\bhooks?\b/i.test(l))) {
      expect(line).toMatch(/if (the )?hooks? (is|are) installed|hooks? (is|are) optional|without (the )?hooks?|hooks refuse/i);
    }
  });
});