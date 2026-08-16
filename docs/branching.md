# Branching and promotion policy

MCP Inspector X uses a permanent integration branch so `main` always represents the latest stable state.

```text
feature/*
   ↓ pull request
  dev          # default development/integration branch
   ↓ promotion pull request
 main          # stable/latest only
```

## `dev`

`dev` is the normal target for implementation pull requests.

- Create feature/fix branches from the current `dev` unless a work item explicitly requires another base.
- `dev` may contain work that has not yet been promoted as stable.
- `dev` MUST remain buildable and testable.
- CI is expected to pass before changes enter `dev`.

## `main`

`main` is the stable/latest branch.

- Normal feature/fix pull requests MUST NOT target `main`.
- Stable changes reach `main` through an explicit `dev → main` promotion pull request.
- Promotion requires all configured required status checks to pass.
- Force pushes and deletion of `main` must be blocked by the repository ruleset.

## Emergency hotfix

An emergency hotfix may target `main` directly only when the pull request is explicitly labeled `emergency-hotfix` and the reason for bypassing the normal promotion path is documented in the pull request.

After the hotfix merges, reconcile the exact change back into `dev` immediately. `main` and `dev` must not retain divergent fixes.

## CI policy

The repository carries semantic branch policy in version control through `scripts/check-promotion-policy.mjs`.

For pull requests targeting `main`:

```text
head == dev
  → PASS

head != dev AND label == emergency-hotfix
  → PASS with explicit emergency override

otherwise
  → FAIL
```

This CI policy does not replace GitHub enforcement. A repository ruleset must require pull requests and required status checks on `main`; otherwise a direct push can change `main` before CI reports a failure.

## Required GitHub repository settings

Set the repository default branch to `dev`.

Configure a ruleset targeting `main` with at least:

- require a pull request before merging;
- require status check `verify`;
- require status check `promotion-policy`;
- block force pushes;
- block branch deletion.

Human review approval is optional unless separately adopted as project policy.
