# Match Day Interiors + Banner Studio + Tools — Integration Plan

## Research: real tifo / banner vocabulary (drives the placement modes)
Two tifo forms exist: a **single giant cloth** unfurled over a stand, and a **card mosaic** held by fans. Ultras banner types:
- **Blockfahne / Sektorfahne** — huge cloth panel laid over / passed over a whole section (a *surface* tifo).
- **Zaunfahne** — "fence flag" hung on the front barrier of the stand (a vertical hung banner).
- **Overhead banner** — hung under the roof / on structure via **ropes, pulleys and chrome eyelets**.
- **Stockfahne / Schwenkfahne** — waved pole flags.

→ Your four placement ideas ARE these real types: *on the stand* = Blockfahne, *3D hung by threads* = Zaunfahne/overhead, *cover stairs* = vertical strip, *cover gaps* = sector filler.

---

## Part A — Match Day interiors & atmosphere
1. **Goals** *(now)* — real goal frame (2 posts + crossbar) + net, both ends, at the goal lines (7.32 × 2.44 m).
2. **Pitch realism** *(now)* — full markings (penalty & goal boxes, penalty spots + arcs, corner arcs, centre), PBR turf with mowing stripes + subtle bump, so it reads as grass not a green card.
3. **Crowd phone-flash** — twinkling sparkle waves rippling through the stands.
4. **Night mood** — a darker "Night" default so beams + tifo pop.
5. **Approach roads** — streams of car headlights moving toward the car park.
6. **Softer beams** — hazier, less geometric volumetric cones.

## Part B — Banner Design Studio (the big new feature)
A **separate design surface from stand-painting** so the two never mix (your explicit concern).

**Data model:** a banner is its own object with its **own texture/raster** (painted independently). Seat paint stays the cell buffer; a banner is an *asset* — fully separate layers. Builds on the existing asset/banner system the simulator already renders.

**Studio UI (new editor mode "Banners"):**
- A rectangular **banner artboard** (not the seat grid) you paint on with the same tools (brush/fill/text/image/shapes).
- **Resize** (aspect + dimensions), trim/border, background.
- **Placement modes** (mapped to the real types above):
  - **Surface tifo (Blockfahne)** — lay flat over a chosen section of seats.
  - **Hung banner (Zaunfahne / overhead)** — vertical cloth on the front fence or hung under the roof (subtle cloth sag, "unseen threads").
  - **Stair cover** — vertical strip down an aisle.
  - **Gap filler** — panel covering empty space between stands.
- **Place/drag/resize gizmo** in the 3D Stadium view; multiple banners per design.

**Why separate:** banners are movable/resizable objects with their own art; seat paint is fixed to seats. Keeping them as distinct layers means editing one never disturbs the other.

## Part C — Drawing tools upgrade
- **Eyedropper** — pick a colour from the canvas → set active colour (tool-rail button + `I`/`Alt` shortcut). *(small, high value — early)*
- Tool polish: brush size/opacity presets, straight-line & rectangle/ellipse helpers.

---

## Sequencing (I follow: build → view on localhost → adjust)
1. **Now:** Part A goals + pitch realism (implement + verify live).
2. **Next:** eyedropper (quick win) → then remaining atmosphere (crowd flash, night, roads, beams).
3. **Dedicated build:** Part B **Banner Studio** — it's a full feature (new mode + banner asset type + placement gizmos), phased: (F1) banner artboard + paint, (F2) asset model + render in Stadium/Match Day, (F3) the four placement modes + gizmo, (F4) polish.

## Sources
- [Tifo — Wikipedia](https://en.wikipedia.org/wiki/Tifo) · [Premier League — what is a tifo](https://www.premierleague.com/en/news/4379929/explained-what-is-a-tifo-banner) · [Sofascore — tifo culture](https://www.sofascore.com/news/tifo-culture-the-art-of-football-fan-displays) · [Ultraspoint — custom stadium banners](https://www.ultraspoint.com/en/personalized-stadium-banner/) · [ultras1312 — sector flags](https://ultras1312.com/Calc/Printed_Sector_flag.html)
