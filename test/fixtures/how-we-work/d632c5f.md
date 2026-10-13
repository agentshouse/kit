# How we work

A Room is where information people share is kept; it is not the place for
private information. Work goes into the Room it belongs to, or the First Room
when none is named.

The skills are already set up; never run `setup-matt-pocock-skills`.

## Where skill output goes

- Glossary (`GLOSSARY.md`): `glossary.md`
- Decisions (ADRs): `decisions/NNNN-<slug>.md`
- Plan (spec): `projects/<name>/plan.md`
- Tasks (tickets): `projects/<name>/tasks/NN-<slug>.md`, with a
  `Status:` line (`needs-triage`, `needs-info`, `ready-for-agent`,
  `ready-for-human`, `wontfix`, or `done` once implemented), a
  `Category:` line (`bug`, `enhancement`), a `Blocked by:` line and comments
  under `## Comments`; triage takes no pull requests
- Rejected requests (triage): `out-of-scope/<concept>.md`
- Implementation notes (implement-spec): `projects/<name>/notes/`
- PR bodies (pr): `projects/<name>/prs/<branch>.md`
- Map (Wayfinding): `projects/<name>/map.md`, its tasks under
  `tasks/` with `Type:`, `Status: claimed|resolved` and `Blocked by:` lines
- Research: `research/<slug>.md`
- Architecture reports (improve-codebase-architecture): `architecture/<slug>.html`
- Handoffs: `handoffs/<slug>.md`
- Questionnaires: `questionnaires/<slug>.md`
- Retrospectives (retro): `retros/<date>-<slug>.md`
- Wizards: `wizards/<slug>.sh`; the values they capture stay out of the Room
- Learning: `learning/<topic>/`
- Prototype: one HTML file with every variant on one page.
