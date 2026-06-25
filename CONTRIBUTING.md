# Contributing Guidelines

First off, thank you for considering contributing. Your interest is apprexiated.

## Ways to Contribute

You don't have to write code to contribute. Contributions of all kinds are welcome:

- **Reporting bugs** — if something doesn't work
- **Suggesting features** — ideas for improvement are always welcome
- **Improving documentation** — fix typos, write tutorials, translate
- **Reviewing pull requests** — help others land their changes
- **Design, writing, organizing** — communities need more than just code

If you're new to open source, [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/) is a great place to start.

## Ground Rules

- Be respectful and constructive in all interactions. Assume good intentions.
- Keep discussions public unless reporting a security vulnerability or Code of Conduct violation.
- Verify your change works before submitting. Don't break the build.
- Create an issue before starting work on a significant change so we can align on scope.

## How to Report a Bug

1. Search existing issues to check it hasn't already been reported.
2. Open a new issue and include:
   - A clear, descriptive title
   - What you were doing and what you expected to happen
   - What actually happened (including error messages, screenshots)
   - Steps to reproduce (minimal, self-contained)
   - Your environment (OS, version, dependencies)

## How to Suggest a Feature

Open an issue and describe:

- Why the feature is useful (not just to you — what problem does it solve?)
- How you imagine it working
- Any alternatives you've considered

Maintainers may ask follow-up questions, refine scope, or close the issue if it doesn't align with the project's direction.

## How to Submit Code

1. **Fork** the repository and clone it locally.
2. **Create a branch** for your change:
   ```
   git checkout -b <descriptive-branch-name>
   ```
3. **Make your changes** following the coding practices below.
4. **Run tests** to confirm nothing is broken, and add tests for new behavior.
5. **Commit** using the semantic format described below.
6. **Push** your branch and open a pull request against `main`.

For small, obvious fixes (typos, whitespace, build scripts), you can open a PR directly without a prior issue.

### Semantic Commit Messages

Format:
```
<type>/<optional scope>: <imperative summary in present tense>
```

Allowed types:

| Type      | Purpose                                       |
|-----------|-----------------------------------------------|
| `feat`    | new feature or functionality                  |
| `fix`     | bug fix (issue # as scope if applicable       |
| `docs`    | documentation only                            |
| `refactor`| code restructuring without behavior change    |
| `test`    | add or modify tests only                      |
| `chore`   | ecosystem, formatting/linting, ci, build      |
| `perf`    | performance improvement                       |

Examples:
```
feat/scheduler: add round-robin dispatch loop
fix/memory: correct frame table bounds check
test/locks: add high-contention scenario
refactor: extract pcb init helper
```

Body (optional) should explain rationale, constraints, trade-offs. Reference issues:
```
Closes #12
```

## Pull Requests

A PR should include:

- Clear descriptive title following semantic format
- Linked issue(s) — reference with `Closes #N` or `Refs #N`
- Summary of approach, design decisions, and trade-offs
- Testing evidence: commands run and output snippets
- Acknowledged risks or potential regressions

### PR Checklist

- [ ] Title follows semantic format
- [ ] Issue linked (if applicable)
- [ ] Builds / compiles locally
- [ ] Tests pass and new tests added where appropriate
- [ ] Documentation updated (README, comments, etc.)
- [ ] No debug artifacts, secrets, or generated files committed
- [ ] Self-review completed

## Code Review Process

After you submit a PR:

1. Maintainers will review, usually within a few days. Response may take longer depending on capacity.
2. You may be asked to make changes — this is normal, not a rejection. If you don't have time to continue, make it clear so others can continue.
3. Once approved, a maintainer will merge. We use **squash merge** by default — the final commit message will follow semantic format.

If you don't hear back after a week, feel free to leave a polite follow-up comment on the PR.

## Coding Practices

- Prefer clarity and readability over cleverness. Optimize only with justification.
- Document public functions and modules: purpose, inputs, outputs, error modes, side effects.
- Avoid undefined behavior and data races. Make concurrency explicit (lock ordering, invariants documented).
- Follow existing code style. Consistency matters more than personal preference.
- Keep changes focused. One logical change per PR.

## Testing Expectations

- Write tests alongside implementation, not after the fact.
- Cover happy paths and edge cases: empty inputs, max capacity, invalid input, error paths.
- For performance-sensitive components, consider including benchmarks or stress harnesses.

## Large Changes

Break work into sequential, reviewable PRs: parser changes, core logic, integration, tests. Each should build on the last. This reduces review burden and catches issues early.

## Questions?

If you're unsure about anything, open a **Question** issue (use the Question template). There are no stupid questions — we all started somewhere.
