# Keep the current extractor; this trial does not justify adoption

Scrapling did not improve the tested job enough to replace browse-tool's Readability plus Turndown extractor. In five synthetic positive cases, generic Scrapling retained one more required token but included substantially more excluded navigation and utility text. The optional adaptive selector missed all five moved targets at the frozen 70% threshold and selected the wrong plan when the learned target had been removed.

Keep `htmlToMarkdown` unchanged. This result rejects adoption from this experiment. It does not establish that Scrapling is generally inferior, or that a project with a known selector-drift problem would not benefit.

## The comparison used the actual incumbent

All six before/after pairs are self-authored synthetic fixtures, not saved production pages. `manifest.json` fixes the cases, expected strings, excluded strings, and selectors. The first two extraction runs used the same fixture and answer hashes. There were no candidate configuration sweeps or edits based on after-page results.

- **A — current extractor:** the real `htmlToMarkdown(html, url)` default in `lib/extract.js`. Its separate title is included because `browse-markdown` prints it.
- **B — generic Scrapling:** parser-only `Response.markdown(main_content_only=true)`. Here “main content” means the HTML body, not semantic article detection.
- **C — adaptive Scrapling:** learn one manually supplied selector on each BEFORE page, then attempt relocation on AFTER. The frozen threshold was **70**, while upstream defaults to **40**. Selected content uses the incumbent raw converter so formatting is held constant.

The unit of comparison is an exact expected-string check, not a human semantic-quality score. The fixtures are small and synthetic. A matching job title substring alone does not establish that the correct record was extracted.

| Positive case | A: current extractor | B: generic Scrapling | C: adaptive at 70 |
| --- | --- | --- | --- |
| Article and navigation | Pass | Relative link; 3 noise tokens | No relocation |
| Documentation and code | Pass; code retained | Code retained; footer noise | No relocation |
| Table-rich report | Fields retained; 2 noise tokens | Pipe table retained; CSV utility noise | No relocation |
| Repeated records | Austin and Full time missing; intern decoy retained | Target fields retained; 3 noise tokens | No relocation |
| Nested layout | Pass | Text retained; 2 noise tokens | No relocation |

On these five cases, A passed **3/5** strict checks, retained **14/16** required tokens, and retained **3** excluded-noise tokens. B passed **0/5**, retained **15/16**, and retained **10** noise tokens. These numbers come from the preserved outputs, independently rescored in `results.review.json`.

The sixth fixture tests a different job: detecting that a previously selected target no longer exists. A and B are whole-page converters, so their nonempty outputs are **not failures of absence detection**. Only C is judged on that control. It falsely relocated to **Starter plan** after Retired plan was removed. That is a concrete wrong-record result at the tested threshold.

**What it means:** neither candidate arm demonstrated a safe replacement for generic page extraction. B's pipe-table formatting is useful, but it is a formatting benefit rather than evidence of cleaner extraction. C's result applies only to the frozen 70% configuration; no default-threshold result is claimed.

## Setup costs remain; speed is unproven

C needed six selectors, six identifiers, SQLite state, and a separate learn action for each target. B and C add a Python runtime to this Node tool. No browser extras, accounts, network fetches, or service were used during extraction. The parent prepared the isolated dependency environment before dispatch.

The original timing comparison is **invalid**. A's timer included the later Python subprocesses, and the fields called `startup_ns` measured total subprocess wall time rather than startup alone. Do not use those values in `results.json` or `results.initial-invalid.json` as a speed comparison. The runner now captures A immediately and labels Python wall time correctly, but no fresh timing run was performed. Speed remains unmeasured under a comparable method.

## The review corrected reporting defects without another experiment

The worker ran the candidate configuration twice. Its first run omitted A's separate title; that run survives under `results.initial-invalid*`. The second run repaired title scoring. The experiment's candidate-run allowance then ended.

The parent inspected the fixtures, incumbent code, candidate code, and saved Markdown. A separate read-only review challenged the claims. The following dispositions are grounded in those sources:

| Finding | Source check and disposition |
| --- | --- |
| A timer includes other arms | Confirmed in the original `run.mjs`; speed claims withdrawn and future timer corrected. |
| Negative control bypasses the scorer | Confirmed: it manufactured a missing-token record. Replaced with removal of required text and injection of forbidden text into saved output, then actual scoring. |
| 70 is not upstream's default | Confirmed in Scrapling `parser.py`; narrowed the conclusion and left the configuration unchanged. |
| Whole-page absence penalty is unfair | Confirmed from fixture and output content; A/B removed from that denominator. |
| Installed package may differ from inspected source | Checked existing install metadata and hashes. Installed `parser.py` and `engines/toolbelt/custom.py` match the pinned clone byte for byte. Details and full dependency versions are in `provenance.json`. This does not attest every installed file. |

`node benchmarks/scrapling/run.mjs --verify-saved` checks fixture and answer hashes, rescores retained outputs, and runs passing and failing scorer controls. It does not rerun extraction. That check passed after review. Use `results.review.json` for the corrected scope; the older raw JSON is retained as historical evidence and contains the invalid timing and denominator fields.

The subprocess runner now also supplies a timeout and explicit stdin. Its changed timing path has syntax validation only, not a new benchmark run. No runtime extraction code, package manifest, or browser behavior changed.

## Provenance and limits

Baseline: browse-tool `af1f023c5c08d55d9c8acd47ca81bd2bd71e4dec`. Candidate: Scrapling 0.4.15 installed from checkout `7a684934907a8c7feaafe9ff1ccfd9d45cc26faf`. Python: 3.12.11. `requirements.lock` records the complete installed parser-only environment. The Node environment uses the repository lockfile. The package-version lock supports a future run; the retained module hashes establish which critical candidate code this run used.

The independent worker completed, but its runtime model and effort were not reported by the host. Its routing request is not treated as runtime identity evidence.

Not tested: real website drift, browser or network resilience, default-threshold relocation, workload throughput, memory use, or maintenance time. No adoption or automatic crawl behavior changed.

**What would change the recommendation:** a project with an observed selector-drift failure supplies saved, permission-cleared before/after pages. A separately authorized, frozen trial would need to improve that job while rejecting removed targets and wrong-record matches. This synthetic result does not justify starting that work across the fleet now.
