Refs {{id}}{{#issue}}
Closes #{{issue}}{{/issue}}

## Summary
{{title}}

<!-- What changed and why, in 2–4 bullets. -->

## Acceptance criteria
{{#acceptance}}
- [{{check}}] **{{ac_id}}** {{text}}{{#evidence}} — _{{evidence}}_{{/evidence}}
{{/acceptance}}

## Verification
<!-- DoD output / commands run -->

## Ticket
agent-flow `{{id}}` · branch `{{branch}}`{{#spec_ref}} · spec `{{spec_ref}}`{{/spec_ref}}
