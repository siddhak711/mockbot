# Mochi — final sprite spec

Hand-built SVG, viewBox 64×64. Files: `svg/mochi-<state>-<light|dark>.svg` (animated) and `.static.svg`; `png/…@1x.png` (64px), `@2x.png` (128px), transparent.
Use sizes 16 / 24 / 32 / 64 / 128 (scale the SVG; no per-size redraw needed). 16px: bulb color + silhouette carry the state; face is secondary.

## Colors

| token                                                                                                          | light (on #F6F6F6) | dark (on #14120B) |
| -------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------- |
| body                                                                                                           | #BDB5AA            | #D6CFC4           |
| shade/feet/stem                                                                                                | #A39B8F            | #BDB5AA           |
| outline (1.8)                                                                                                  | #7A7267            | #F2EEE8           |
| face                                                                                                           | #2B2721            | #2B2721           |
| blush                                                                                                          | #F4A08A @75%       | same              |
| Bulbs: idle #F54E00 @45% · thinking #F54E00 @90% · working #F54E00 100% + glow · done #1F8A65 · error #CF2D56. |

## States

| state    | meaning                | silhouette                        | face                        | bulb / extras                           |
| -------- | ---------------------- | --------------------------------- | --------------------------- | --------------------------------------- |
| idle     | ready, nothing running | upright                           | soft oval eyes, small smile | dim orange                              |
| thinking | reasoning / planning   | tilted −6°, antenna leans left    | eyes up-right, "o" mouth    | orange, pulsing glow; 3 rising dots     |
| working  | running tools          | squashed 4%                       | `> <` focused, flat mouth   | bright orange + glow; side motion lines |
| done     | turn finished OK       | hop up 3px, arms raised           | `^ ^` closed, open smile    | green bulb, green check badge, sparkle  |
| error    | tool/turn failed       | slumped 2px, antenna droops right | X eyes, frown               | red bulb, sweat drop                    |

## Animation (animated SVGs only; disabled under prefers-reduced-motion)

- thinking: glow pulse 1.2s ease-in-out infinite (opacity .15→.45, scale .8→1.15); dots blink 1.2s, staggered 0/.2/.4s.
- working: motion lines 0.6s alternate (1px shift, opacity →.4).
- Suggested app transitions: state change crossfade 150ms; done holds 2s then → idle.

## Files

sheet.png (all states, 128px, light+dark) · readability.png / readability@3x-zoom.png (16/24/32px both themes) · in-context-light.png / in-context-dark.png (cursor-style mockup) · build.py / ctx.py regenerate everything.
