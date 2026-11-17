// The release (.github/workflows/release.yml) runs the whole check on GitHub's runner before it publishes. That runner is not
// Woodpecker's image: of lint:ops' linters it lacks woodpecker-cli, and lint-ops fails on a missing one when CI is set, as
// GitHub sets it. So the step that runs the check unsets CI; without that, a merge that raised the version published nothing.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
/** The workflow's steps, each from its `- ` to the next one's. */
const steps = workflow.slice(workflow.indexOf('    steps:')).split(/\n {6}- /).slice(1);

it("the release's check runs with CI unset, so lint:ops skips a linter only Woodpecker's image has", () => {
  const check = steps.filter((step) => /^\s*run: npm run check$/m.test(step));
  expect(check).toHaveLength(1);
  expect(check[0]).toMatch(/^\s*env:\n\s+CI: ''$/m);
});
