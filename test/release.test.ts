// The release (.github/workflows/release.yml) runs the whole check on GitHub's runner before it publishes. That runner is not
// Woodpecker's image: of lint:ops' linters it lacks woodpecker-cli, and lint-ops fails on a missing one when CI is set, as
// GitHub sets it. So the step that runs the check unsets CI; without that, a merge that raised the version published nothing.
// The Windows check (.github/workflows/windows.yml) runs the lint there too, on Windows, so its job unsets CI as well.
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

it('the Windows check runs with CI unset, and with cmd, the shell npm runs scripts with on Windows', () => {
  const windows = readFileSync(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8');
  const job = windows.slice(windows.indexOf('\njobs:'));
  expect(job).toMatch(/^ {4}env:\n {6}CI: ''$/m);
  expect(job).toMatch(/^ {4}defaults:\n {6}run:\n {8}shell: cmd$/m);
  expect(job).toMatch(/^\s+run: npm run lint$/m);
});
