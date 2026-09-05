# Astra effort experiment

Research cutoff: September 5, 2026, 19:47 UTC. The requested 48-, 72-, and 96-hour windows begin September 3, 2, and 1 at that time. A publication date without an hour cannot establish membership in the exact 48-hour window. Early-access experience published during this window may describe older runs.

## Pricing

Standard direct API USD per million tokens, checked September 5. These are not allocations of subscription fees or Codex credit charges.

| Token category | GPT-6 Astra | Claude Fable 5.1 |
| --- | ---: | ---: |
| Uncached input | $10 | $10 |
| Cached input read | $1 | $0.25 |
| Output | $50 | $50 |
| Cache write | $12.50 | $12.50 for 5 minutes; $20 for 1 hour |

Sources: [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-6-astra) and [Anthropic model pricing](https://platform.claude.com/docs/en/models/fable-5-1/overview). Cache lifetimes and billing rules differ. Astra requests above 272K input tokens have higher rates for the whole request. Its cache-read rate is four times Fable's; their standard uncached input and output rates match. Actual task cost also depends on token volume, cache reuse, tools, and retries. Replacing Fable does not itself guarantee savings.

## Evidence and limits

[Shinsuke Kagawa's September 5 experiment](https://dev.to/shinpr/switching-from-gpt-56-sol-to-gpt-6-astra-start-with-medium-effort-25ao), published at 04:59 UTC, compared analysis, implementation, and independent reviews of the same Sol implementation in Galley. [Detailed evaluation](https://www.norsica.jp/resources/astra-effort-evaluation#usage-cost-and-time):

| Review condition | Author's API-equivalent estimate | Adjusted minutes |
| --- | ---: | ---: |
| Astra low | $3.338860 | 7.12 |
| Astra medium | $3.477854 | 7.82 |
| Astra high | $4.749544 | 9.78 |
| Sol high | $4.086939 | 10.28 |

High cost about 37% more than medium for review. Medium found a startup failure high missed; Sol found separate issues absent from Astra's reports. High produced the retained implementation, handling interactions among retries and persisted state better. This was one run per condition on one repository, with model-assisted, nonblind assessment. Costs exclude evaluation and later repairs. Sol medium was not tested. These findings support independent review and selective high effort, not a universal model ranking.

[Nori's September 5 experiment](https://zenn.dev/nnakapa/articles/lab-38-gpt6-astra-gpt56-sol-qcd) reports 240 runs across two models, four efforts, and three small Python/PostgreSQL implementation tasks. Astra passed the quality gate at every effort. Sol failed four trials at low/medium and none at high/xhigh. Higher Astra effort added cost without improving these tasks' gate results. These are small implementation tasks, not PR reviews. The author's cost figures are API equivalents; model identity is based on requested CLI IDs rather than server-reported identity. This evidence supports trying lower Astra effort on bounded work and retaining Sol high for demanding implementation; it does not establish Sol medium review recall.

[Matt Shumer's September 3 account](https://somethingbig.ai/astra-review) favors medium for everyday work and reports using Ultra for ambitious experiments. It also reports very large token consumption on those experiments. It is firsthand experience, not a controlled effort comparison. Its pre-release context and Ultra label must not be treated as proof that portable Astra API routes accept Ultra.

[Dominik Kundel's X article](https://x.com/dkundel/status/2095972046014673156), September 4 at 20:27 UTC, recommends trying low or medium before raising effort. His Blender examples favored Astra low over Sol max. He also recommends specifying what to verify and when to return the work. This is firsthand product experience, not a review-recall benchmark. The public article was retrieved through FxTwitter because direct X access returned 403.

[Chubby's X post](https://x.com/kimmonismus/status/2095993178423717964), September 4 at 21:51 UTC, claims Astra medium offers roughly Sol xhigh intelligence at one-third the cost. The public post was retrieved through FxTwitter. That claim is not a measured PR-review result and is not used as a savings forecast.

[Arena AI's September 3 video, around 23:10](https://www.youtube.com/watch?v=GQPi39sjNhU&t=1390s), compares effort levels on visual generations. The English timed captions describe useful low output, richer medium/high output, and less obvious gains above high. The creator does not know the exact cost difference. This is a qualitative demonstration of 3D/SVG work, not a correctness evaluation. The transcript was read; the rendered demonstrations were not independently scored. Highest-setting labels from this interface do not establish portable API support.

The research engine returned 38 items, including 12 videos with eight transcripts. Targeted full transcripts of [Claire Vo's demonstration](https://www.youtube.com/watch?v=AniiF8rOu9c) and [Nerd Snipe's discussion](https://www.youtube.com/watch?v=j2fG-zH6vgk) did not establish a usable medium/high comparison. They are not counted as support for reviewer settings. Reddit coverage was partial because of rate limits. These counts describe retrieval, not 38 independent endorsements.

[OpenAI's launch page](https://openai.com/index/gpt-6-astra/) includes Lovable's report that higher effort added build iterations and browser verification. This is a vendor-selected testimonial. [OpenAI's migration guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) generally advises preserving effective effort and calibrating excessive testing. Lowering defaults here is a deliberate cost experiment requested by the operator, not that guide's universal migration recommendation.

## Application to pstack

The [role registry](../plugins/pstack/skills/poteto-mode/references/provider-dispatch.md#role-registry) remains the source of truth. Ordinary fixes, explanations, candidate generation, judging, and review start at medium for Astra. Performance diagnosis, hillclimbing, and architecture retain high. The explicitly hardest role retains xhigh. Terra and Luna keep their existing specialized work.

Review panels contain Astra medium and Sol medium. Sol medium is a cost hypothesis awaiting local evaluation, not a result demonstrated by the Galley experiment. Architecture retains Sol high. No default uses max or Ultra. No automatic effort escalation or fixed reviewer count is introduced; panel length follows the configured list.

Evaluate medium versus high on a bounded sample of identical revisions and prompts. Preserve independent reports, confirm findings against code or reproductions, and distinguish unique findings from duplicates. Compare total review usage, false positives, and subsequent repair work. A failed or incomplete reviewer is not evidence that another model found a unique bug. Attribution and per-PR cost aggregation remain proposed follow-up work; this change does not implement them.
