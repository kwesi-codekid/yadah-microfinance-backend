import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIENCE_TAGS, COLLECTOR_APP, TAG_GROUPS } from './audiences.js';
import { buildOpenApiDocument } from './document.js';

/**
 * The audience grouping is only worth having if it is TRUE.
 *
 * A wrong tag is worse than no tag: someone builds against an endpoint the
 * server will refuse. So rather than trusting the hand-written list, this
 * reads the routers, works out what a collector token can actually reach, and
 * compares. If a guard changes and audiences.ts does not, this fails.
 */

const MODULES_DIR = 'src/modules';
// Every gate that admits staff but not a collector. `requireCounter` belongs
// here: it opens a route to the counter — admin, manager, teller — and a
// collector is scoped to their own round instead.
const STAFF_GUARDS = ['requireCounter', 'requireOffice', 'requireAdmin', 'requireRole'];

/**
 * Every `METHOD /path` reachable with a collector token, read from the route
 * definitions. A router guarded at the top is skipped wholesale; otherwise
 * each route is checked for its own guard.
 *
 * The portal is excluded: its routes sit behind requireCustomer, a different
 * door entirely, and no staff token opens it.
 */
function collectorReachableFromRouters(): Set<string> {
  const found = new Set<string>();

  for (const moduleName of readdirSync(MODULES_DIR)) {
    if (moduleName === 'portal') continue;
    const dir = join(MODULES_DIR, moduleName);
    const files = readdirSync(dir).filter((f) => f.endsWith('.routes.ts'));

    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      const lines = source.split('\n');

      // A guard on the router itself closes every route beneath it.
      const routerGuarded = lines.some(
        (l) => l.includes('.use(') && STAFF_GUARDS.some((g) => l.includes(g)),
      );
      if (routerGuarded) continue;

      for (const [i, line] of lines.entries()) {
        const inline = /Router\.(get|post|patch|put|delete)\(\s*'([^']*)'/.exec(line);
        const wrapped = /Router\.(get|post|patch|put|delete)\(\s*$/.exec(line);

        let method: string;
        let path: string;
        if (inline) {
          method = inline[1] ?? '';
          path = inline[2] ?? '';
        } else if (wrapped) {
          method = wrapped[1] ?? '';
          // A wrapped definition puts the path on the line below the verb.
          path = (lines[i + 1] ?? '').trim().replace(/[',]/g, '');
        } else {
          continue;
        }

        // The guard, if any, sits in the few lines after the verb.
        const chunk = lines.slice(i, i + 6).join(' ');
        if (STAFF_GUARDS.some((g) => chunk.includes(g))) continue;

        // Express ':id' becomes OpenAPI '{id}'; '/' is the module root.
        const openApiPath = `/${moduleName}${path === '/' ? '' : path}`.replace(
          /:([A-Za-z0-9_]+)/g,
          '{$1}',
        );
        found.add(`${method.toUpperCase()} ${openApiPath}`);
      }
    }
  }
  return found;
}

describe('the collector audience list matches the routers', () => {
  it('lists exactly what a collector token can reach', () => {
    const actual = collectorReachableFromRouters();
    const declared = new Set(COLLECTOR_APP);

    // Reported as sorted arrays so a failure names the endpoints, rather than
    // saying two sets differ.
    const missing = [...actual].filter((r) => !declared.has(r)).sort();
    const stale = [...declared].filter((r) => !actual.has(r)).sort();

    expect({ missingFromAudiences: missing, noLongerReachable: stale }).toEqual({
      missingFromAudiences: [],
      noLongerReachable: [],
    });
  });
});

describe('the published document is navigable', () => {
  const document = buildOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, { tags?: string[] }>>;
    tags: { name: string; description?: string }[];
    'x-tagGroups': { name: string; tags: string[] }[];
  };

  it('tags every declared collector operation, and no others', () => {
    const tagged = new Set<string>();
    for (const [path, ops] of Object.entries(document.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (op.tags?.includes(AUDIENCE_TAGS.collector)) {
          tagged.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect([...tagged].sort()).toEqual([...COLLECTOR_APP].sort());
  });

  it('has no declared path that is missing from the spec', () => {
    // A typo here would silently tag nothing, so the list must resolve.
    const inSpec = new Set<string>();
    for (const [path, ops] of Object.entries(document.paths)) {
      for (const method of Object.keys(ops)) inSpec.add(`${method.toUpperCase()} ${path}`);
    }
    expect(COLLECTOR_APP.filter((r) => !inSpec.has(r))).toEqual([]);
  });

  it('places every tag in exactly one sidebar group', () => {
    const grouped = TAG_GROUPS.flatMap((g) => g.tags);
    const declared = document.tags.map((t) => t.name);

    expect([...new Set(grouped)]).toHaveLength(grouped.length); // no tag in two groups
    expect(declared.filter((t) => !grouped.includes(t))).toEqual([]); // none orphaned
    expect(grouped.filter((t) => !declared.includes(t))).toEqual([]); // none invented
  });

  it('describes both audience tags, so the sections explain themselves', () => {
    for (const name of Object.values(AUDIENCE_TAGS)) {
      const tag = document.tags.find((t) => t.name === name);
      expect(tag?.description ?? '').not.toHaveLength(0);
    }
  });
});
