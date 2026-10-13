# How we work

A Room is where information people share is kept; it is not the place for
private information. Work goes into the Room it belongs to, or the First Room
when none is named. Read and write Rooms with the `house` CLI.

The skills are already set up; never run `setup-matt-pocock-skills`.

## Where skill output goes

- Glossary (`CONTEXT.md`): `library/glossary.md`
- Decisions (ADRs): `library/decisions/NNNN-<slug>.md`
- Plan (spec): `library/projects/<name>/plan.md`
- Tasks (tickets): `library/projects/<name>/tasks/NN-<slug>.md`, with a
  `Status:` line (`needs-triage`, `needs-info`, `ready-for-agent`,
  `ready-for-human`, `wontfix`), a `Blocked by:` line and comments under
  `## Comments`
- Map (Wayfinding): `library/projects/<name>/map.md`, its tasks under
  `tasks/` with `Type:`, `Status: claimed|resolved` and `Blocked by:` lines
- Research: `library/research/<slug>.md`
- Questionnaires: `library/questionnaires/<slug>.md`
- Learning: `library/learning/<topic>/`
- Files a person should open, such as HTML pages, are uploaded to the Room and
  linked from the document they belong to; a prototype is one HTML file with
  every variant on one page.
