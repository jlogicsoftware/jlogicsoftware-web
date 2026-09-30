# How I Made BugEater 3x Faster (And That's Not the Point)

*Illustration: capybara element by upklyak — Magnific.com*

**TL;DR (for the "tell your network what your article is about" field):** A production page that
took 27 seconds to load, five embarrassingly simple bottlenecks found by reading logs instead of
guessing, real before/after numbers (8x–37x on the request path), and an honest admission that
cold start is still unsolved. The real story isn't the speedup — it's what changed about which
problems are even worth fixing once AI removes the routine-execution cost, and what 20+ years of
engineering judgment still has to catch that AI gets wrong.

Quick spoiler so haters don't have to invent one: not everything got 3x faster. One part of the system — cold start, the time it takes the server to wake up from a dead stop — has achieved full zen and is exactly as slow as it ever was. A capybara. Not a bug, a feature.

But there's a nuance to why I even got into this, and it matters more than the numbers in the headline.

One request took **TWENTY-SEVEN SECONDS TO LOAD.** Not 27 milliseconds. Seconds. In production. We knew about it for six months and pretended not to — classic "it's fine, ship it."

Why? Because page speed doesn't move the "buy or don't buy" needle. Product beats milliseconds every time when you're a startup and everything is on fire, due "yesterday, ideally the day before."

Then users showed up. And suddenly: people don't just want it to work well — they want it fast too. Shocking, I know.

I've been programming since I was 6, for context — so "ignoring an obvious problem for six months" isn't a knowledge gap, it's a prioritization call any founder recognizes instantly.

Before, there were three ways to deal with this:
1. Sit down myself for 3 working days — days I'm not shipping features, just digging through logs. Embarrassing.
2. Hire a specialist for 3 thousand dollars **an hour** — get a nice PDF with charts and wave them goodbye.
3. Ignore it and hope 27 seconds is a feature, not a bug.

I picked option 3. For six months. Not proud, not sorry either.

Here's the real dividing line, and it's not "suddenly grabbed an AI, who knows, maybe it'll work." December 2025 — that's when the world actually changed: AI stopped being the thing that writes pretty text but wrecks everything in real work, and became something that actually helps instead of getting in the way. I saw this firsthand back then. So in August 2026 I wasn't guessing — I knew it was time to test whether it could handle a task I'd been letting rot in the backlog for half a year.

It could. And not just "completed the task" — it showed it can genuinely be a partner, not a subordinate you have to babysit through every single step. I didn't have to spell out every request, hover over every move, manually double-check the logic on every commit.

It went through the production logs itself, broke the problem down millisecond by millisecond, found the actual root cause, produced a plan — and implemented it itself. Code, migrations, configs.

And here's the second important part: I did not click "accept" blindly. I read every line. Every config. Every database migration. Twenty-plus years in this profession — including time as an architect and technical practice lead on large projects, where reviewing someone else's code wasn't an occasional ritual, it was a daily habit: understanding unfamiliar code and unfamiliar tradeoffs fast, without losing sight of the whole system. That's exactly the muscle that was doing the work here.

Because AI doesn't hand you one single correct answer — it usually puts three or four working options on the table at once, and all of them are technically valid. The difference between them isn't which one is "correct," it's which one bites you in six months: which one creates hidden coupling, which one hits a scaling wall sooner, which one quietly breaks an invariant the code itself doesn't even know exists. Seeing that difference and choosing between them has no shortcut and no prompt for it — it's exactly what years of pattern-recognition are for. So no, I'm not the guy with the "I don't care, ship it" button. I'm the human in the loop. That's exactly why something that could technically be deployed in 3 seconds took 3 days — because I'm the one who didn't let the bomb go off, not the one who closed his eyes and hoped for the best.

The fix itself: 3 days of review, not an evening of hitting Enter. And even that wasn't the end — between "code passed review" and "I can post the numbers" sat two more months of collecting real user data, comparing before/after, and recalculating everything, so I wouldn't become the guy posting a fake 100x from a dev-environment screenshot.

Real numbers (battle-tested, not from an investor deck):
— p50: 313 → 39 ms — 8x
— the most-visited page: 2445 → 65 ms — 37x
— p99: 4.7 seconds → 0.8 seconds
— cold start: still a capybara. Told you at the start.

