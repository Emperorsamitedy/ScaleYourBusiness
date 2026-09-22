# Licensed music — P3-18

Only tracks with a real license belong here. Each entry in
`manifest.json` must carry the license name and who it is licensed to;
the cutting room refuses to score a video with any track not in the
manifest, and an empty manifest means every music request is refused
with "no licensed track on file".

The licensing quotes are an owner decision recorded in TASKS-PHASE3.md
(cost discipline section) — nothing here moves until they exist.

Entry shape:

```json
{
  "id": "warm-open-01",
  "file": "warm-open-01.mp3",
  "title": "Warm Open",
  "license": "Artlist Standard — <license id>",
  "licensed_to": "<the business entity on the license>"
}
```
