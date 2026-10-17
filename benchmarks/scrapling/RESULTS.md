# Scrapling offline extraction benchmark

## Recommendation

Do not adopt Scrapling for browse-tool now. This frozen, synthetic-only test shows no meaningful improvement on the real incumbent job: turning a complete page into clean Markdown with Readability plus Turndown. Scrapling's generic Markdown route retained more raw page text in some cases, but it retained more navigation and utility noise too. Its adaptive route did not recover any of the five moved targets at the frozen 70% threshold, and it falsely relocated the removed target to `Starter plan`.

Keep `htmlToMarkdown` as-is. The single next action is to run the same harness against a specific project's saved, permission-cleared before/after pages only if that project has an observed selector-drift problem; that would test a project-scoped selector workflow, not justify fleet adoption.

## Method

The six before/after pairs are synthetic and self-authored. They cover a long article with navigation, documentation with code, a table-rich report, repeated listing records, nested layout drift, and a removed target with near-duplicate decoys. The manifest states the required content and excluded noise before either candidate runs. `results.json` hashes every fixture and answer record. No network, browser, cookies, service, package installation, or database outside the ignored local `.state/` directory was used.

Arm A calls the current `htmlToMarkdown(html, url)` default. Its returned title is scored as a separate field, as `browse-markdown` prints it separately. Arm B calls Scrapling `Response.markdown(main_content_only=true)` through parser-only imports. That mode selects the HTML body, not semantic article content. Arm C learns one explicit CSS selector from each BEFORE page into SQLite, then invokes the same now-missing selector on AFTER with adaptive relocation at the frozen 70% threshold. C formats a selected subtree with the incumbent converter so selection, rather than Markdown formatting, is what changes. The manifest records the selectors and configuration; there were no sweeps or after-page tuning.

The first run incorrectly discarded Arm A's returned title while scoring. It is preserved as `results.initial-invalid.json` and `results.initial-invalid/`. The one allowed harness repair included that field, then reran the unchanged candidate configuration. The scorer also rejected a deliberately corrupted required token; that result is recorded in `results.json`.

| Case | A incumbent | B generic Scrapling | C adaptive Scrapling |
| --- | --- | --- | --- |
| Article + navigation | pass | link stays relative; 3 noise tokens | no relocation |
| Docs + code | pass; code preserved | code preserved; footer noise | no relocation |
| Table-rich report | required fields retained; 2 noise tokens | Markdown table preserved; CSV noise | no relocation |
| Repeated records | target fields missing; intern decoy retained | target fields retained; 3 noise tokens | no relocation |
| Nested layout | pass | required text retained; 2 noise tokens | no relocation |
| Removed target | full-page output is not absence | full-page output is not absence | false relocation: `Starter plan` |

Strict whole-case passes were A 3/6, B 0/6, and C 0/6. Across the five positive cases, A retained 14/16 required tokens and 3 excluded-noise tokens. B retained 15/16 required tokens but 10 excluded-noise tokens. C retained 0/16 because it selected no moved target. The removed-target control makes C's one selection a wrong-record match, which independently disqualifies adoption under the decision rule.

Links, code, and table content were separately inspected in preserved outputs. A resolved the article link to the fixture URL and preserved code text; its Turndown default rendered table cells as ordered text rather than a Markdown table. B preserved code fences and rendered pipe tables, but left the article link relative and included full-body utility content. C never selected the moved article, code, or table targets. This is a formatting difference for tables, not an extraction-quality win: the strict score still requires both content and excluded-noise behavior.

## Cost and timing

Arm C required six manually supplied selectors, six identifiers, a SQLite state file, a learn action for every target, and a fixed threshold. Those are ongoing selector-maintenance costs the incumbent does not have. Parser-only imports worked with `scrapling==0.4.15`; no browser imports were required. The locked environment also records `markdownify==1.2.3`, `lxml==6.1.3`, `cssselect==1.6.0`, and `orjson==3.13.0`.

These are local one-run timings, not throughput claims. A's in-process parse-and-conversion median was 712.2 ms (496.8--1076.9 ms). B's Python parse-and-conversion median was 51.0 ms (33.6--91.8 ms), plus 265.6 ms process startup (165.0--421.2 ms). C's AFTER selection median was 34.3 ms (30.0--45.5 ms), plus 197.9 ms startup (155.9--307.2 ms); its separate BEFORE learn step is also recorded per case. The timing difference does not outweigh the regressions, false relocation, and a second runtime for this job.

## Limits

This does not prove that Scrapling can never help a known, stable, project-local target. It does prove that this one frozen configuration did not safely improve browse-tool's generic extraction job on these synthetic cases. It leaves unproved real-site selector precision, the appropriate threshold for a real project, batch throughput, memory use, and behavior on saved public pages with real template changes. Synthetic-only evidence could support a bounded real-page trial; it cannot support general fleet adoption.
