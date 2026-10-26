# Crown bots 3D: Crew (replaces Mochi)
A glossy 3D squircle bot (clearcoat, soft key light from the top left, rim light, environment reflections, soft contact shadow). Two white tick eyes sit slightly raised on the face, and a metal gold crown with a ruby is tilted on top. Original model built in three.js. Bodies: violet = mockbot, blue, green, pink, teal.

States (25fps loops, quart-out easing ≈ cubic-bezier(.22,1,.36,1)):
idle 4s blink+bob+crown wobble · thinking 2s eyes up+crown tilt+dots · working 0.8s bounce+crown jiggle · done 1.6s squash/hop+sparkles · error 3.2s X eyes+droop+crown slipped.

Files: frames/<color>/<state>/NNN.png (256px, transparent) · anim/<color>-<state>.webp|.png(APNG, transparent) and -light/-dark.gif · static/<color>-<state>@1x|2x|3x.png (128 base) · spritesheets/<color>-<state>.png (128px strip) · sheet.png · readability.png (16/24/32/64) · in-context-light/dark.png.
For reduce-motion, use static/ (raster has no motion off switch).
Source: src/bot.js + src/index.html (three.js r170, MIT, in src/lib). Rebuild: `python3 -m http.server 8765 -d src &` then `python3 build.py && python3 ctx.py`.
Crown floats: seated contact height + gap (0.15, error 0.085) + hover per state. build.py asserts min crown-body gap >= 0.06 every frame.
Rest pose: the crown is exactly parallel to the head top and centered, at t=0 of every state and in all statics. Motion eases back to level at loop boundaries. build.py asserts the crown's rotation relative to the head is under 0.1° on rest frames.
