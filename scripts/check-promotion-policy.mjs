import fs from 'node:fs';

const eventName = process.env.GITHUB_EVENT_NAME;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (eventName !== 'pull_request') {
  console.log(`promotion-policy: ${eventName ?? 'local'} event; no PR target policy to enforce`);
  process.exit(0);
}

if (!eventPath) {
  console.error('promotion-policy: GITHUB_EVENT_PATH is required for pull_request events');
  process.exit(2);
}

const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const pr = event.pull_request;
if (!pr?.base?.ref || !pr?.head?.ref) {
  console.error('promotion-policy: pull_request base/head refs are missing');
  process.exit(2);
}

const base = pr.base.ref;
const head = pr.head.ref;
const labels = new Set((pr.labels ?? []).map((label) => label.name));

if (base !== 'main') {
  console.log(`promotion-policy: PR targets ${base}; main promotion policy not applicable`);
  process.exit(0);
}

if (head === 'dev') {
  console.log('promotion-policy: valid dev → main promotion PR');
  process.exit(0);
}

if (labels.has('emergency-hotfix')) {
  console.log(`promotion-policy: emergency hotfix override accepted for ${head} → main`);
  process.exit(0);
}

console.error(
  `promotion-policy: rejected ${head} → main. Normal changes must promote from dev; ` +
    'use the emergency-hotfix label only for an explicitly justified emergency fix.',
);
process.exit(1);
