"""Write the synthetic sample answers the template's two hive slides show.

    python template/data/make_samples.py

The template's open-question slides (`sl-poll-hive`, `sl-poll-matrix`) show a
finished example while their question is still the placeholder, so the
template opens as a showcase instead of "0 answers". These answers are
INVENTED: 60 short lines to a neutral question, six themes of ten. Nothing
here comes from a real audience; keep it that way.

Output, next to this script:
  sample-cluster.json  {question, answers:[{id,text}], cluster:{cells:{id:[q,r,theme,sim]},
                        labels:{theme:label}, threshold, labelsBy}} -- the poll service's
                        /api/cluster shape, cells on an axial hex grid
  sample-matrix.json   {question, answers:[{id,text}], scores:{id:{s:[x,y],e:[ex,ey]}}} --
                        ratings -3..+3 on the template's axes (Automation..Augmentation,
                        Use..Build), e = a 2-D embedding projection that orders ties
Deterministic (fixed seed): re-running gives the same files.
"""
import json
import math
import pathlib
import random

HERE = pathlib.Path(__file__).resolve().parent
QUESTION = "What would you most like AI to help you with this year?"

# theme label, (x, y) centre of its ratings on the matrix axes, answers
THEMES = [
    ("Write and edit faster", (2, -2), [
        "Draft emails faster", "Rewrite my reports so they read better", "First drafts of blog posts",
        "Proofread before I hit send", "Turn meeting notes into a summary", "Shorten long documents",
        "Translate messages for colleagues abroad", "Help me write clearer instructions",
        "Polish slides before a presentation", "Find the right tone for a difficult email"]),
    ("Automate routine tasks", (-3, 0), [
        "Automate the weekly status report", "Sort my inbox automatically", "Fill in forms for me",
        "Rename and file documents", "Copy data between spreadsheets", "Send reminders without me",
        "Process invoices", "Schedule meetings across time zones", "Clean up messy data exports",
        "Answer the same questions people always ask"]),
    ("Analyse data and reports", (2, 0), [
        "Spot trends in our sales numbers", "Explain a spreadsheet I did not build",
        "Make charts from raw data", "Compare two long reports", "Find the outliers in survey results",
        "Summarise customer feedback", "Check my numbers before a meeting",
        "Ask questions of a dataset in plain words", "Read financial statements faster",
        "Forecast next quarter roughly"]),
    ("Build small tools and apps", (0, 3), [
        "Build a small app for my team", "Make a website without learning to code",
        "Write scripts that save me an hour a week", "Prototype an idea over a weekend",
        "Connect two tools that do not talk to each other", "Build a chatbot for our documents",
        "Make a dashboard that updates itself", "Turn a spreadsheet into a simple app",
        "Learn enough code to fix things myself", "Build an agent that runs a task end to end"]),
    ("Learn new topics quickly", (3, -1), [
        "Learn a new subject in a week", "Explain research papers simply", "Quiz me before an exam",
        "Prepare for a job interview", "Practise a new language", "Get up to speed on a new industry",
        "Explain concepts at my level", "Recommend what to read next", "Turn a textbook chapter into flashcards",
        "Coach me through a hard problem"]),
    ("Plan and organise work", (-1, -2), [
        "Plan my week", "Break a big project into steps", "Keep track of my to-do list",
        "Prepare an agenda for meetings", "Prioritise what matters today", "Plan a trip with a group",
        "Remember what was decided and by whom", "Organise my notes", "Plan events without the back and forth",
        "Draft a project timeline"]),
]

# where each theme sits on the honeycomb (axial q, r): six islands around the middle
CENTRES = [(-6, -2), (1, -5), (6, -3), (-5, 4), (1, 3), (7, 2)]


def spiral(q0: int, r0: int):
    """Axial hex cells in rings around (q0, r0)."""
    yield (q0, r0)
    dirs = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
    k = 1
    while True:
        q, r = q0 - k, r0 + k
        for dq, dr in dirs:
            for _ in range(k):
                yield (q, r)
                q, r = q + dq, r + dr
        k += 1


def main() -> None:
    rnd = random.Random(20261104)
    answers, cells, scores, taken = [], {}, {}, set()
    labels = {}
    n = 0
    for t, (label, (sx, sy), texts) in enumerate(THEMES):
        labels[str(t)] = label
        cells_iter = spiral(*CENTRES[t])
        for text in texts:
            aid = f"s{n:02d}"
            n += 1
            answers.append({"id": aid, "text": text})
            cell = next(c for c in cells_iter if c not in taken)
            taken.add(cell)
            cells[aid] = [cell[0], cell[1], t, round(0.55 + rnd.random() * 0.35, 3)]
            clamp = lambda v: max(-3, min(3, v))
            s = [clamp(sx + rnd.choice((-1, 0, 0, 1))), clamp(sy + rnd.choice((-1, 0, 0, 1)))]
            if rnd.random() < 0.05:
                s = [None, None]   # the service's "no stance"
            a = rnd.random() * math.tau
            scores[aid] = {"s": s, "e": [round(math.cos(a) * rnd.random() * 2, 3),
                                         round(math.sin(a) * rnd.random() * 2, 3)]}
    order = list(range(len(answers)))
    rnd.shuffle(order)   # answers arrive mixed, not theme by theme
    answers = [answers[i] for i in order]
    cluster = {"cells": cells, "labels": labels, "threshold": 0.5, "labelsBy": "llm"}
    dump = lambda o: json.dumps(o, ensure_ascii=False, indent=1) + "\n"
    (HERE / "sample-cluster.json").write_text(dump({"question": QUESTION, "answers": answers, "cluster": cluster}),
                                              encoding="utf-8")
    (HERE / "sample-matrix.json").write_text(dump({"question": QUESTION, "answers": answers, "scores": scores}),
                                             encoding="utf-8")
    print(f"wrote sample-cluster.json, sample-matrix.json: {len(answers)} invented answers, {len(THEMES)} themes")


if __name__ == "__main__":
    main()