## For anyone curious about the technical kitchen (everyone else can scroll past)

First, context, without which half these fixes will look bizarre. The whole system runs on **the smallest Cloud Run instance available** — 256 megabytes of memory, 1 virtual CPU core:

```sh
gcloud run deploy bugeater-api \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=200
```

Why such a tiny instance? Because there's no money. Not "optimizing costs, as best practice recommends" — literally no spare budget to grab a beefier instance and throw money at the problem. And we could have: horizontal scaling, a fatter instance, an extra replica — there's no shortage of "just add more capacity" options in the cloud, and any DevOps person would call that a legitimate path. But architecture experience made the call here too: I've spent years sizing systems for large companies against real load, and at this traffic level I already knew — from experience, not a guess — that a tiny instance would hold up before I ever tried to save money by shrinking it. With no budget, and the math saying the capacity was enough, the only lever left is not "more hardware" but "think harder so you don't have to pay." That pressure is what kicked off the entire bottleneck hunt — and it's also why the service lives in a "wake on request, do the job, shut down" mode: this is Java, compiled to a native binary, that doesn't keep an instance alive around the clock for two customers an hour, because there's simply nothing to pay for that with. Sounds logical, but it has a cost: the framework's defaults assume the opposite lifecycle — "start once, live forever." That's exactly where the defaults start working against you, and you end up filing down what came "out of the box" for a different kind of life.

The container, incidentally, is built with the same economizing instinct — a minimal base image purpose-built for native Quarkus binaries, no JVM, no extra layers:

```dockerfile
FROM quay.io/quarkus/ubi9-quarkus-micro-image@sha256:d4295e70be7c3df55523bcbcc0fd696d518484de2579d5d87546d422649a1296

WORKDIR /work/
COPY --chown=1001:root --chmod=0755 target/*-runner /work/application

EXPOSE 8080
USER 1001

ENTRYPOINT ["./application", "-Dquarkus.http.host=0.0.0.0"]
```

On an instance this small, with a 256-megabyte budget, every extra network call or every extra millisecond of startup isn't "eh, not pretty" — it's a hard physical ceiling you actually hit. That's where the rest of the list below comes from.

There turned out to be five bottlenecks. Each one sounds boring on its own, almost embarrassingly simple — which is exactly why things like this live in production for months unnoticed.

**1. Every course card on the page pulled its description from cloud storage as a separate HTTPS request.** And yes, I wrote it that way myself, and anyone in my position would have written it exactly the same way. One page, one data source, one method — "give me the course description" — simple, straightforward, readable.

> "Premature optimization is the root of all evil (or at least most of it) in programming."
> — Donald Knuth

At the start, when there was almost no traffic, this was the completely correct call. But here's the twist: I'd run a similar project before, and there the main pain point was cold start — so my first hypothesis walking into this audit was the exact same one: "fix the boot, that's the expensive part here too." The measurements killed that hypothesis on the spot. Cold start cost roughly a second and a half a day, spread across a handful of unlucky visitors who happened to hit a cold boot. The path of an ordinary request — the one every single visitor sees on every single page — was **two orders of magnitude worse** than in my previous project with a similar architecture. One cause explained the whole nightmare: the content-fetching method hit cloud storage with zero caching, and the course/module/practice list pages called it once per card — and once per row again whenever a search filter was active.

```java
// before: EVERY card in the grid = a separate trip to Storage
for (Course course : courses) {
    ContentExcerpt excerpt = contentService.loadExcerpt(
        "courses/" + course.id + "/content_en.md",
        course.title, course.shortDescription);
}
```

12 cards on a page — 12 cross-region requests, on every single visit. So the order of operations had to flip from what worked last time: not "fix boot first because that's what worked before," but "fix the request path first, because it costs seconds on every page view, not a second and a half spread across a handful of unlucky-cold-start visitors a day."

**2. Titles and descriptions lived only in markdown files, not in the database.** This was a deliberate architectural stance from day one: single source of truth, metadata in the database, content in storage, no duplication across two places. Good practice, by the book, held on purpose.

