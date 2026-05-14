# Adopters

Projects shipping `vite-plugin-tsl-precompile` in production or piloting it
in real apps. Listed in chronological order of first verified working build.

## Why this file exists

- **Social proof.** New adopters reading the README want to see real
  projects, not just demo packages from the monorepo.
- **Feedback ledger.** Each entry includes the friction the adopter hit so
  maintainers can prioritize fixes against what real users actually need.
- **Release gate.** [STATUS.md](STATUS.md) Phase 8 closes when this file
  has its first entry.

## Becoming listed

If you're shipping or piloting this plugin and want to be listed, open a
PR adding your project below, or comment on the
[v0.1 adopters discussion](https://github.com/Makio64/vite-plugin-tsl-precompile/discussions)
with the fields below filled in.

```markdown
### Project name

- **Repo / URL:** <link>
- **What you're using:** explicit markers / `autoMark` / `slim` mode / aux passes
- **three.js version:** e.g. `0.184.0`
- **Stack:** Vite + … (other tooling)
- **First green build:** YYYY-MM-DD
- **Friction encountered:** what broke, what was confusing, what worked smoothly
- **Suggestions:** what would have made adoption easier
```

You're under no obligation to list — this is for adopters who want to be
visible. Private/proprietary projects can list as "anonymous" with just a
domain or stack description.

---

## Adopters

_(none yet — be the first; see "Becoming listed" above)_

---

## Internal demos (monorepo)

Not counted toward the Phase 8 gate, but useful as reference shapes:

- [`packages/examples/getting-started`](packages/examples/getting-started) — minimal: torus knot + one marker
- [`packages/examples/pbr-shadows`](packages/examples/pbr-shadows) — PBR + shadows + two markers
- [`packages/examples/ocean`](packages/examples/ocean) — flagship: animated TSL + Inspector + aux passes + bloom + PMREM

The flagship shows the harder shape (post-processing, Inspector, addon
materials) and is the closest internal proof that the architecture works
end-to-end on a non-trivial app.
