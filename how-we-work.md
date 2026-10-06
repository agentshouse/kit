# How we work

A Room is where information people share is kept; it is not the place for
private information. Work goes into the Room it belongs to, or the First Room
when none is named.

The skills are already set up; never run `setup-matt-pocock-skills`.

## Where skill output goes

- Glossary (`CONTEXT.md`): `glossary.md`
- Decisions (ADRs): `decisions/NNNN-<slug>.md`
- Plan (spec): `projects/<name>/plan.md`
- Tasks (tickets): `projects/<name>/tasks/NN-<slug>.md`, with a
  `Status:` line (`needs-triage`, `needs-info`, `ready-for-agent`,
  `ready-for-human`, `wontfix`), a `Blocked by:` line and comments under
  `## Comments`
- Map (Wayfinding): `projects/<name>/map.md`, its tasks under
  `tasks/` with `Type:`, `Status: claimed|resolved` and `Blocked by:` lines
- Research: `research/<slug>.md`
- Questionnaires: `questionnaires/<slug>.md`
- Learning: `learning/<topic>/`
- Prototype: one HTML file with every variant on one page.
