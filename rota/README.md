# Safety Duty Rota

A single-page tool for sharing the safety duties out across the team — Safety KPI,
internal walkthroughs and weekend coverage — so nobody has to work out who is on
each week by hand.

## Running it

Open `index.html` in any browser. There is nothing to install, and it works with no
internet connection. Put the file on a shared drive and everyone can open the same copy.

## What it does

| Tab | What it covers |
| --- | --- |
| **Safety KPI** | Weeks × WPA / UCO / BOP / SM, split across SHP and DCU, filled to the weekly target |
| **Walkthrough** | Every Monday, two people per area |
| **Weekend** | Each Saturday, one person on cover |
| **By person** | Everything one person owes, week by week, ready to copy and send |
| **Team** | Who is on the team, who is away, and how evenly the load is shared |

The band at the top always shows who is on duty **this week**, whichever tab is open.

## Filling the rota

**Fill schedule** builds the whole thing. Every slot goes to whoever is carrying the
least work at that moment, so the load comes out even; ties are broken by who went
longest without a turn, then by roster order. The same team and settings always
produce the same rota — pressing the button twice does not shuffle everyone around.

Two rules are always enforced:

- Nobody covers both areas of the same task in the same week.
- Nobody does two walkthroughs on the same date.

Weekend cover is a strict rotation: nobody takes a second weekend until everybody
has taken a first.

## Changing an assignment

- **Safety KPI** — click a cell to move a name in or out.
- **Walkthrough / Weekend** — pick a different name from the dropdown.

An edited cell gets a small corner mark and is left alone by the next fill, which
works around it. **Clear edits** releases them again.

## Somebody is away

Untick **Available** on the Team tab. The next fill skips them. Duties already given
to them stay where they are, so you can see what needs handing over.

## Settings

Under **Schedule window & targets** on the Safety KPI tab:

- **Start week** — any date; it snaps back to that week's Monday.
- **Weeks** — how far ahead to plan.
- **Weekly target per task** — the SHP and DCU numbers per task. Tasks can be
  renamed, added or removed.

## Saving and sharing

The rota is saved in the browser you opened it in, so it is still there next time.
It is *not* shared between people automatically.

- **Export CSV** on each tab opens in Excel.
- **Print** gives a clean copy with the buttons stripped out.
- **Backup** on the Team tab shows the whole rota as text — copy it to keep it, or
  paste one in and load it to move the rota to another computer.
