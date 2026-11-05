---
title: Every figure in the kit
subject: infographics showcase
footer: infographics — the worked examples
media: media
---

<!-- The spec of a showcase deck: one slide per figure in this folder, and the
     reference for what an `## embed` block looks like and how `notes:` carries
     one line per state.

     Build it. The generated pages must NOT land in this folder, so they go to a
     scratch `build/` and the compiler is run from its parent — `page:` resolves
     against the cwd, `poster:` against this spec's own folder. From the checkout:

       R=$(pwd)                                  # the checkout ($TESSERA)
       W=<scratch>/wd; mkdir -p $W/build
       cp kit/figures/examples/*.html $W/
       python $R/tools/embed_font.py $W/*.html \
           --deck $R/template.html               # writes fig-<name>.html
       mv $W/../fig-*.html $W/build/             # embed_font writes to <src dir>/..
       cd $W && python $R/tools/md_to_deck.py \
           $R/kit/figures/examples/sample-deck.md \
           -o $W/sample-deck.html                # template: TESSERA_TEMPLATE

     Posters (into `media/`, which IS tracked): `shoot.py --page --clicks last
     --size 1280x500` for the seven titled figures, `--clicks 0 --size 1280x720`
     for the full-bleed timer.

     `page:` points at the font-inlined build, never at the source you edit.
     `timer.html` carries the same `url(MANROPE)` placeholder as the other
     figures, so embed_font builds fig-timer.html like any other — no
     special-casing needed.

     `shoot.py --only N` cannot reach a late slide in this deck: the stepped
     embeds swallow the arrow keys, so N indexes the figure's own states. Check
     a figure standalone with figcheck instead. -->

## embed
title: The hype cycle
page: build/fig-hype-cycle.html
poster: media/hype-cycle-poster.jpg
notes: Six clicks, no captions on screen. → (or the clicker, or a click in the frame) advances, ← steps back, Home restarts; the → after the last build moves to the next slide.
  1 — Trigger. A demo, a paper, a launch. No products, no proof, just a name people can repeat in a meeting.
  2 — Peak. Attention runs ahead of evidence: press, pilots, a strategy offsite. Nothing delivered, expectations never higher.
  3 — Trough. The pilots do not reach production. The technology did not get worse, the story did. Coverage turns, budgets get cut, the champions go quiet.
  4 — Slope. A second wave solves the unglamorous parts: data, integration, permissions, the workflow people actually have. No headlines here.
  5 — Plateau. Value settles well below the peak that was promised and far above the trough where everyone gave up.
  6 — The punchline. The trap is a timing error, not a judgement error: money gets committed at the peak, when the story is loudest, and the durable businesses get built in the quiet years.
  Worth asking the room where they think today's AI tooling sits, and what evidence they would accept for that answer.

## embed
title: How a market actually adopts
page: build/fig-adoption-curve.html
poster: media/adoption-curve-poster.jpg
notes: Eight clicks, one per segment. → builds the figure; the → after the last build moves to the next slide.
  1 — The bell curve. One product, one market, but the customers do not arrive together.
  2 — Innovators, 2.5%. They adopt because it is new, and forgive everything except being bored. Their yes is nearly worthless as evidence.
  3 — Early adopters, 13.5%. Visionaries buying an advantage. They tolerate rough edges and will co-build; they buy a story, not a reference.
  4 — The chasm. The early majority does not want what the early adopters wanted. They want references, integrations, support, someone else to have gone first. Most products die here, at their moment of apparent success.
  5 — Early majority, 34%. Pragmatists. The volume finally arrives, but what they buy is a different product: boring, integrated, supported.
  6 — Late majority, 34%. Conservatives adopting to avoid the cost of not adopting. Price and reliability, nothing else.
  7 — Laggards, 16%. They adopt when the old way stops being available.
  8 — The S-curve laid over the top. It looks like one smooth wave of momentum; it is five different customers who each had to be sold in a different way.
  Segment shares are Rogers' standard normal split (2.5 / 13.5 / 34 / 34 / 16); the chasm is Moore's addition.

## embed
title: The Amazon flywheel
page: build/fig-amazon-flywheel.html
poster: media/amazon-flywheel-poster.jpg
notes: Eight clicks around the loop. → builds the figure; the → after the last build moves to the next slide. On the last click the ring starts flowing.
  1 — Lower prices. The model starts with a decision, not a discovery: an improvement in cost is handed to the customer instead of kept as margin.
  2 — Better customer experience. Cheap, in stock, delivered when promised. Price is the part of the experience a competitor can see and the hardest to answer.
  3 — More traffic. A better experience brings people back and brings the people they tell. Traffic is the compounding asset, bought with price rather than advertising.
  4 — More sellers. That traffic is worth more to a third-party seller than to Amazon, so Amazon rents it out. The retailer becomes a platform.
  5 — Wider selection. Sellers bring inventory Amazon never buys and never risks, which improves the customer experience again: the customer half of the loop closes on its own.
  6 — Growth. What the loop produces is volume, not a fatter margin per unit: more units through the same warehouses, trucks and servers.
  7 — Lower cost structure. Volume spreads fixed costs and buys better terms upstream.
  8 — And that funds the next price cut. No single step is clever; each turn makes the next turn cheaper, which is why the loop is defensible when a low price on its own never is.
  Good place to ask which loop the room's own organisations are turning, and which step of it is broken.

## embed
title: Variation, selection, retention
page: build/fig-evolution.html
poster: media/evolution-poster.jpg
notes: Eight clicks — three turns of the same cycle. → builds the figure; the → after the last build moves to the next slide. The phase strip at the bottom lights up whichever step of the cycle is running.
  1 — One ancestor. A single form, and nothing to select between.
  2 — Variation. It throws off five variants that differ in colour and size: cheap, mostly wrong, and nobody knows yet which is which.
  3 — Selection. Three die. They stay on screen, greyed, because the failures are what the survivors were selected against.
  4 — Variation again. The two survivors become parents, and the variants they produce are variations on what already worked, not on the original.
  5 — Selection. The gold lineage's offspring both die: a form can survive one round and still be a dead end.
  6 — Variation, third round. Every variant on screen is now a shade of green. The variety has drained out without anyone deciding it should.
  7 — Selection. One design left standing.
  8 — Retention. Trace the line that was actually passed on: fifteen variants tried, one kept. The winner was not designed at the start; it was the only path that survived being wrong repeatedly.
  The point to press: the mechanism has no foresight. It looks like a strategy in hindsight only, and the cost of the process is the fourteen greyed-out balls -- which is exactly the cost an organisation tries to avoid paying, and why so few of them evolve.

## embed
title: What to hand over, and what to keep
page: build/fig-delegation-grid.html
poster: media/delegation-grid-poster.jpg
notes: Five clicks. Each card flies out of the corner where its own column and its own row meet, and the two headers that produced it light up as it lands — the motion is the argument, not decoration.
  1 — The empty grid. Two questions, not one: what you need from the task (the result, or the skill), and whether you could tell a bad answer from a good one.
  2 — Delegate. You need the result and a bad answer is obvious to you. Hand it over and skim.
  3 — Delegate, then verify. You still only need the result, but mistakes look exactly like facts. Demand sources and check every claim — the checking is the job.
  4 — Use AI as a coach. Doing it is how you learn, and you can see yourself improve. Let it quiz and critique you rather than produce for you.
  5 — Keep it. Doing it is how you learn, and you could not judge its version anyway. Do it yourself first.
  6 — The row is what really decides it. The two quadrants you cannot judge swell and the two you can recede: capability is the easy axis, judgement is the one that rules the decision.
  Built on `pose` + `dim` — the closing beat adds no fifth card, it re-reads the four already on screen.

## embed
title: What is actually in a call
page: build/fig-api-call.html
poster: media/api-call-poster.jpg
notes: Eight clicks, told in the order it actually happens: one sentence, and everything that sentence turns into. Everything on the left is on your own machine; only the model is remote, and the binary runs only on the hop that is really a hop.
  1 — One sentence, typed out in the middle of the screen. Nothing else exists yet.
  2 — It lands in Claude Code, which packs its own instructions, your tools and your CLAUDE.md — flown in off your disk — around it. All of that is local; nothing has been sent.
  3 — Now it is sent. The whole request crosses the internet, and the model is stateless: it only ever sees what arrives.
  4 — What comes back is not an answer. It is "read posting.md first".
  5 — So Claude Code opens a wire to your own disk and finds the file. No network here — this is your machine, which is also where it stops to ask you before it changes anything.
  6 — The request, bigger now by what it read, goes over again. All of it. That is the cost model.
  7 — This time the model sends back the letter, and Claude Code writes letter.md to your disk.
  8 — No tool call comes back, so the loop stops and it answers. The stillness is the point.
  The figure to reach for when someone asks why a long conversation gets slower and more expensive.

## embed
title: The perceptron
page: build/fig-perceptron.html
poster: media/perceptron-poster.jpg
notes: Not click-stepped — this one the room drives. Three sliders set the weights and the bias, and the input point is draggable; both feed one update() that redraws the boundary live.
  Drag the point across the line and watch the output flip: the whole of a perceptron is a weighted sum and a threshold.
  Move w1 and w2 to rotate the boundary, move b to slide it. Worth asking what shape of data this can never separate, which is the door to why depth exists.
  The reference for an `embed` figure built on real controls instead of a steps array.

## embed
page: build/fig-timer.html
poster: media/timer-poster.jpg
notes: A tool, not an argument — a countdown to run an exercise on stage. Full-bleed, so it has no title band.
  Space starts and pauses, ↑ and ↓ add or remove a minute, R resets; the chips set a preset. It scales itself to whatever frame it is given and chimes at zero.
  Set it before the room starts, not while they are waiting.