My hypothesis going into this specific fix was simple: "once the network call is gone, nothing else needs touching — in-memory markdown parsing is cheap, that's not the bottleneck." The numbers said otherwise. Even without the trip to Storage, pulling "the first two lines as a description" out of the full markdown text on every single grid render is a fresh parse on every render, just to extract two fields that hadn't changed in weeks. Reality showed a nuance textbooks usually skip: sometimes you deliberately break the right practice for performance, as long as you clearly understand and document where the duplication is coming from:

```sql
alter table courses    add column title text, add column short_description text;
alter table modules    add column title text, add column short_description text;
alter table practices  add column title text, add column short_description text;
alter table lessons    add column title text;
```

```java
// after: render straight from entity fields, zero Storage calls
for (Course course : courses) {
    render(course.title, course.shortDescription);
}
```

The result on the site's most-visited page, where both fixes stacked: 2445 milliseconds of average response time became 65. And the estimate I'd written down beforehand — "should land around 250 ms" — turned out too conservative; reality beat even my own optimistic plan.

**3. The database migration check ran on every single cold start.** By itself this is a normal, standard step — the framework needs to confirm the schema is current before letting traffic through. I measured specifically how much time this one check ate inside the whole boot cycle: 1.237 seconds out of 2.889 seconds of total startup — **43% of the entire load time** — and that's on dozens of boots a day, not once at deploy time.

```properties
# before — migrations checked on EVERY container start
quarkus.flyway.migrate-at-start=true
# after — disabled in prod, the check moved to a separate deploy step
%prod.quarkus.flyway.migrate-at-start=false
```

There was a real risk I had to think through explicitly here, not just switch off the check and hope for the best: removing it from boot also removes the guarantee that the database schema actually matches the code about to receive traffic. The fix wasn't to remove the safety check — it was to move it to a separate step that runs once at deploy time, before the new version starts serving anyone, and if that check fails, the deploy stops before it ever reaches the live service. Same guarantee, just paid for once per deploy instead of dozens of times a day on the backs of random visitors.

**4. The application server and the database sat in different regions** — literally different continents. Early in the project the region was picked on a single criterion — whichever was cheaper — and that was reasonable when there was almost no traffic. The first time I ran the math on moving, the catalog-price estimate came back tiny — under a dollar a month in savings — and I deliberately deferred the move: "not worth the risk for pocket change, I'll revisit once there's something else to compare it against." The hypothesis was: "the money upside is negligible, and the latency upside isn't obviously real either, since the other fixes already captured most of the win."

Instead of guessing further, I spun up two disposable cloud jobs — one in each candidate region — and had both open a real connection to the live production database, measuring actual connection time instead of theoretical "how close on the map." The difference turned out bigger than the first estimate suggested: a fresh connection was roughly 12% faster from one region, and a repeated connection was nearly twice as fast. Both jobs were deleted right after the measurement.

```sh
# before
REGION="${REGION:-europe-central2}"
# after, following the real-traffic latency measurement
REGION="${REGION:-europe-west1}"
```

After the move, the most-visited page got faster a second time — from an already-improved 85 milliseconds down to 65, and the gap between the worst-case requests and the typical ones shrank by a large margin. Numbers don't lie, gut feelings do — and this time "probably not worth it" turned out to be a wrong first impression that was worth checking with a real experiment instead of trusting a price sheet.

**5. Here's the honest part — I didn't speed everything up, I deliberately slowed one thing down.** It used to be `min-instances=1, max-instances=3` — one instance always warm and live, cold start barely visible to a normal user. I dropped it to `min-instances=0, max-instances=1`:

```sh
# before — at least one live instance always running, users barely felt cold start
gcloud run deploy bugeater-api \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=1 \
  --max-instances=3 \
  --concurrency=200

# after — deliberately zero live instances while idle
gcloud run deploy bugeater-api \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=200
```

Yes, I actually **increased** first-load time for some users. On purpose. Because optimization isn't one dial you crank to "faster at any cost" — it's a tradeoff across several axes at once, and money is one of those axes, and for a startup on a shoestring budget it might be the hardest one. Keeping an instance alive around the clock just to erase cold start is real money every single month, and I don't have spare money. So I deliberately chose: let some users wait an extra second or two on a cold start now and then, and keep the infrastructure bill from growing just because a server is bored sitting idle.

