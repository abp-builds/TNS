# TNS team workspace

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Members view their serving assignments, resources, calendar, and updates and report absences. Team leads and subteam leads share password-protected administrative access. The current roster has 36 people. Team leads report availability but are excluded from ordinary post allocation.

## Product Purpose

Make the Tuesday serving plan easy to understand and quick to prepare, review, adjust, and publish. The new admin planner should expose the whole night rather than require opening an editor for each person.

## Operating Context

TNS serves at The Porch. Team time precedes service, Engine Room occurs during service, room prayer starts at the piano-man cue, and Disciple and Next Steps follow service. Disciple table commitments span eight sessions; one-night coverage changes must preserve those commitments. Absences exclude people from allocations and reasons remain private to administrators. GroupMe remains the messaging channel.

## Capabilities and Constraints

The app runs a public GitHub Pages frontend and a Cloudflare Worker/D1 backend. Published information is open; editing and drafts require a server-verified shared admin session. Draft generation and publication are separate. Members submit absences by Monday night; leadership reviews Tuesday morning.

Administrators need visual drag-and-drop and click/keyboard alternatives, bulk assignment and bulk post editing, person lookup, night-specific timing/location/instruction overrides, and reusable presets. Presets save structure by default and optionally include assigned people. Saving a night does not implicitly change a preset or the default. Configurable structures should be reusable by other teams. Independent team workspaces and access boundaries remain a separate rollout decision; this deployment currently holds one team workspace.

## Brand Commitments

Keep the original TNS logo on its own in the header. Preserve the focused team-tool direction, navy and Barlow headings from the supplied schedule sheets, and readable phone layouts.

## Product Principles

- Prepare the structure once and make weekly exceptions directly on the plan.
- Show coverage and conflicts rather than hiding incomplete staffing.
- Keep night edits, reusable presets, and permanent class commitments distinct.
- Publish deliberately; preserve the plan members last received until the next publication.
- Use configurable phases, programs, posts, and slots rather than hardcoded team names.
