import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard the assignment asks for: "if someone later adds a second,
 * slightly different way of computing this same number somewhere else, something
 * would actually catch it."
 *
 * Revenue is summed from the raw money column `amount_cents` in EXACTLY one place:
 * src/metrics/revenue.ts. This test scans the whole source tree and fails if any
 * other file aggregates `amount_cents` (in SQL via sum(...) or in JS via reduce).
 * Re-summing the canonical OUTPUT (collectedCents) is fine — that's the reconcile
 * check, not a competing definition.
 */
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');
const CANONICAL = join('metrics', 'revenue.ts');

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'SQL sum(amount_cents)', re: /sum\s*\(\s*amount_cents/i },
  { name: 'JS reduce over amount_cents', re: /\.reduce\s*\([^)]*amount_cents/ },
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('drift guard — revenue is summed in exactly one place', () => {
  it('no file other than metrics/revenue.ts aggregates amount_cents', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      if (file.endsWith(CANONICAL)) continue;
      const content = readFileSync(file, 'utf8');
      for (const { name, re } of FORBIDDEN) {
        if (re.test(content)) offenders.push(`${relative(srcDir, file)} → ${name}`);
      }
    }
    expect(offenders, `rogue revenue summation found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
