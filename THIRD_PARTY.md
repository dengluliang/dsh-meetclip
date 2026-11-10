# Third-party notices

MeetClip is distributed under the MIT license (see [LICENSE](LICENSE)). Some parts
were derived from, or inspired by, the following open-source project. The original
notices and license terms apply to those parts.

## Cicada (知了)

- Project: <https://github.com/wquguru/cicada>
- License: Apache License 2.0 (full text in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt))
- Copyright: the Cicada authors and contributors.

Derived/adapted parts in this repository:

- `backend/app/minutes_scenarios.py`, `backend/app/minutes.py`,
  `backend/app/minutes_prompt.py`, `backend/app/minutes_notes.py` — AI minutes
  scenario templates, JSON structure, evidence rules and section ordering. The
  three recording-type variants are MeetClip adaptations; the base structure
  follows Cicada's meeting template.
- `backend/app/text_hygiene.py` — text-hygiene rules for streaming ASR output.
- `backend/app/meeting_end.py` — meeting-end signal handling.
- `backend/app/ai/client.py`, `backend/app/ai/metrics.py` — operational lessons
  reflected in the client retry/latency bookkeeping.

These files are modified for MeetClip's DSH plug-in architecture, data model and
three recording types. Their source comments point back to the corresponding
Cicada files where applicable. The Apache-2.0 license text is included so the
distribution of the plug-in tarball keeps the required notices.

If you believe a file needs an additional attribution, please open an issue at
<https://github.com/dengluliang/dsh-meetclip/issues>.
