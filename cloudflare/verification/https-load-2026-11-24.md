# Worker HTTPS load verification

On 24 November 2026 the stable QA Worker accepted all 395 measured HTTPS requests on deployment `36644f39`. Each round used one fresh synthetic trial account and four devices on the separate QA database. The test issued account-summary reads, public community reads and device uploads in a 45:35:20 target mix, followed by ten simultaneous uploads from the same device. It sent zero payment requests.

| Scenario | Requests | Duration | Measured requests/s | Latency p50 / p95 / p99 | HTTP 200 |
| --- | ---: | ---: | ---: | --- | ---: |
| 3.5 requests/s target | 105 | 30.24 s | 3.47 | 549 / 1,030 / 1,145 ms | 105 |
| 14 requests/s target | 280 | 20.43 s | 13.70 | 544 / 761 / 1,300 ms | 280 |
| Same device, ten simultaneous uploads | 10 | 1.16 s | 8.62 | 631 / 1,159 / 1,159 ms | 10 |

The 3.5 requests/s reference comes from the estimated nine million monthly calls divided by 30 days. The fourfold test generated a peak of 13 concurrent requests. A single client measured elapsed time through the SJC Cloudflare point of presence. These are short, end-to-end synthetic scenarios on a small database. Production traffic peaks, worldwide client latency, sustained saturation and queries against the complete archive require separate measurements.

Before the device-admission fix, one upload in the 14 requests/s run and six of the ten simultaneous uploads returned HTTP 503 with application error `cloud_access_unavailable`. Device heartbeats and exact batch counts invalidated unrelated writes in the same upload window. The corrected transaction guards retain identity, membership, active slot, upload window, token identity and batch quota. A counter increment no longer invalidates other continuations before the quota boundary. A separate workerd test issued twelve parallel continuations with only nine slots remaining: nine succeeded and the other three received the product's HTTP 429 as configured.

After the fix, 86 accepted uploads produced 86 distinct buckets on four devices. An independent D1 query checked every bucket's device, input, billable and total tokens, and conversation count. The authenticated summary gained 89,741 tokens and 86 conversations. Replaying one successful upload left every summary total unchanged. Both mixed scenarios and the burst returned zero HTTP 429 and zero HTTP 5xx. [Raw timings, response codes and acceptance results](https-load-2026-11-24.json)
