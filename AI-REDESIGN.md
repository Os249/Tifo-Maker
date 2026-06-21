# TifoMaker — AI Tifo Designer Redesign

Status: **Phase 1 complete (AI admin-locked). Phases 2–5 are design-only.**
Goal: the best AI-powered stadium-choreography designer in the world — not an incremental patch.

---

## 1. Current weaknesses

The current AI is `promptDesigner.ts` (keyword/regex matching) → `TifoSpec` → `specCompiler.ts`.

| Symptom | Root cause |
|---|---|
| Weak creativity, generic/repetitive | Default generator is deterministic keyword matching, not a model. It always composes one template: *background + one symbol + one headline*. |
| Weak English nuance | Regex lexicons (colours, stands, ~10 players, slogans). No semantic understanding. |
| Poor/zero Arabic | Lexicons are English-only; Arabic prompts fall through to the default template. |
| Limited vocabulary | `TifoSpec` expresses only `fill / stripes / text / symbol`, ~22 vector symbols, 5 fonts. |
| Poor portraits | The compiler renders **single-colour masks** + flat fills. No multi-tone/halftone path → a face cannot be rendered. |
| Poor complex requests | The designer emits one fixed template; it cannot decompose multi-subject, multi-stand scenes. |

**Is `TifoSpec` sufficient?** As a *validated, legible, compileable contract* — yes, keep it as the rendering target. As an *expressive design language* — no; it must become a scene graph with image layers.

**Rendering constraints reducing creativity:** text/symbols → 1-colour alpha masks; backgrounds → flat fills/stripes; no gradients, no image layers, no multi-tone quantization (even though `quantizePixels()` — used by Image Import — already maps any picture to seats).

---

## 2. Next-generation architecture

Model-first, multi-stage pipeline. The LLM is the **choreography director**; the existing engine stays the **renderer**.

```
prompt (EN / AR)
  ① UNDERSTAND  (LLM, bilingual) → BRIEF {subject, club identity, mood,
  │                                 focal points, stands, palette intent}
  ② PLAN        (LLM)            → TifoSpec v2 (scene graph)
  ③ ASSETS                       → portraits/art the vector lib can't do:
  │                                 image model → PNG → quantizePixels() → seats
  ④ COMPILE                      → reuse applyGridToSeats / quantizePixels /
  │                                 maskFromAlpha + new multi-tone & halftone renderers
  ⑤ CRITIQUE    (LLM)            → findFragileSeats() → auto-repair illegible detail
```

**Reuse (no duplicate rendering):** `quantizePixels` already turns any image into seats — portraits are a *wiring* task, not a new engine. `TifoSpec` stays the validated contract; the validate-before-deliver loop stays; `findFragileSeats` becomes the automated legibility critic.

---

## 3. Better design language — TifoSpec v2

From a flat layer list to a **scene graph**:

- **Regions** with real geometry: stand, tier, row-range, u-range, arbitrary rects/arcs.
- **Layer kinds:** `fill`, **`gradient`**, `stripes` (any angle/width), `text` (**multi-line, outline, per-line arc**, Arabic-aware — the renderer already shapes RTL/Arabic), `symbol`, **`image`** (`assetRef` → quantized → portraits/crests/art), **`pattern`** (checker/chevron/mosaic/flag), **`mask`/`clip`** for compositing.
- Multiple **focal points**, explicit **z-order**, **per-region palettes**, blend modes.
- **Portraits** via image assets + a **multi-tone quantizer** (not 1-colour masks).
- Still **validated + compileable** — that legibility guarantee is the moat; do not lose it.

---

## 4. Model strategy

| Requirement | Strongest options |
|---|---|
| English reasoning / design taste | Claude Opus-class, GPT-4o-class |
| Arabic | Gemini, GPT-4o strongest; Claude solid |
| Structured JSON / schema adherence | Claude & GPT (tool-use / JSON mode) very reliable |
| Portrait / artwork generation | image model required (Anthropic has none) |
| Cost / latency on simple prompts | Haiku / GPT-4o-mini / Gemini Flash |

**Recommendation — hybrid, provider-agnostic** (the `aiProvider.ts` seam already exists):
1. **Planning + bilingual understanding + structured output:** premium reasoning model (Claude or GPT-4o-class).
2. **Portrait/art assets:** an image model (GPT-image / Gemini image / SDXL) → fed through `quantizePixels`.
3. **Fast path** for simple prompts: a small cheap model; escalate to premium for complex scenes.

**Cost (rough, per generation):** planning ≈ 1–3K tokens ≈ **$0.01–0.06** premium / **<$0.005** mini; a portrait image ≈ **$0.02–0.08** → **~$0.02–0.15 per generation**. The per-account quota bounds spend when AI reopens.

---

## 5. Data flow (Phase 1, live today)

```
Editor AI panel
  ├─ locked?  GET /api/ai/quota → 403 {locked} → show password unlock
  ├─ unlock:  POST /api/ai/unlock {password} → {token}  (HMAC, 30d) → localStorage
  └─ generate: POST /api/ai/generate {prompt}  + header x-ai-unlock: <token>
        server: hasAiAccess = valid token OR ADMIN_USERNAMES user → else 403
        → model (if key) or offline designer → validateSpec → spec → client compiles
```

## 6. Security (Phase 1)

- Gate enforced **server-side** on `/api/ai/generate` and `/api/ai/quota`.
- Password lives **only** in `AI_ADMIN_PASSWORD` (env); browser holds an **HMAC-signed token**, never the password.
- Constant-time password compare; tokens expire in 30 days; changing the password invalidates all tokens (it is the signing key).
- Private designs / locked state return `403` with no metadata leak.

---

## 7. Files

**Phase 1 — modified:** `server/src/aiRoutes.ts` (admin gate + `/api/ai/unlock` + HMAC token), `server/src/routes.ts` (pass `isAdmin` + `adminPassword`), `.env.example` (`AI_ADMIN_PASSWORD` + instructions), `src/net/api.ts` (unlock token, headers, `unlockAi`), `src/ui/aiPanel.ts` (locked UI + unlock flow). **New files:** none (reused existing modules).

**Phases 2–5 — anticipated new files:** `src/core/tifoSpec.v2.ts` (scene-graph schema + validator), `src/core/specCompilerV2.ts` (gradient/image/pattern/multi-line text renderers + multi-tone portrait quantizer), `server/src/aiPlanner.ts` (BRIEF → spec, bilingual), `server/src/imageAssets.ts` (image-gen → asset store). **Modified:** `aiProvider.ts` (bilingual system prompt, hybrid routing), `aiRoutes.ts` (re-open with quota), `aiPanel.ts` (richer UX).

---

## 8. Roadmap

1. **Admin lock — ✅ done.**
2. **Prompt interpretation:** wire a real model; bilingual (EN/AR) BRIEF stage; richer designer system prompt.
3. **TifoSpec v2:** scene graph + image/gradient/pattern/multi-line-text layers; compiler extensions (reuse `quantizePixels`).
4. **Advanced composition:** multi-region scenes, focal points, critique/repair loop.
5. **Portrait-quality art:** image-gen → multi-tone/halftone quantizer → seats.

## 9. Long-term / future

Club-identity library (crests, kits, palettes per club); per-stand choreography sequences (timed card stunts); a "style" system (ultras / minimalist / mosaic); fine-tune or few-shot a model on real tifo references; community-driven asset library; A/B critique using real match-day photos.

**Recommended provider:** hybrid — premium reasoning LLM (Claude/GPT-4o-class) for planning + an image model for portraits + a small fast model for simple prompts, all behind the provider-agnostic interface.