That's exactly why the capybara — that unkillable cold start I warned you about at the top — currently lives in the backlog, not because I gave up, but because I consciously postponed that fight. I believe cold start can still be tuned and sped up — but right now there are more urgent things, and not every bottleneck needs fixing the same day you find it. Let it sit for now.

**And immediately after — the opposite decision, from the same brain.** Having accepted a longer cold start to save money, you'd expect me to keep cutting corners everywhere by default. Not so: CPU boost stays on — Cloud Run temporarily doubles the allocated processor (from 1 to 2 vCPU) during container startup, and that is **not free**. It's not even just billing for the boot itself — per the platform's own documentation, it also bills **10 seconds AFTER the container has already finished starting**. Meaning most of the bill isn't the boot, it's the tail after it.

Here, a reflex built from years of code review and technical-lead work kicked in: when several axes are on the table at once — money, speed, risk — the obvious answer is usually wrong. So instead of "turn off everything unnecessary by default," I sat down and calculated it:

```
With boost:     2 vCPU × (2.889s boot + 10s tail) = 25.8 vCPU-seconds per cold start
Without boost:  1 vCPU × (~5s boot + 10s tail)     = 15 vCPU-seconds per cold start

Difference over ~27 cold starts/day ≈ 8,700 vCPU-seconds/month ≈ $0.29/month at list price
```

$0.29 a month — and that was enough to leave the boost turned on. The same rule — "calculate, don't guess" — gave two opposite answers on two neighboring decisions, and both times the "obvious" instinct would have been wrong without the habit of running the numbers first.

Nothing brilliant here — five targeted fixes for five concrete bottlenecks, found by reading logs, not by gut feel. And this whole diagnostic process ran under its own set of rules: zero requests against production for the entire investigation, an honest refusal to keep chasing the cold-start mystery once it turned out to live in someone else's infrastructure rather than my code, and a real experiment instead of "sounds logical" when picking the region — two disposable cloud jobs with a real database connection instead of guessing.

Here's what actually changed — and it isn't about milliseconds. The threshold changed: which problems are even worth picking up when "fix this" used to cost 3 days or 3 thousand dollars an hour, and now costs 3 days of careful review with AI plus two months of patience to avoid lying to yourself in the report.

## Conclusion

Short version — here's what to take away if you made it through the technical section:

— **Numbers beat feelings.** "It's not that far away" about the region, "probably pocket change" about the CPU boost, "probably slow because of cold start" about the whole audit — all three gut feelings turned out to be imprecise or flat-out wrong. A checked calculation beat intuition every single time: p50 313 → 39 ms, the most-visited page 2445 → 65 ms, p99 4.7 → 0.8 seconds — these aren't eyeballed guesses, they're what's left after feelings got checked against numbers.

— **But experience and intuition didn't disappear — their job just shifted.** Intuition wasn't the decision-maker here — it pointed at *where* to run the math and *what not to trust on first glance*: that the fix order that worked on a past project might be wrong here; that when several axes are on the table at once — money, speed, risk — the obvious answer usually lies. Experience doesn't replace the calculation, it tells you where a calculation is even needed.

— **None of this happens without 20+ years in the profession and a master's degree in engineering** — sounds like a formality on paper, but in practice it's exactly the foundation without which you can't size a system against real traffic, and can't recognize when AI hands you a technically working but architecturally wrong option out of the three or four it offers.

— **AI took the routine work off my plate entirely** — writing code, running migrations, assembling configs — and does it faster, and more attentive to detail, than I would have managed myself on a weeknight after a full day of work.

— **But it can't and shouldn't do the thinking for me.** Choosing between alternatives with an eye on what happens six months from now, seeing the whole system instead of patch after patch — that part of the job hasn't gone anywhere, it just got freed from the busywork around it.

So no, this isn't a post about how anyone off the street can now build something big and functional from scratch just because they have access to AI. Fundamental knowledge matters exactly as much as it did 20 years ago — it's just that what used to take days of manual, routine work to apply is gone now, and what's left is precisely what that knowledge was built for in the first place. AI isn't a toy for funny pictures anymore, and it isn't a consultant handing out generalities either. It's a genuine working tool — but a tool is still a tool, not a replacement for whoever's operating it.
